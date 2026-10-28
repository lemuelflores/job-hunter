import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

import {
  ASSESSMENT_VERSION,
  type Assessment,
  AssessmentSchema,
  parseAssessment,
} from '../core/assessment.ts';
import {
  type DiscoveredListing,
  type Listing,
  REVIEW_STATUSES,
  type ReviewStatus,
} from '../core/listing.ts';
import { STAGES, type StageState, type StoredStage } from '../core/stages.ts';

function needsJobsMigration(schema: string): boolean {
  const eligibility = schema.match(/\beligibility\s+IN\s*\(([^)]+)\)/i)?.[1];
  const status = schema.match(/\bstatus\s+IN\s*\(([^)]+)\)/i)?.[1];
  return !eligibility?.includes("'error'") || !status?.includes("'stale'");
}

const ASSESSMENT_BACKFILL_CANDIDATES = `
  SELECT jobs.id, CASE
    WHEN crawl.state='terminal' THEN 'terminalCrawl'
    WHEN jobs.listing_text IS NULL OR length(trim(jobs.listing_text))=0 THEN 'missingText'
    WHEN crawl.state IS NOT 'complete' THEN 'crawlNotComplete'
    ELSE 'eligible' END AS category
  FROM jobs LEFT JOIN job_stages crawl ON crawl.job_id=jobs.id AND crawl.stage='crawl'
  WHERE jobs.status='active'
    AND NOT EXISTS (SELECT 1 FROM job_stages assessment WHERE assessment.job_id=jobs.id AND assessment.stage='assessment')
    AND NOT EXISTS (SELECT 1 FROM job_assessments WHERE job_assessments.job_id=jobs.id)`;

function validateBackfillLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Invalid backfill limit');
}

function postingDate(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !v.safeParse(v.pipe(v.string(), v.isoTimestamp()), value).success
  )
    return null;
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class SqliteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        query TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        eligibility TEXT NOT NULL DEFAULT 'pending'
          CHECK (eligibility IN ('pending','eligible','ineligible','unclear','error')),
        reason TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','rejected','stale')),
        reviewed_at TEXT,
        last_attempt TEXT,
        batch TEXT
      );
    `);
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .map((row) => row.name);
      for (const [name, definition] of Object.entries({
        // Retain legacy columns so existing indexes and historical values survive upgrades.
        attempts: 'INTEGER NOT NULL DEFAULT 0',
        next_retry_at: 'INTEGER NOT NULL DEFAULT 0',
        last_error: "TEXT NOT NULL DEFAULT ''",
        listing_text: 'TEXT',
        stack_status:
          "TEXT NOT NULL DEFAULT 'not_checked' CHECK (stack_status IN ('not_checked','pending','match','partial_match','potential_match','unclear','error'))",
        stack_reason: "TEXT NOT NULL DEFAULT ''",
        stack_evidence: "TEXT NOT NULL DEFAULT ''",
        source:
          "TEXT NOT NULL DEFAULT 'google' CHECK (source IN ('google','freehire'))",
        posted_at: 'TEXT',
      })) {
        if (!columns.includes(name))
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
      if (!columns.includes('source'))
        this.db.exec(
          "UPDATE jobs SET source='freehire' WHERE query='freehire'",
        );
      if (!columns.includes('posted_at')) this.backfillPostingDates();
      const table = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .get();
      if (!table) throw new Error('Jobs table is missing');
      const schema = String(table.sql);
      const needsMigration = needsJobsMigration(schema);
      if (needsMigration) {
        const objects = this.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name='jobs' AND type IN ('index','trigger') AND sql IS NOT NULL",
          )
          .all();
        this.db.exec(
          `CREATE TABLE jobs_with_error ${schema.slice(schema.indexOf('(')).replace("'pending','eligible','ineligible','unclear'", "'pending','eligible','ineligible','unclear','error'").replace("'active','hidden','rejected'", "'active','hidden','rejected','stale'")}`,
        );
        this.db.exec(
          'INSERT INTO jobs_with_error SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_with_error RENAME TO jobs',
        );
        for (const object of objects) this.db.exec(String(object.sql));
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS job_stages (
          job_id INTEGER NOT NULL REFERENCES jobs(id),
          stage TEXT NOT NULL CHECK(stage IN ('crawl','location','stack','assessment')),
          state TEXT NOT NULL CHECK(state IN ('pending','complete','failed','terminal','blocked')),
          error TEXT NOT NULL DEFAULT '',
          generation INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(job_id,stage)
        );
        INSERT OR IGNORE INTO job_stages(job_id,stage,state)
          SELECT id,'crawl',CASE WHEN listing_text IS NOT NULL THEN 'complete'
            WHEN eligibility='pending' OR (eligibility IN ('eligible','unclear') AND stack_status='pending') THEN 'pending'
            ELSE 'complete' END FROM jobs;
        INSERT OR IGNORE INTO job_stages(job_id,stage,state)
          SELECT id,'location',CASE WHEN eligibility='pending' THEN 'pending' ELSE 'complete' END FROM jobs
          WHERE NOT EXISTS (SELECT 1 FROM job_stages WHERE job_id=jobs.id AND stage='assessment');
        INSERT OR IGNORE INTO job_stages(job_id,stage,state)
          SELECT id,'stack',CASE WHEN stack_status='pending' AND eligibility IN ('pending','eligible','unclear')
            THEN 'pending' ELSE 'complete' END FROM jobs
          WHERE NOT EXISTS (SELECT 1 FROM job_stages WHERE job_id=jobs.id AND stage='assessment');
      `);
      if (
        !this.db
          .prepare('PRAGMA table_info(job_stages)')
          .all()
          .some((column) => column.name === 'generation')
      )
        this.db.exec(
          'ALTER TABLE job_stages ADD COLUMN generation INTEGER NOT NULL DEFAULT 0',
        );
      const stagesTable = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_stages'",
        )
        .get();
      if (!stagesTable) throw new Error('Stages table is missing');
      if (!String(stagesTable.sql).includes("'assessment'")) {
        const objects = this.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name='job_stages' AND type IN ('index','trigger') AND sql IS NOT NULL",
          )
          .all();
        this.db.exec(`CREATE TABLE job_stages_with_assessment (
          job_id INTEGER NOT NULL REFERENCES jobs(id),
          stage TEXT NOT NULL CHECK(stage IN ('crawl','location','stack','assessment')),
          state TEXT NOT NULL CHECK(state IN ('pending','complete','failed','terminal','blocked')),
          error TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(job_id,stage));
          INSERT INTO job_stages_with_assessment(job_id,stage,state,error,generation)
            SELECT job_id,stage,state,error,generation FROM job_stages;
          DROP TABLE job_stages;
          ALTER TABLE job_stages_with_assessment RENAME TO job_stages;`);
        for (const object of objects) this.db.exec(String(object.sql));
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS job_assessments (
        job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
        version INTEGER NOT NULL,
        report TEXT NOT NULL
      )`);
      this.db.exec('COMMIT');
      this.db.exec('PRAGMA foreign_keys = ON');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  private backfillPostingDates(): void {
    const rows = this.db
      .prepare(
        'SELECT id,listing_text FROM jobs WHERE listing_text IS NOT NULL',
      )
      .iterate();
    const update = this.db.prepare('UPDATE jobs SET posted_at=? WHERE id=?');
    for (const row of rows) {
      const metadata = String(row.listing_text).match(
        /^(Ashby|Greenhouse|Freehire) listing metadata:\n([\s\S]*?)\n\n/,
      );
      if (!metadata) continue;
      let saved: unknown;
      try {
        saved = JSON.parse(metadata[2]);
      } catch {
        continue;
      }
      if (!saved || typeof saved !== 'object') continue;
      const field =
        metadata[1] === 'Ashby'
          ? 'publishedAt'
          : metadata[1] === 'Greenhouse'
            ? 'first_published'
            : 'posted_at';
      const date = postingDate(Reflect.get(saved, field));
      if (date) update.run(date, row.id);
    }
  }

  saveResults(results: DiscoveredListing[]): number {
    const insert =
      this.db.prepare(`INSERT INTO jobs(url,title,snippet,query,source,first_seen,last_seen,posted_at,stack_status)
      VALUES (?,?,?,?,?,?,?,?,'pending') ON CONFLICT(url) DO UPDATE SET last_seen=excluded.last_seen,
      posted_at=COALESCE(jobs.posted_at,excluded.posted_at)`);
    let added = 0;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) {
        const url = result.url;
        const exists = this.db
          .prepare('SELECT id FROM jobs WHERE url=?')
          .get(url);
        insert.run(
          url,
          result.title.slice(0, 1000),
          (result.snippet ?? '').slice(0, 5000),
          result.query,
          result.source,
          now,
          now,
          postingDate(result.postedAt),
        );
        if (!exists) {
          const row = this.db
            .prepare('SELECT id FROM jobs WHERE url=?')
            .get(url);
          for (const stage of STAGES)
            this.db
              .prepare(
                "INSERT INTO job_stages(job_id,stage,state) VALUES (?,?,'pending')",
              )
              .run(Number(row?.id), stage);
          added++;
        }
        if (result.listingText !== undefined) {
          this.validateListingText(result.listingText);
          const row = this.db
            .prepare(`UPDATE jobs SET listing_text=?
            WHERE url=? AND status='active' AND listing_text IS NULL
            AND id IN (SELECT job_id FROM job_stages WHERE stage='crawl' AND state='pending') RETURNING id`)
            .get(result.listingText, url);
          if (row)
            this.db
              .prepare(
                "UPDATE job_stages SET state='complete',error='' WHERE job_id=? AND stage='crawl'",
              )
              .run(row.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return added;
  }

  getJob(id: number): Listing | undefined {
    return this.db
      .prepare('SELECT * FROM jobs WHERE id=?')
      .get(id) as unknown as Listing | undefined;
  }

  hasListingUrl(url: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM jobs WHERE url=?').get(url));
  }

  staleActiveListingUrl(url: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "UPDATE jobs SET status='stale' WHERE url=? AND status='active'",
        )
        .run(url).changes,
    );
  }

  deliveryListing(id: number): Pick<Listing, 'url' | 'status'> | undefined {
    return this.db.prepare('SELECT url,status FROM jobs WHERE id=?').get(id) as
      | Pick<Listing, 'url' | 'status'>
      | undefined;
  }

  stages(id: number): StageState[] {
    return this.db
      .prepare(
        'SELECT stage,state,error,generation FROM job_stages WHERE job_id=? ORDER BY stage',
      )
      .all(id) as unknown as StageState[];
  }

  unfinished(limit?: number): Pick<Listing, 'id' | 'url'>[] {
    return this.db
      .prepare(`SELECT id,url FROM jobs WHERE status='active' AND id IN
      (SELECT job_id FROM job_stages WHERE stage IN ('crawl','assessment') AND state IN ('pending','failed')) ORDER BY id LIMIT ?`)
      .all(limit ?? -1) as unknown as Pick<Listing, 'id' | 'url'>[];
  }

  needsStage(id: number, stage: StoredStage): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM jobs JOIN job_stages ON job_stages.job_id=jobs.id
        WHERE jobs.id=? AND jobs.status='active' AND job_stages.stage=?
        AND job_stages.state='pending' AND (?='crawl' OR jobs.listing_text IS NOT NULL)`)
        .get(id, stage, stage),
    );
  }

  failStage(
    id: number,
    stage: StoredStage,
    error: string,
    exhausted: boolean,
    generation: number | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE job_stages SET state=?,error=? WHERE job_id=? AND stage=? AND state='pending'
        AND (? IS NULL OR generation=?)`,
      )
      .run(
        exhausted ? 'failed' : 'pending',
        error.slice(0, 5000),
        id,
        stage,
        generation,
        generation,
      );
  }

  resetStage(id: number, stage: StoredStage): void {
    const changed = this.db
      .prepare(
        `UPDATE job_stages SET state='pending',error='',generation=generation+1 WHERE job_id=? AND stage=? AND state='failed'`,
      )
      .run(id, stage).changes;
    if (!changed) throw new Error('Stage is not failed');
  }

  private completeStage(
    id: number,
    stage: StoredStage,
    save: () => void,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE job_stages SET state='complete',error='' WHERE job_id=? AND stage=? AND state='pending'`,
        )
        .run(id, stage).changes;
      if (!changed) throw new Error('Stage is not pending');
      save();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  activateAssessment(id: number): boolean {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error('Invalid listing ID');
    return Boolean(
      this.db
        .prepare(`INSERT OR IGNORE INTO job_stages(job_id,stage,state)
      SELECT jobs.id,'assessment','pending' FROM jobs JOIN job_stages crawl
      ON crawl.job_id=jobs.id AND crawl.stage='crawl' AND crawl.state='complete'
      WHERE jobs.id=? AND jobs.status='active' AND jobs.listing_text IS NOT NULL
      AND length(trim(jobs.listing_text))>0`)
        .run(id).changes,
    );
  }

  previewAssessmentBackfill(
    limit: number,
    id?: number,
  ): {
    eligible: number;
    missingText: number;
    terminalCrawl: number;
    crawlNotComplete: number;
    selectedIds: number[];
  } {
    validateBackfillLimit(limit);
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 1))
      throw new Error('Invalid listing ID');
    const counts = {
      eligible: 0,
      missingText: 0,
      terminalCrawl: 0,
      crawlNotComplete: 0,
    };
    for (const row of this.db
      .prepare(`WITH candidates AS (${ASSESSMENT_BACKFILL_CANDIDATES})
      SELECT category,count(*) AS count FROM candidates WHERE (? IS NULL OR id=?) GROUP BY category`)
      .all(id ?? null, id ?? null)) {
      const category = row.category;
      if (
        category === 'eligible' ||
        category === 'missingText' ||
        category === 'terminalCrawl' ||
        category === 'crawlNotComplete'
      )
        counts[category] = Number(row.count);
    }
    const selectedIds = this.db
      .prepare(`WITH candidates AS (${ASSESSMENT_BACKFILL_CANDIDATES})
      SELECT id FROM candidates WHERE category='eligible' AND (? IS NULL OR id=?) ORDER BY id LIMIT ?`)
      .all(id ?? null, id ?? null, limit)
      .map((row) => Number(row.id));
    return { ...counts, selectedIds };
  }

  queueAssessmentBackfill(limit: number, id?: number): number[] {
    validateBackfillLimit(limit);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { selectedIds } = this.previewAssessmentBackfill(limit, id);
      if (id !== undefined && selectedIds.length === 0)
        throw new Error(
          `Listing ${id} is not eligible for assessment backfill`,
        );
      const insert = this.db.prepare(
        "INSERT INTO job_stages(job_id,stage,state) VALUES (?,'assessment','pending')",
      );
      for (const id of selectedIds) insert.run(id);
      this.db.exec('COMMIT');
      return selectedIds;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveAssessment(id: number, assessment: Assessment): void {
    const validated = v.safeParse(AssessmentSchema, assessment);
    if (!Number.isSafeInteger(id) || id < 1 || !validated.success)
      throw new Error('Invalid assessment');
    this.completeStage(id, 'assessment', () => {
      this.db
        .prepare(
          'INSERT INTO job_assessments(job_id,version,report) VALUES (?,?,?)',
        )
        .run(id, ASSESSMENT_VERSION, JSON.stringify(validated.output));
      const location = validated.output.location?.trim();
      if (location)
        this.db
          .prepare('UPDATE jobs SET location=? WHERE id=?')
          .run(location, id);
    });
  }

  getAssessment(
    id: number,
  ): { version: number; assessment: Assessment } | undefined {
    const row = this.db
      .prepare('SELECT version,report FROM job_assessments WHERE job_id=?')
      .get(id);
    if (!row) return undefined;
    if (row.version !== ASSESSMENT_VERSION || typeof row.report !== 'string')
      throw new Error('Unsupported saved assessment');
    return {
      version: ASSESSMENT_VERSION,
      assessment: parseAssessment(row.report),
    };
  }

  terminalCrawl(id: number, error: string): void {
    this.completeStage(id, 'crawl', () => {
      this.db
        .prepare(
          "UPDATE job_stages SET state='terminal',error=? WHERE job_id=? AND stage='crawl'",
        )
        .run(error.slice(0, 5000), id);
      this.db
        .prepare(
          "UPDATE job_stages SET state='blocked' WHERE job_id=? AND stage!='crawl' AND state IN ('pending','failed')",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE jobs SET eligibility='error',reason=? WHERE id=? AND eligibility='pending'",
        )
        .run(error.slice(0, 5000), id);
      this.db
        .prepare(
          "UPDATE jobs SET stack_status='not_checked' WHERE id=? AND stack_status='pending'",
        )
        .run(id);
    });
  }

  saveListingText(id: number, text: string, postedAt?: string | null): void {
    this.validateListingText(text);
    this.completeStage(id, 'crawl', () => {
      const result = this.db
        .prepare(`UPDATE jobs SET listing_text=?,posted_at=COALESCE(posted_at,?)
      WHERE id=? AND listing_text IS NULL`)
        .run(text, postingDate(postedAt), id);
      if (!result.changes) throw new Error('Listing already has text');
    });
  }

  private validateListingText(text: string): void {
    if (typeof text !== 'string' || !text.trim())
      throw new Error('Invalid listing text');
  }

  pendingCount(): number {
    return Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE status='active' AND id IN
      (SELECT job_id FROM job_stages WHERE stage IN ('crawl','assessment') AND state IN ('pending','failed'))`)
        .get()?.count,
    );
  }

  listReviewJobs(status: ReviewStatus) {
    return (
      this.db
        .prepare(`SELECT id,url,title,snippet,query,source,first_seen,last_seen,posted_at,
          eligibility,reason,evidence,company,location,status,reviewed_at,last_attempt,
          attempts,next_retry_at,last_error,stack_status,stack_reason,stack_evidence
          FROM jobs WHERE status=? ORDER BY id DESC`)
        .all(status) as unknown as Omit<Listing, 'listing_text' | 'batch'>[]
    ).map((row) => ({
      ...row,
      stages: this.stages(row.id),
      reviewKey: String(row.id),
    }));
  }

  setReviewStatus(key: string, status: ReviewStatus): boolean {
    if (!REVIEW_STATUSES.includes(status) || !/^[1-9]\d*$/.test(key))
      return false;
    return Boolean(
      this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, key)
        .changes,
    );
  }

  close(): void {
    this.db.close();
  }
}

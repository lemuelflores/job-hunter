import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import type { StackDecision } from './review/llm/types.js';
import { STAGES, type Stage } from './review/stages.js';

export const REVIEW_STATUSES = ['active', 'hidden', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const ReviewReasonSchema = v.pipe(
  v.string(),
  v.maxLength(5000),
  v.trim(),
  v.nonEmpty(),
);
const ReviewEvidenceSchema = v.pipe(v.string(), v.maxLength(5000));
const ReviewMetadataSchema = v.pipe(v.string(), v.maxLength(1000));
const LocationReviewSchema = v.object({
  eligibility: v.picklist(['eligible', 'ineligible', 'unclear', 'error']),
  reason: ReviewReasonSchema,
  evidence: ReviewEvidenceSchema,
  company: ReviewMetadataSchema,
  location: ReviewMetadataSchema,
  title: ReviewMetadataSchema,
});
const StackReviewSchema = v.object({
  status: v.picklist([
    'match',
    'partial_match',
    'potential_match',
    'unclear',
    'error',
  ]),
  reason: ReviewReasonSchema,
  evidence: ReviewEvidenceSchema,
});

export { STAGES, type Stage } from './review/stages.js';
export interface StageState {
  stage: Stage;
  state: 'pending' | 'complete' | 'failed' | 'terminal' | 'blocked';
  error: string;
  generation: number;
}

export type ListingSource = 'google' | 'freehire';

export interface DiscoveredListing {
  source: ListingSource;
  url: string;
  title: string;
  snippet?: string;
  query: string;
  listingText?: string;
}

export interface Listing {
  id: number;
  source: ListingSource;
  query: string;
  url: string;
  title: string;
  snippet: string;
  eligibility: 'pending' | 'eligible' | 'ineligible' | 'unclear' | 'error';
  reason: string;
  evidence: string;
  location: string;
  company: string;
  status: ReviewStatus;
  batch: string | null;
  attempts: number;
  next_retry_at: number;
  last_error: string;
  listing_text: string | null;
  stack_status:
    | 'not_checked'
    | 'pending'
    | 'match'
    | 'partial_match'
    | 'potential_match'
    | 'unclear'
    | 'error';
  stack_reason: string;
  stack_evidence: string;
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
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','rejected')),
        reviewed_at TEXT,
        last_attempt TEXT,
        batch TEXT
      );
    `);
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
      })) {
        if (!columns.includes(name))
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
      if (!columns.includes('source'))
        this.db.exec(
          "UPDATE jobs SET source='freehire' WHERE query='freehire'",
        );
      const table = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .get();
      if (!table) throw new Error('Jobs table is missing');
      const schema = String(table.sql);
      const eligibilityValues = schema.match(
        /\beligibility\s+IN\s*\(([^)]+)\)/i,
      )?.[1];
      if (!eligibilityValues?.includes("'error'")) {
        const objects = this.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE tbl_name='jobs' AND type IN ('index','trigger') AND sql IS NOT NULL",
          )
          .all();
        this.db.exec(
          `CREATE TABLE jobs_with_error ${schema.slice(schema.indexOf('(')).replace("'pending','eligible','ineligible','unclear'", "'pending','eligible','ineligible','unclear','error'")}`,
        );
        this.db.exec(
          'INSERT INTO jobs_with_error SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_with_error RENAME TO jobs',
        );
        for (const object of objects) this.db.exec(String(object.sql));
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS job_stages (
          job_id INTEGER NOT NULL REFERENCES jobs(id),
          stage TEXT NOT NULL CHECK(stage IN ('crawl','location','stack')),
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
          SELECT id,'location',CASE WHEN eligibility='pending' THEN 'pending' ELSE 'complete' END FROM jobs;
        INSERT OR IGNORE INTO job_stages(job_id,stage,state)
          SELECT id,'stack',CASE WHEN stack_status='pending' AND eligibility IN ('pending','eligible','unclear')
            THEN 'pending' ELSE 'complete' END FROM jobs;
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  saveResults(results: DiscoveredListing[]): number {
    const insert =
      this.db.prepare(`INSERT INTO jobs(url,title,snippet,query,source,first_seen,last_seen,stack_status)
      VALUES (?,?,?,?,?,?,?,'pending') ON CONFLICT(url) DO UPDATE SET last_seen=excluded.last_seen`);
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
      (SELECT job_id FROM job_stages WHERE state IN ('pending','failed')) ORDER BY id LIMIT ?`)
      .all(limit ?? -1) as unknown as Pick<Listing, 'id' | 'url'>[];
  }

  needsStage(id: number, stage: Stage): boolean {
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
    stage: Stage,
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

  resetStage(id: number, stage: Stage): void {
    const changed = this.db
      .prepare(
        `UPDATE job_stages SET state='pending',error='',generation=generation+1 WHERE job_id=? AND stage=? AND state='failed'`,
      )
      .run(id, stage).changes;
    if (!changed) throw new Error('Stage is not failed');
  }

  private completeStage(id: number, stage: Stage, save: () => void): void {
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

  review(
    id: number,
    eligibility: string,
    reason: string,
    evidence = '',
    company = '',
    location = '',
    title = '',
  ): void {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !v.safeParse(LocationReviewSchema, {
        eligibility,
        reason,
        evidence,
        company,
        location,
        title,
      }).success
    )
      throw new Error('Invalid review');
    this.completeStage(id, 'location', () => {
      const result = this.db
        .prepare(`UPDATE jobs SET eligibility=?, reason=?, evidence=?, company=?, location=?,
      title=CASE WHEN ?='' THEN title ELSE ? END, reviewed_at=?
      WHERE id=? AND eligibility='pending'`)
        .run(
          eligibility,
          reason,
          evidence,
          company,
          location,
          title,
          title,
          new Date().toISOString(),
          id,
        );
      if (!result.changes) throw new Error('Location is not pending');
    });
  }

  saveListingText(id: number, text: string): void {
    this.validateListingText(text);
    this.completeStage(id, 'crawl', () => {
      const result = this.db
        .prepare(`UPDATE jobs SET listing_text=?
      WHERE id=? AND listing_text IS NULL`)
        .run(text, id);
      if (!result.changes) throw new Error('Listing already has text');
    });
  }

  private validateListingText(text: string): void {
    if (typeof text !== 'string' || !text.trim())
      throw new Error('Invalid listing text');
  }

  reviewStack(
    id: number,
    decision:
      | StackDecision
      | { status: 'error'; reason: string; evidence: string },
  ): void {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !v.safeParse(StackReviewSchema, decision).success
    )
      throw new Error('Invalid stack review');
    this.completeStage(id, 'stack', () => {
      const result = this.db
        .prepare(`UPDATE jobs SET stack_status=?, stack_reason=?, stack_evidence=?,
      reviewed_at=?
      WHERE id=? AND stack_status='pending'`)
        .run(
          decision.status,
          decision.reason,
          decision.evidence,
          new Date().toISOString(),
          id,
        );
      if (!result.changes) throw new Error('Stack review is not pending');
    });
  }

  queueStackBackfill(): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(`UPDATE jobs SET stack_status='pending'
        WHERE status='active' AND eligibility IN ('eligible','unclear','ineligible') AND stack_status='not_checked'
        AND id NOT IN (SELECT job_id FROM job_stages WHERE stage='crawl' AND state='terminal') RETURNING id,listing_text`)
        .all();
      for (const row of rows) {
        this.db
          .prepare(
            "UPDATE job_stages SET state='pending',error='' WHERE job_id=? AND (stage='stack' OR (stage='crawl' AND ? IS NULL))",
          )
          .run(row.id, row.listing_text);
      }
      this.db.exec('COMMIT');
      return rows.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pendingCount(): number {
    return Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE status='active' AND id IN
      (SELECT job_id FROM job_stages WHERE state IN ('pending','failed'))`)
        .get()?.count,
    );
  }

  listReviewJobs(status: ReviewStatus) {
    return (
      this.db
        .prepare(`SELECT id,url,title,snippet,query,source,first_seen,last_seen,
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

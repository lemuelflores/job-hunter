import { DatabaseSync } from 'node:sqlite';
import type { StackDecision } from './llm/types.js';
import type { SearchResult } from './types.js';
import type { ReviewStatus } from './web-types.js';

const PENDING_REVIEW = `(eligibility='pending' OR
  (eligibility IN ('eligible','unclear') AND stack_status='pending'))`;

export interface Listing {
  id: number;
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

// Board homepages and application forms are not individual job listings.
export function jobUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    const valid = [
      'jobs.ashbyhq.com',
      'jobs.lever.co',
      'jobs.eu.lever.co',
    ].includes(url.hostname)
      ? parts.length === 2 && uuid.test(parts[1])
      : ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(
            url.hostname,
          )
        ? parts.length === 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2])
        : false;
    if (!valid || parts.some((part) => /[/\\]/.test(decodeURIComponent(part))))
      return null;
    parts[0] = encodeURIComponent(decodeURIComponent(parts[0]));
    url.search = '';
    url.hash = '';
    if (url.hostname === 'boards.greenhouse.io')
      url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${parts.join('/')}`;
    return url.href;
  } catch {
    return null;
  }
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
        attempts: 'INTEGER NOT NULL DEFAULT 0',
        next_retry_at: 'INTEGER NOT NULL DEFAULT 0',
        last_error: "TEXT NOT NULL DEFAULT ''",
        listing_text: 'TEXT',
        stack_status:
          "TEXT NOT NULL DEFAULT 'not_checked' CHECK (stack_status IN ('not_checked','pending','match','partial_match','potential_match','unclear','error'))",
        stack_reason: "TEXT NOT NULL DEFAULT ''",
        stack_evidence: "TEXT NOT NULL DEFAULT ''",
      })) {
        if (!columns.includes(name))
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
      }
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  saveResults(results: SearchResult[]): number {
    const insert =
      this.db.prepare(`INSERT INTO jobs(url,title,snippet,query,first_seen,last_seen,stack_status)
      VALUES (?,?,?,?,?,?,'pending') ON CONFLICT(url) DO UPDATE SET last_seen=excluded.last_seen`);
    let added = 0;
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) {
        const url = jobUrl(result.url);
        if (!url) continue;
        const exists = this.db
          .prepare('SELECT id FROM jobs WHERE url=?')
          .get(url);
        insert.run(
          url,
          result.title.slice(0, 1000),
          (result.snippet ?? '').slice(0, 5000),
          result.query,
          now,
          now,
        );
        if (!exists) added++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return added;
  }

  claimBatch(
    batch: string,
    limit?: number,
    readyOnly = false,
    now = Date.now(),
  ): Listing[] {
    this.db
      .prepare(`UPDATE jobs SET batch=?, last_attempt=? WHERE id IN (
      SELECT id FROM jobs WHERE ${PENDING_REVIEW} AND status='active'
      AND (?=0 OR (attempts<5 AND next_retry_at<=?))
      ORDER BY last_attempt IS NOT NULL, last_attempt, id LIMIT ?)`)
      .run(
        batch,
        new Date(now).toISOString(),
        Number(readyOnly),
        now,
        limit ?? -1,
      );
    return this.db
      .prepare('SELECT * FROM jobs WHERE batch=? ORDER BY id')
      .all(batch) as unknown as Listing[];
  }

  finishBatch(batch: string): void {
    this.db.prepare('UPDATE jobs SET batch=NULL WHERE batch=?').run(batch);
  }

  failReview(
    id: number,
    batch: string,
    error: string,
    now = Date.now(),
  ): number {
    const row = this.db
      .prepare(`UPDATE jobs SET attempts=attempts+1,
      next_retry_at=? + min(3600000, 60000 * (1 << attempts)), last_error=?
      WHERE id=? AND batch=? AND ${PENDING_REVIEW} RETURNING attempts`)
      .get(now, error.slice(0, 5000), id, batch);
    if (!row) throw new Error('Job is not pending in this batch');
    return Number(row.attempts);
  }

  pendingJobs(batch: string): Listing[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE batch=? AND ${PENDING_REVIEW} ORDER BY id`,
      )
      .all(batch) as unknown as Listing[];
  }

  review(
    id: number,
    batch: string,
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
      !/^[a-f0-9]{32}$/.test(batch) ||
      !['eligible', 'ineligible', 'unclear', 'error'].includes(eligibility) ||
      !reason.trim() ||
      reason.length > 5000 ||
      evidence.length > 5000 ||
      [company, location, title].some((value) => value.length > 1000)
    )
      throw new Error('Invalid review');
    const result = this.db
      .prepare(`UPDATE jobs SET eligibility=?, reason=?, evidence=?, company=?, location=?,
      title=CASE WHEN ?='' THEN title ELSE ? END, reviewed_at=?, attempts=0, next_retry_at=0, last_error='',
      stack_status=CASE WHEN ? IN ('eligible','unclear') THEN 'pending' ELSE 'not_checked' END
      WHERE id=? AND batch=? AND eligibility='pending'`)
      .run(
        eligibility,
        reason,
        evidence,
        company,
        location,
        title,
        title,
        new Date().toISOString(),
        eligibility,
        id,
        batch,
      );
    if (!result.changes) throw new Error('Job is not pending in this batch');
  }

  saveListingText(id: number, batch: string, text: string): void {
    if (typeof text !== 'string' || !text.trim())
      throw new Error('Invalid listing text');
    const result = this.db
      .prepare(`UPDATE jobs SET listing_text=?
      WHERE id=? AND batch=? AND ${PENDING_REVIEW} AND listing_text IS NULL`)
      .run(text, id, batch);
    if (!result.changes)
      throw new Error('Job is not pending without listing text in this batch');
  }

  reviewStack(
    id: number,
    batch: string,
    decision:
      | StackDecision
      | { status: 'error'; reason: string; evidence: string },
  ): void {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !/^[a-f0-9]{32}$/.test(batch) ||
      ![
        'match',
        'partial_match',
        'potential_match',
        'unclear',
        'error',
      ].includes(decision.status) ||
      typeof decision.reason !== 'string' ||
      !decision.reason.trim() ||
      decision.reason.length > 5000 ||
      typeof decision.evidence !== 'string' ||
      decision.evidence.length > 5000
    )
      throw new Error('Invalid stack review');
    const result = this.db
      .prepare(`UPDATE jobs SET stack_status=?, stack_reason=?, stack_evidence=?,
      reviewed_at=?, attempts=0, next_retry_at=0, last_error=''
      WHERE id=? AND batch=? AND eligibility IN ('eligible','unclear') AND stack_status='pending'`)
      .run(
        decision.status,
        decision.reason,
        decision.evidence,
        new Date().toISOString(),
        id,
        batch,
      );
    if (!result.changes)
      throw new Error('Stack review is not pending in this batch');
  }

  queueStackBackfill(): number {
    return Number(
      this.db
        .prepare(`UPDATE jobs SET stack_status='pending', attempts=0, next_retry_at=0, last_error=''
      WHERE status='active' AND eligibility IN ('eligible','unclear') AND stack_status='not_checked'`)
        .run().changes,
    );
  }

  pendingCount(batch?: string): number {
    const row = batch
      ? this.db
          .prepare(
            `SELECT count(*) AS n FROM jobs WHERE ${PENDING_REVIEW} AND batch=?`,
          )
          .get(batch)
      : this.db
          .prepare(
            `SELECT count(*) AS n FROM jobs WHERE ${PENDING_REVIEW} AND status='active'`,
          )
          .get();
    if (!row) throw new Error('Pending count query returned no row');
    return Number(row.n);
  }

  listReviewJobs(status: ReviewStatus) {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE status=? ORDER BY id DESC')
        .all(status) as unknown as Listing[]
    ).map(({ listing_text: _listingText, batch: _batch, ...row }) => ({
      ...row,
      reviewKey: String(row.id),
      companyKey: this.companyKey(row.url),
      companyLabel: row.company || new URL(row.url).pathname.split('/')[1],
    }));
  }

  private companyKey(url: string): string {
    const parsed = new URL(url);
    return `${parsed.hostname}/${parsed.pathname.split('/')[1]}`;
  }

  setReviewStatus(key: string, status: ReviewStatus): boolean {
    if (
      !['active', 'hidden', 'rejected'].includes(status) ||
      !/^[1-9]\d*$/.test(key)
    )
      return false;
    return Boolean(
      this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, key)
        .changes,
    );
  }

  setActiveCompanyStatus(key: string, status: 'hidden' | 'rejected'): string[] {
    if (!['hidden', 'rejected'].includes(status)) return [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keys = this.listReviewJobs('active')
        .filter((row) => row.companyKey === key)
        .map((row) => row.reviewKey);
      for (const id of keys) this.setReviewStatus(id, status);
      this.db.exec('COMMIT');
      return keys;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

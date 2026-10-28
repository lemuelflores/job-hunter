import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessment } from './fixtures/workflow.mjs';

// Arrange: share canonical listing results.
const result = (id) => ({
  source: 'google',
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
// Arrange: seed three pending listings in an isolated store with automatic cleanup.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

function legacyFixture(t, seedCompleted = false) {
  const root = mkdtempSync('/tmp/opencode/job-historical-storage-');
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults([result(1), result(2), result(3)]);
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM job_stages WHERE stage='assessment'");
  if (seedCompleted) {
    db.exec(
      "UPDATE jobs SET listing_text='Saved text',eligibility='eligible',reason='Saved location',stack_status='match',stack_reason='Laravel',stack_evidence='Laravel' WHERE id=1; UPDATE job_stages SET state='complete' WHERE job_id=1",
    );
  }
  db.close();
  store = new SqliteStore(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

test('rediscovery deduplicates canonical URLs without resetting saved decisions', (t) => {
  // Arrange: save both decisions and hide the listing before rediscovery.
  const store = legacyFixture(t, true);
  store.setReviewStatus('1', 'hidden');
  const before = store.getJob(1);
  // Act / Assert: rediscover the same canonical URL without inserting a row.
  assert.equal(store.saveResults([result(1), result(1)]), 0);
  // Assert: only last_seen may change; saved decisions and completion remain intact.
  const { last_seen: _beforeSeen, ...saved } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(1);
  assert.deepEqual(after, saved);
  assert.equal(store.listReviewJobs('hidden').length, 1);
  assert.ok(store.stages(1).every((stage) => stage.state === 'complete'));
});

test('posting-date migration recovers saved metadata without changing listing text or stage state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-posted-date-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  const snapshots = [
    'Ashby listing metadata:\n{\n  "publishedAt": "2025-01-02T12:00:00Z"\n}\n\nDescription:\nRole',
    'Greenhouse listing metadata:\n{"first_published":"2025-01-03T12:00:00Z","updated_at":"2026-10-22T00:00:00Z"}\n\nDescription:\nRole',
    'Freehire listing metadata:\n{"posted_at":"2025-01-04T12:00:00Z"}\n\nRole',
    'Ashby listing metadata:\n{bad json}\n\nDescription:\nRole',
    'Greenhouse listing metadata:\n{"updated_at":"2026-10-22T00:00:00Z"}\n\nDescription:\nRole',
    'Ashby listing metadata:\n{"publishedAt":"invalid"}\n\nDescription:\nRole',
    'Unstructured listing with publishedAt: 2025-01-02T12:00:00Z',
  ];
  store.saveResults(
    snapshots.map((listingText, i) => ({ ...result(i + 1), listingText })),
  );
  const before = snapshots.map((_, i) => store.getJob(i + 1));
  const stages = snapshots.map((_, i) => store.stages(i + 1));
  store.close();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE jobs DROP COLUMN posted_at');
  db.close();
  store = new SqliteStore(path);
  t.after(() => store.close());
  for (let i = 0; i < snapshots.length; i++) {
    const expected = i < 3 ? `2025-01-0${i + 2}T12:00:00.000Z` : null;
    assert.deepEqual(
      { ...store.getJob(i + 1) },
      {
        ...before[i],
        posted_at: expected,
      },
    );
    assert.deepEqual(store.stages(i + 1), stages[i]);
  }
  const reopened = new SqliteStore(path);
  try {
    assert.deepEqual(reopened.getJob(1), store.getJob(1));
  } finally {
    reopened.close();
  }
});

test('invalid results and completed-stage guards reject unsafe writes', (t) => {
  // Arrange: start with pending stages.
  const store = fixture(t);
  // Act / Assert: reject invalid discovery results and empty listing text.
  assert.throws(
    () => store.saveResults([{ ...result(4), source: 'unknown' }]),
    /CHECK constraint failed/,
  );
  assert.equal(store.getJob(4), undefined);
  assert.throws(() => store.saveListingText(1, ''), /Invalid listing/);
  store.saveListingText(1, 'text');
  store.saveAssessment(1, assessment);
  assert.throws(() => store.saveAssessment(1, assessment), /not pending/);
  assert.deepEqual(store.getAssessment(1).assessment, assessment);
});

test('migration preserves historical decisions, indexes and triggers without implicit backfill', async (t) => {
  // Arrange: build a legacy database with decisions, a custom index, and an audit trigger.
  const root = await mkdtemp(join(tmpdir(), 'job-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT NOT NULL,snippet TEXT NOT NULL DEFAULT '',query TEXT NOT NULL,
    first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,
    eligibility TEXT NOT NULL DEFAULT 'pending' CHECK(eligibility IN ('pending','eligible','ineligible','unclear')),
    reason TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '',company TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',reviewed_at TEXT,last_attempt TEXT,batch TEXT);
    CREATE INDEX jobs_title ON jobs(title);
    CREATE TABLE audit(id INTEGER);
    CREATE TRIGGER audit_job AFTER UPDATE ON jobs BEGIN INSERT INTO audit VALUES(new.id); END;`);
  for (const [id, eligibility, status] of [
    [1, 'ineligible', 'active'],
    [2, 'eligible', 'active'],
    [3, 'unclear', 'hidden'],
    [4, 'pending', 'active'],
  ]) {
    // Arrange: retain each historical eligibility and visibility combination.
    db.prepare(`INSERT INTO jobs(id,url,title,query,first_seen,last_seen,eligibility,reason,evidence,status,batch)
      VALUES (?,?,'Engineer','remote','then','then',?,'Saved reason','Saved evidence',?,'abandoned')`).run(
      id,
      `https://job-boards.greenhouse.io/example/jobs/${id}`,
      eligibility,
      status,
    );
  }
  db.exec("UPDATE jobs SET query='freehire' WHERE id=3");
  const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  db.close();
  // Act: open the legacy database to apply migration.
  const store = new SqliteStore(path);
  try {
    // Assert: migration preserves pending work, historical rows, indexes, and triggers.
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.getJob(1).source, 'google');
    assert.equal(store.getJob(3).source, 'freehire');
    assert.equal(store.getJob(3).query, 'freehire');
    const check = new DatabaseSync(path);
    for (const original of before) {
      // Assert: every field in this historical listing survives migration unchanged.
      const row = check
        .prepare('SELECT * FROM jobs WHERE id=?')
        .get(original.id);
      for (const key of Object.keys(original))
        assert.equal(row[key], original[key]);
    }
    assert.ok(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name='jobs_title'")
        .get(),
    );
    assert.ok(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name='audit_job'")
        .get(),
    );
    // Historical queue state can exist without scheduling a new assessment.
    check.exec(
      "UPDATE jobs SET stack_status='pending' WHERE id=1; UPDATE job_stages SET state='pending' WHERE job_id=1 AND stage IN ('crawl','stack')",
    );
    assert.equal(
      store.stages(1).find((s) => s.stage === 'location').state,
      'complete',
    );
    // Act: persist a terminal crawl result for a historical listing queued for backfill.
    store.terminalCrawl(1, 'Gone');
    // Assert: history survives, stack is blocked, and the preserved trigger still fires.
    assert.equal(store.getJob(1).reason, 'Saved reason');
    assert.equal(store.getJob(1).evidence, 'Saved evidence');
    assert.equal(store.getJob(1).eligibility, 'ineligible');
    assert.equal(
      store.stages(1).find((s) => s.stage === 'stack').state,
      'blocked',
    );
    assert.equal(store.listReviewJobs('hidden')[0].stack_status, 'not_checked');
    assert.ok(check.prepare('SELECT count(*) AS n FROM audit').get().n > 0);
    check.close();
    // Act: reopen the migrated database a second time.
    const reopened = new SqliteStore(path);
    // Assert: persisted stage state is stable across reopening.
    assert.deepEqual(reopened.stages(1), store.stages(1));
    assert.equal(reopened.getJob(3).source, 'freehire');
    assert.equal(reopened.getJob(3).query, 'freehire');
    reopened.close();
  } finally {
    store.close();
  }
});

test('migration preserves historical decisions and snapshots without scheduling assessments', async (t) => {
  // Arrange: preserve historical decisions and snapshots but remove the stage table.
  const root = await mkdtemp(join(tmpdir(), 'job-snapshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults(
    [1, 2, 3].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
      source: 'google',
    })),
  );
  store.saveListingText(1, 'Saved snapshot');
  store.saveListingText(3, 'Stack retry snapshot');
  store.close();
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE job_stages; UPDATE jobs SET eligibility='eligible',reason='Historical eligible',stack_status='match',stack_reason='Laravel',stack_evidence='Laravel' WHERE id=1; UPDATE jobs SET eligibility='ineligible',reason='Historical rejected',stack_status='not_checked' WHERE id=2; UPDATE jobs SET eligibility='unclear',reason='Historical unclear' WHERE id=3",
  );
  const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  db.close();
  // Act: reopen the database to rebuild stages from persisted listing data.
  store = new SqliteStore(path);
  try {
    // Assert: all historical rows survive and old stages remain outside active work.
    for (const row of before) assert.deepEqual(store.getJob(row.id), row);
    assert.deepEqual(
      store.unfinished().map((row) => row.id),
      [],
    );
    // Historical unfinished stages remain inert and their evidence remains intact.
    assert.equal(
      store.stages(3).find((stage) => stage.stage === 'stack').state,
      'pending',
    );
    assert.equal(store.getJob(3).reason, 'Historical unclear');
    assert.equal(store.getJob(3).listing_text, 'Stack retry snapshot');
    assert.deepEqual(store.getJob(1), before[0]);
    assert.deepEqual(store.getJob(2), before[1]);
  } finally {
    store.close();
  }
});

test('stage failures remain pending until exhausted and only failed stages can reset', (t) => {
  // Arrange: start with a pending crawl and a separate terminal crawl.
  const store = fixture(t);
  store.terminalCrawl(1, 'Gone');
  // Act: record a temporary failure with attempts remaining.
  store.failStage(2, 'crawl', 'Temporary page error', false);
  // Assert: the stage remains pending for another delivery.
  assert.deepEqual(
    { ...store.stages(2).find((s) => s.stage === 'crawl') },
    {
      stage: 'crawl',
      state: 'pending',
      error: 'Temporary page error',
      generation: 0,
    },
  );
  // Act: record retry exhaustion.
  store.failStage(2, 'crawl', 'Temporary page error', true);
  // Assert: only the crawl fails; the listing remains undecided.
  assert.equal(
    store.stages(2).find((s) => s.stage === 'crawl').state,
    'failed',
  );
  assert.equal(store.getJob(2).eligibility, 'pending');
  // Act / Assert: terminal stages cannot be reset as failed stages.
  assert.throws(() => store.resetStage(1, 'crawl'), /not failed/);
  // Act: reset the failed crawl.
  store.resetStage(2, 'crawl');
  // A failure captured before retry must not undo the new pending generation.
  store.failStage(2, 'crawl', 'Stale failure', true, 0);
  // Assert: reset clears the error and restores pending work.
  assert.deepEqual(
    { ...store.stages(2).find((s) => s.stage === 'crawl') },
    {
      stage: 'crawl',
      state: 'pending',
      error: '',
      generation: 1,
    },
  );
});

test('migration adds retry generations without resetting existing stage failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-generations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const original = new SqliteStore(path);
  original.saveResults([result(1)]);
  original.failStage(1, 'crawl', 'Preserved failure', true);
  original.close();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE job_stages DROP COLUMN generation');
  db.close();
  const migrated = new SqliteStore(path);
  t.after(() => migrated.close());
  assert.equal(
    migrated.stages(1).find((s) => s.stage === 'crawl').state,
    'failed',
  );
  assert.equal(
    migrated.stages(1).find((s) => s.stage === 'crawl').error,
    'Preserved failure',
  );
  assert.equal(
    migrated.stages(1).find((s) => s.stage === 'crawl').generation,
    0,
  );
  migrated.resetStage(1, 'crawl');
  migrated.failStage(1, 'crawl', 'Stale failure', true, 0);
  assert.equal(
    migrated.stages(1).find((s) => s.stage === 'crawl').state,
    'pending',
  );
  migrated.failStage(1, 'crawl', 'Current failure', true, 1);
  assert.equal(
    migrated.stages(1).find((s) => s.stage === 'crawl').state,
    'failed',
  );
});

test('listing summaries omit snapshots and counts retain stage and visibility rules', (t) => {
  const store = fixture(t);
  store.saveListingText(1, 'Large saved description'.repeat(10000));
  store.failStage(1, 'assessment', 'Exhausted', true);
  store.setReviewStatus('2', 'hidden');
  store.terminalCrawl(3, 'Gone');
  const { listing_text, batch, ...job } = store.getJob(1);
  assert.ok(listing_text.length > 100000);
  assert.deepEqual(
    store.listReviewJobs('active').find((row) => row.id === 1),
    {
      ...job,
      stages: store.stages(1),
      reviewKey: '1',
    },
  );
  assert.deepEqual(
    store.unfinished().map((row) => ({ ...row })),
    [{ id: 1, url: result(1).url }],
  );
  assert.equal(store.pendingCount(), 1);
  store.resetStage(1, 'assessment');
  store.saveAssessment(1, assessment);
  assert.equal(store.pendingCount(), 0);
});

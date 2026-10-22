import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical listing results.
const result = (id) => ({
  source: 'google',
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
// Arrange: share a valid stack result for persistence tests.
const stack = { status: 'match', reason: 'Laravel', evidence: 'Laravel' };

// Arrange: seed three pending listings in an isolated store with automatic cleanup.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

test('rediscovery deduplicates canonical URLs without resetting saved decisions', (t) => {
  // Arrange: save both decisions and hide the listing before rediscovery.
  const store = fixture(t);
  store.saveListingText(1, 'Saved text');
  store.review(1, 'eligible', 'Saved location');
  store.reviewStack(1, stack);
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
  // Act / Assert: reject invalid location decisions and empty listing text.
  assert.throws(
    () => store.saveResults([{ ...result(4), source: 'unknown' }]),
    /CHECK constraint failed/,
  );
  assert.equal(store.getJob(4), undefined);
  assert.throws(() => store.review(1, 'deleted', 'invalid'), /Invalid review/);
  assert.throws(() => store.review(1, 'eligible', ''), /Invalid review/);
  assert.throws(() => store.saveListingText(1, ''), /Invalid listing/);
  // Arrange: complete a valid location assessment.
  store.saveListingText(1, 'text');
  store.review(1, 'eligible', 'Worldwide');
  // Act / Assert: reject overwriting the completed location assessment.
  assert.throws(
    () => store.review(1, 'ineligible', 'overwrite'),
    /not pending/,
  );
  // Assert: the original eligibility survives the rejected overwrite.
  assert.equal(store.getJob(1).eligibility, 'eligible');
  // Act / Assert: reject each unsupported stack result status.
  for (const status of ['deleted', 'pending'])
    assert.throws(
      () => store.reviewStack(1, { ...stack, status }),
      /Invalid stack/,
    );
  // Arrange: complete a valid stack assessment.
  store.reviewStack(1, stack);
  // Act / Assert: completed stack assessments cannot be overwritten either.
  assert.throws(() => store.reviewStack(1, stack), /not pending/);
});

test('review validation preserves pending data and accepts storage error decisions at length limits', (t) => {
  const store = fixture(t);
  const before = store.getJob(1);
  const stages = store.stages(1);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => store.review(id, 'eligible', 'Valid'),
      /Invalid review/,
    );
    assert.throws(() => store.reviewStack(id, stack), /Invalid stack review/);
  }
  for (const [reason, evidence, company, location, title] of [
    [' \t'],
    [null],
    ['x'.repeat(5001)],
    ['Valid', 'x'.repeat(5001)],
    ['Valid', null],
    ['Valid', '', 'x'.repeat(1001)],
    ['Valid', '', '', 'x'.repeat(1001)],
    ['Valid', '', '', '', 'x'.repeat(1001)],
  ]) {
    assert.throws(
      () =>
        store.review(1, 'eligible', reason, evidence, company, location, title),
      /Invalid review/,
    );
  }
  for (const decision of [
    null,
    {},
    { ...stack, reason: ' \t' },
    { ...stack, reason: null },
    { ...stack, reason: 'x'.repeat(5001) },
    { ...stack, evidence: null },
    { ...stack, evidence: 'x'.repeat(5001) },
  ]) {
    assert.throws(() => store.reviewStack(1, decision), /Invalid stack review/);
  }
  assert.deepEqual(store.getJob(1), before);
  assert.deepEqual(store.stages(1), stages);

  const reason = ` ${'x'.repeat(4998)} `;
  const evidence = 'x'.repeat(5000);
  const metadata = 'x'.repeat(1000);
  store.review(1, 'error', reason, evidence, metadata, metadata, metadata);
  store.reviewStack(1, { status: 'error', reason, evidence, extra: 'ignored' });
  const saved = store.getJob(1);
  assert.equal(saved.eligibility, 'error');
  assert.equal(saved.reason, reason);
  assert.equal(saved.evidence, evidence);
  assert.equal(saved.company, metadata);
  assert.equal(saved.location, metadata);
  assert.equal(saved.title, metadata);
  assert.equal(saved.stack_status, 'error');
  assert.equal(saved.stack_reason, reason);
  assert.equal(saved.stack_evidence, evidence);
});

test('a failed result write rolls back stage completion and permits retry', async (t) => {
  // Arrange: use a second database connection to force result writes to fail.
  const root = await mkdtemp(join(tmpdir(), 'job-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    store.close();
  });
  store.saveResults([
    {
      url: 'https://job-boards.greenhouse.io/example/jobs/1',
      title: 'Engineer',
      query: 'remote',
      source: 'google',
    },
  ]);
  const before = store.getJob(1);
  db.exec(`CREATE TRIGGER reject_review BEFORE UPDATE OF eligibility ON jobs
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
  // Act / Assert: the injected SQLite failure rejects the review write.
  assert.throws(
    () => store.review(1, 'eligible', 'Worldwide'),
    /simulated write failure/,
  );
  // Assert: the transaction preserves both the listing and its pending stage.
  assert.deepEqual(store.getJob(1), before);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'location').state,
    'pending',
  );
  // Arrange: remove the injected write failure.
  db.exec('DROP TRIGGER reject_review');
  // Act: retry the same location decision.
  store.review(1, 'eligible', 'Worldwide');
  // Assert: result persistence and stage completion now succeed together.
  assert.equal(store.getJob(1).eligibility, 'eligible');
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'location').state,
    'complete',
  );
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
    // Act / Assert: explicit stack backfill queues selected history exactly once.
    assert.equal(store.queueStackBackfill(), 2);
    assert.equal(store.queueStackBackfill(), 0);
    // Assert: backfill does not reset the completed location stage.
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

test('migration preserves assessment results and snapshots and restores only unfinished stage state', async (t) => {
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
  store.review(1, 'eligible', 'Historical eligible');
  store.reviewStack(1, stack);
  store.review(2, 'ineligible', 'Historical rejected');
  store.saveListingText(3, 'Stack retry snapshot');
  store.review(3, 'unclear', 'Historical unclear');
  store.close();
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE job_stages; UPDATE jobs SET stack_status='not_checked' WHERE id=2",
  );
  const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  db.close();
  // Act: reopen the database to rebuild stages from persisted listing data.
  store = new SqliteStore(path);
  try {
    // Assert: all historical rows survive and only the unfinished stack retry is selected.
    for (const row of before) assert.deepEqual(store.getJob(row.id), row);
    assert.deepEqual(
      store.unfinished().map((row) => row.id),
      [3],
    );
    // Act: save the outstanding stack result directly.
    store.reviewStack(3, stack);
    // Assert: completing the stage preserves its snapshot and historical decisions.
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
    { ...store.stages(2)[0] },
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
  assert.equal(store.stages(2)[0].state, 'failed');
  assert.equal(store.getJob(2).eligibility, 'pending');
  // Act / Assert: terminal stages cannot be reset as failed stages.
  assert.throws(() => store.resetStage(1, 'crawl'), /not failed/);
  // Act: reset the failed crawl.
  store.resetStage(2, 'crawl');
  // A failure captured before retry must not undo the new pending generation.
  store.failStage(2, 'crawl', 'Stale failure', true, 0);
  // Assert: reset clears the error and restores pending work.
  assert.deepEqual(
    { ...store.stages(2)[0] },
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
  assert.equal(migrated.stages(1)[0].state, 'failed');
  assert.equal(migrated.stages(1)[0].error, 'Preserved failure');
  assert.equal(migrated.stages(1)[0].generation, 0);
  migrated.resetStage(1, 'crawl');
  migrated.failStage(1, 'crawl', 'Stale failure', true, 0);
  assert.equal(migrated.stages(1)[0].state, 'pending');
  migrated.failStage(1, 'crawl', 'Current failure', true, 1);
  assert.equal(migrated.stages(1)[0].state, 'failed');
});

test('listing summaries omit snapshots and counts retain stage and visibility rules', (t) => {
  const store = fixture(t);
  store.saveListingText(1, 'Large saved description'.repeat(10000));
  store.failStage(1, 'location', 'Exhausted', true);
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
  store.resetStage(1, 'location');
  store.review(1, 'eligible', 'Worldwide');
  store.reviewStack(1, stack);
  assert.equal(store.pendingCount(), 0);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { processStage } from '../dist/review/worker.js';
import { jobUrl, SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical listing results.
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
// Arrange: share deterministic location and stack responses for independent assessments.
const decision = {
  eligibility: 'ineligible',
  reason: 'US only',
  evidence: 'US residents',
  company: 'Example',
  location: 'US',
  title: 'Engineer',
};
const stack = { status: 'match', reason: 'Laravel', evidence: 'Laravel' };
const services = {
  scrapeListing: async () => 'US Laravel role',
  reviewJob: async () => decision,
  reviewStack: async () => stack,
};
const enqueue = async () => {};

// Arrange: seed three pending listings in an isolated store with automatic cleanup.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

test('URL validation accepts supported listing shapes and strips tracking', () => {
  // Arrange: use a valid UUID listing identifier across supported hosts.
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const host of [
    'jobs.ashbyhq.com',
    'jobs.lever.co',
    'jobs.eu.lever.co',
  ]) {
    // Arrange: construct this provider's canonical listing URL.
    const url = `https://${host}/example/${uuid}`;
    // Act / Assert: strip tracking while retaining the canonical listing URL.
    assert.equal(jobUrl(`${url}?utm_source=google#details`), url);
  }
  // Act / Assert: normalize both Greenhouse hosts to the canonical URL.
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io'])
    assert.equal(
      jobUrl(`https://${host}/example/jobs/1?tracking=x`),
      result(1).url,
    );
  // Arrange: cover unsupported hosts, paths, protocols, credentials, and encodings.
  // Act / Assert: reject each unsafe or unsupported listing URL.
  for (const url of [
    'https://evil.test/example/jobs/1',
    'https://jobs.lever.co/example',
    `https://jobs.lever.co/example/${uuid}/apply`,
    `http://jobs.lever.co/example/${uuid}`,
    `https://jobs.lever.co:8443/example/${uuid}`,
    'https://u:p@job-boards.greenhouse.io/example/jobs/1',
    `https://jobs.lever.co/ex%2Fample/${uuid}`,
    `https://jobs.lever.co/ex%5Cample/${uuid}`,
    `https://jobs.lever.co/ex%ZZample/${uuid}`,
  ])
    assert.equal(jobUrl(url), null, url);
});

test('rediscovery deduplicates canonical URLs without resetting saved decisions', (t) => {
  // Arrange: save both decisions and hide the listing before rediscovery.
  const store = fixture(t);
  store.saveListingText(1, 'Saved text');
  store.review(1, 'eligible', 'Saved location');
  store.reviewStack(1, stack);
  store.setReviewStatus('1', 'hidden');
  const before = store.getJob(1);
  // Act / Assert: rediscover tracked and canonical aliases without inserting a row.
  assert.equal(
    store.saveResults([
      {
        ...result(1),
        url: 'https://boards.greenhouse.io/example/jobs/1?source=google#top',
      },
      result(1),
    ]),
    0,
  );
  // Assert: only last_seen may change; saved decisions and completion remain intact.
  const { last_seen: _beforeSeen, ...saved } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(1);
  assert.deepEqual(after, saved);
  assert.equal(store.listReviewJobs('hidden').length, 1);
  assert.ok(store.stages(1).every((stage) => stage.state === 'complete'));
});

test('invalid results and completed-stage guards reject unsafe writes', (t) => {
  // Arrange: start with pending stages.
  const store = fixture(t);
  // Act / Assert: reject invalid location decisions and empty listing text.
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

test('a failed result write rolls back stage completion and permits retry', async (t) => {
  // Arrange: use a second database connection to force result writes to fail.
  const root = await mkdtemp('/tmp/opencode/job-rollback-');
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
  const root = await mkdtemp('/tmp/opencode/job-migration-');
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
  const before = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  db.close();
  // Act: open the legacy database to apply migration.
  const store = new SqliteStore(path);
  try {
    // Assert: migration preserves pending work, historical rows, indexes, and triggers.
    assert.equal(store.pendingCount(), 1);
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
    // Act: encounter a removed page while crawling a historical listing for backfill.
    await processStage(store, 'crawl', 1, enqueue, {
      ...services,
      scrapeListing: async () => {
        const { PageError } = await import('../dist/review/firecrawl.js');
        throw new PageError(404, 'Gone');
      },
    });
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
    reopened.close();
  } finally {
    store.close();
  }
});

test('existing technology assessment results and listing snapshots survive migration without re-evaluation', async (t) => {
  // Arrange: preserve historical decisions and snapshots but remove the stage table.
  const root = await mkdtemp('/tmp/opencode/job-snapshots-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults(
    [1, 2, 3].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
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
    // Act: retry stack assessment with location review and rescraping forbidden.
    await processStage(store, 'stack', 3, enqueue, {
      ...services,
      reviewJob: async () => assert.fail('location must stay saved'),
      scrapeListing: async () => assert.fail('snapshot must be reused'),
    });
    // Assert: the retry reuses its snapshot and leaves historical decisions untouched.
    assert.equal(store.getJob(3).reason, 'Historical unclear');
    assert.equal(store.getJob(3).listing_text, 'Stack retry snapshot');
    assert.deepEqual(store.getJob(1), before[0]);
    assert.deepEqual(store.getJob(2), before[1]);
  } finally {
    store.close();
  }
});

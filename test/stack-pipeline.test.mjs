import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../dist/persistence.js';
import { processStage } from '../dist/runner.js';

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
function fixture(t) {
  const store = new SqliteStore(':memory:');
  store.saveResults(
    [1, 2].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  t.after(() => store.close());
  return store;
}

test('location rejection does not block stack; either evaluation can fail while the other succeeds', async (t) => {
  for (const failing of ['location', 'stack']) {
    const store = fixture(t);
    await processStage(store, 'crawl', 1, enqueue, services);
    const fake = {
      ...services,
      [failing === 'location' ? 'reviewJob' : 'reviewStack']: async () => {
        throw new Error('temporary');
      },
    };
    await assert.rejects(
      processStage(store, failing, 1, enqueue, fake),
      /temporary/,
    );
    store.failStage(1, failing, 'temporary', true);
    const other = failing === 'location' ? 'stack' : 'location';
    await processStage(store, other, 1, enqueue, fake);
    assert.equal(
      store.stages(1).find((s) => s.stage === other).state,
      'complete',
    );
    const before = store.getJob(1);
    store.resetStage(1, failing);
    await processStage(store, failing, 1, enqueue, services);
    const after = store.getJob(1);
    for (const key of other === 'location'
      ? ['eligibility', 'reason', 'evidence', 'company', 'location', 'title']
      : ['stack_status', 'stack_reason', 'stack_evidence'])
      assert.equal(after[key], before[key]);
    assert.equal(after.eligibility, 'ineligible');
    assert.equal(after.stack_status, 'match');
  }
});

test('an unfinished location request does not block stack or crawling the next listing', async (t) => {
  const store = fixture(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await processStage(store, 'crawl', 1, enqueue, services);
  const location = processStage(store, 'location', 1, enqueue, {
    ...services,
    reviewJob: async () => {
      await blocked;
      return decision;
    },
  });
  await processStage(store, 'stack', 1, enqueue, services);
  await processStage(store, 'crawl', 2, enqueue, services);
  assert.equal(store.getJob(1).eligibility, 'pending');
  assert.equal(store.getJob(1).stack_status, 'match');
  assert.ok(store.getJob(2).listing_text);
  release();
  await location;
});

test('migration preserves historical decisions, indexes and triggers without implicit backfill', async (t) => {
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
  const store = new SqliteStore(path);
  try {
    assert.equal(store.pendingCount(), 1);
    const check = new DatabaseSync(path);
    for (const original of before) {
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
    assert.equal(store.queueStackBackfill(), 2);
    assert.equal(store.queueStackBackfill(), 0);
    assert.equal(
      store.stages(1).find((s) => s.stage === 'location').state,
      'complete',
    );
    await processStage(store, 'crawl', 1, enqueue, {
      ...services,
      scrapeListing: async () => {
        const { PageError } = await import('../dist/firecrawl.js');
        throw new PageError(404, 'Gone');
      },
    });
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
    const reopened = new SqliteStore(path);
    assert.deepEqual(reopened.stages(1), store.stages(1));
    reopened.close();
  } finally {
    store.close();
  }
});

test('existing stack results and listing snapshots survive migration without re-evaluation', async (t) => {
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
  store = new SqliteStore(path);
  try {
    for (const row of before) assert.deepEqual(store.getJob(row.id), row);
    assert.deepEqual(
      store.unfinished().map((row) => row.id),
      [3],
    );
    await processStage(store, 'stack', 3, enqueue, {
      ...services,
      reviewJob: async () => assert.fail('location must stay saved'),
      scrapeListing: async () => assert.fail('snapshot must be reused'),
    });
    assert.equal(store.getJob(3).reason, 'Historical unclear');
    assert.equal(store.getJob(3).listing_text, 'Stack retry snapshot');
    assert.deepEqual(store.getJob(1), before[0]);
    assert.deepEqual(store.getJob(2), before[1]);
  } finally {
    store.close();
  }
});

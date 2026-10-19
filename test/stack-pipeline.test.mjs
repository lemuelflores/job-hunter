import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PageError } from '../dist/firecrawl.js';
import { AuthenticationError, RateLimitError } from '../dist/llm/index.js';
import { SqliteStore } from '../dist/persistence.js';
import { reviewJobs, workJobs } from '../dist/runner.js';

const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Developer',
  query: 'remote',
});
const location = {
  eligibility: 'eligible',
  reason: 'Worldwide',
  evidence: 'Worldwide',
  company: 'Example',
  title: 'Developer',
  location: 'Remote',
};
const stack = {
  status: 'partial_match',
  reason: 'Laravel and React are required',
  evidence: 'Laravel + React',
};
const text = 'Worldwide. Laravel + React';
const services = (overrides = {}) => ({
  scrapeListing: async () => text,
  reviewJob: async () => location,
  reviewStack: async () => stack,
  ...overrides,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stack-pipeline-'));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.saveResults([result(1)]);
  return { root, path, store };
}

test('both reviews share one persisted scrape and expose independent results without the snapshot', async (t) => {
  const { root, path, store } = await fixture(t);
  const calls = [];
  const outcome = await reviewJobs(
    root,
    store,
    {},
    services({
      scrapeListing: async () => {
        calls.push('scrape');
        return text;
      },
      reviewJob: async (_url, options) => {
        calls.push('location');
        assert.equal(options.listingText, text);
        return location;
      },
      reviewStack: async (_url, options) => {
        calls.push('stack');
        assert.equal(options.listingText, text);
        assert.equal(options.eligibility, undefined);
        return stack;
      },
    }),
  );
  assert.deepEqual(calls, ['scrape', 'location', 'stack']);
  assert.deepEqual(outcome, { reviewed: 1, pending: 0, failures: [] });
  const [row] = store.listReviewJobs('active');
  assert.equal(row.eligibility, 'eligible');
  assert.equal(row.reason, location.reason);
  assert.equal(row.stack_status, 'partial_match');
  assert.equal(row.stack_evidence, stack.evidence);
  assert.equal('listing_text' in row, false);
  const db = new DatabaseSync(path);
  try {
    assert.equal(
      db.prepare('SELECT listing_text FROM jobs').get().listing_text,
      text,
    );
  } finally {
    db.close();
  }
});

test('location rejection skips stack, while unclear locations still get a stack assessment', async (t) => {
  for (const eligibility of ['ineligible', 'unclear']) {
    const { root, store } = await fixture(t);
    let stackCalls = 0;
    await reviewJobs(
      root,
      store,
      {},
      services({
        reviewJob: async () => ({ ...location, eligibility }),
        reviewStack: async () => {
          stackCalls++;
          return stack;
        },
      }),
    );
    const [row] = store.listReviewJobs('active');
    assert.equal(stackCalls, eligibility === 'unclear' ? 1 : 0);
    assert.equal(
      row.stack_status,
      eligibility === 'unclear' ? 'partial_match' : 'not_checked',
    );
    assert.equal(store.pendingCount(), 0);
  }
});

test('stack failure survives reopening and resumes only the incomplete stage', async (t) => {
  const { root, path, store } = await fixture(t);
  const first = await reviewJobs(
    root,
    store,
    {},
    services({
      reviewStack: async () => {
        throw new Error('model unavailable');
      },
    }),
  );
  assert.equal(first.reviewed, 0);
  assert.equal(first.pending, 1);
  const [row] = store.listReviewJobs('active');
  assert.equal(row.eligibility, 'eligible');
  assert.equal(row.stack_status, 'pending');
  const reopened = new SqliteStore(path);
  try {
    const resumed = await reviewJobs(
      root,
      reopened,
      {},
      services({
        scrapeListing: async () => assert.fail('must reuse snapshot'),
        reviewJob: async () => assert.fail('must preserve location'),
      }),
    );
    assert.equal(resumed.reviewed, 1);
    assert.equal(resumed.pending, 0);
  } finally {
    reopened.close();
  }
});

test('interruption between stages preserves the completed location decision', async (t) => {
  const { root, store } = await fixture(t);
  const outcome = await reviewJobs(
    root,
    store,
    {},
    services({
      reviewStack: async (_url, { signal }) => {
        process.emit('SIGTERM');
        signal.throwIfAborted();
        return stack;
      },
    }),
  );
  assert.equal(outcome.pending, 1);
  assert.equal(store.listReviewJobs('active')[0].eligibility, 'eligible');
  assert.equal(store.listReviewJobs('active')[0].attempts, 0);
  assert.equal(
    (
      await reviewJobs(
        root,
        store,
        {},
        services({
          reviewJob: async () => assert.fail('location already complete'),
        }),
      )
    ).reviewed,
    1,
  );
});

test('worker stage transition resets the retry budget; stack failures retain the location checkpoint', {
  timeout: 5000,
}, async (t) => {
  const { root, path, store } = await fixture(t);
  const batch = 'b'.repeat(32);
  store.claimBatch(batch);
  for (let i = 0; i < 4; i++)
    store.failReview(1, batch, 'old location failure', 0);
  store.finishBatch(batch);
  await workJobs(
    root,
    store,
    services({
      reviewStack: async () => {
        setImmediate(() => process.emit('SIGTERM'));
        throw new Error('stack failure');
      },
    }),
  );
  const [row] = store.listReviewJobs('active');
  assert.equal(row.eligibility, 'eligible');
  assert.equal(row.stack_status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'stack failure');
  const db = new DatabaseSync(path);
  try {
    db.exec('UPDATE jobs SET next_retry_at=0');
  } finally {
    db.close();
  }
  await workJobs(
    root,
    store,
    services({
      scrapeListing: async () => assert.fail('snapshot exists'),
      reviewJob: async () => assert.fail('location complete'),
      reviewStack: async () => {
        setImmediate(() => process.emit('SIGTERM'));
        return stack;
      },
    }),
  );
  assert.equal(store.pendingCount(), 0);
});

test('stack authentication and rate limits preserve location and follow existing retry semantics', {
  timeout: 5000,
}, async (t) => {
  for (const error of [
    new AuthenticationError('expired'),
    new RateLimitError('429'),
  ]) {
    const { root, store } = await fixture(t);
    await workJobs(
      root,
      store,
      services({
        reviewStack: async () => {
          setImmediate(() => process.emit('SIGTERM'));
          throw error;
        },
      }),
    );
    const [row] = store.listReviewJobs('active');
    assert.equal(row.eligibility, 'eligible');
    assert.equal(row.stack_status, 'pending');
    assert.equal(row.attempts, error instanceof AuthenticationError ? 0 : 1);
  }
});

test('migration leaves saved decisions untouched; explicit backfill only queues active eligible/unclear jobs', async (t) => {
  const { root, path, store } = await fixture(t);
  store.saveResults([result(2), result(3), result(4)]);
  const batch = 'c'.repeat(32);
  store.claimBatch(batch);
  for (const [id, eligibility] of [
    [1, 'eligible'],
    [2, 'unclear'],
    [3, 'ineligible'],
    [4, 'eligible'],
  ])
    store.review(
      id,
      batch,
      eligibility,
      'Saved location decision',
      'Saved evidence',
    );
  store.finishBatch(batch);
  store.setReviewStatus('4', 'hidden');
  const db = new DatabaseSync(path);
  try {
    for (const column of [
      'stack_status',
      'stack_reason',
      'stack_evidence',
      'listing_text',
    ])
      db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
    db.exec("UPDATE jobs SET batch='abandoned-batch' WHERE id=1");
    db.exec(
      'CREATE INDEX test_title ON jobs(title); CREATE TABLE audit (id INTEGER); CREATE TRIGGER audit_job AFTER UPDATE ON jobs BEGIN INSERT INTO audit VALUES (new.id); END;',
    );
  } finally {
    db.close();
  }
  const migrated = new SqliteStore(path);
  try {
    assert.equal(migrated.pendingCount(), 0);
    assert.ok(
      migrated
        .listReviewJobs('active')
        .every((row) => row.stack_status === 'not_checked'),
    );
    assert.equal(migrated.queueStackBackfill(), 2);
    assert.equal(migrated.queueStackBackfill(), 0);
    assert.equal(migrated.pendingCount(), 2);
    const outcome = await reviewJobs(
      root,
      migrated,
      {},
      services({
        reviewJob: async () => assert.fail('preserve historical location'),
        scrapeListing: async (url) => {
          if (url === result(1).url)
            throw new PageError(404, 'Listing removed');
          return text;
        },
      }),
    );
    assert.equal(outcome.reviewed, 2);
    const rows = migrated.listReviewJobs('active');
    assert.equal(rows.find((row) => row.id === 1).stack_status, 'error');
    assert.match(
      rows.find((row) => row.id === 1).stack_reason,
      /Listing removed/,
    );
    assert.ok(
      rows.every(
        (row) =>
          row.reason === 'Saved location decision' &&
          row.evidence === 'Saved evidence',
      ),
    );
    assert.equal(
      migrated.listReviewJobs('hidden')[0].stack_status,
      'not_checked',
    );
    const check = new DatabaseSync(path);
    try {
      assert.ok(
        check
          .prepare("SELECT name FROM sqlite_master WHERE name='test_title'")
          .get(),
      );
      assert.ok(check.prepare('SELECT count(*) AS n FROM audit').get().n > 0);
    } finally {
      check.close();
    }
  } finally {
    migrated.close();
  }
});

test('stack persistence rejects invalid and out-of-batch decisions and cannot overwrite results', async (t) => {
  const { store } = await fixture(t);
  const batch = 'd'.repeat(32);
  store.claimBatch(batch);
  assert.throws(() => store.reviewStack(1, batch, stack), /not pending/);
  store.review(1, batch, 'eligible', 'Worldwide');
  assert.throws(
    () => store.reviewStack(1, 'e'.repeat(32), stack),
    /not pending/,
  );
  for (const decision of [
    { ...stack, status: 'mismatch' },
    { ...stack, reason: '' },
    { ...stack, evidence: 'x'.repeat(5001) },
  ])
    assert.throws(
      () => store.reviewStack(1, batch, decision),
      /Invalid stack review/,
    );
  store.reviewStack(1, batch, stack);
  assert.throws(() => store.reviewStack(1, batch, stack), /not pending/);
});

test('stack-backfill CLI queues app-root historical jobs without profile, scraping or model calls', async (t) => {
  const { root, path, store } = await fixture(t);
  const batch = 'f'.repeat(32);
  store.claimBatch(batch);
  store.review(1, batch, 'eligible', 'Historical location');
  store.finishBatch(batch);
  const db = new DatabaseSync(path);
  try {
    db.exec("UPDATE jobs SET stack_status='not_checked'");
  } finally {
    db.close();
  }
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), {
    recursive: true,
  });
  await cp(
    new URL('../package.json', import.meta.url),
    join(root, 'package.json'),
  );
  const command = spawnSync(
    process.execPath,
    [join(root, 'dist/cli.js'), 'stack-backfill'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), { queued: 1 });
  const [row] = store.listReviewJobs('active');
  assert.equal(row.eligibility, 'eligible');
  assert.equal(row.reason, 'Historical location');
  assert.equal(row.stack_status, 'pending');
});

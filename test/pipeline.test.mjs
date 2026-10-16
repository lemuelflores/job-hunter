import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobUrl, SqliteStore } from '../dist/persistence.js';
import { fetchJobs, reviewJobs } from '../dist/runner.js';

const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
const decision = {
  eligibility: 'eligible',
  reason: 'Worldwide',
  evidence: 'Work anywhere',
  company: 'Example',
  location: 'Remote',
  title: 'Engineer',
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-'));
  const store = new SqliteStore(join(root, 'jobs.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

test('fetch saves and deduplicates profile-based Google queries without reviewing', async (t) => {
  const { store } = await fixture(t);
  const search = async (queries) => {
    assert.equal(queries.length, 45);
    return {
      results: [result(1), result(1), result(2)],
      failures: [{ query: 'failed', error: 'timeout' }],
    };
  };
  assert.deepEqual(await fetchJobs(store, search), {
    added: 2,
    pending: 2,
    failures: ['failed: timeout'],
  });
  assert.equal((await fetchJobs(store, search)).added, 0);
});

test('review saves each job immediately and resumes only pending jobs after failure', async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1), result(2), result(3)]);
  let calls = 0;
  const first = await reviewJobs(root, store, {}, async () => {
    if (++calls === 2) throw new Error('Quota exceeded');
    return decision;
  });
  assert.equal(first.reviewed, 1);
  assert.equal(first.pending, 2);
  assert.match(first.failures.join(' '), /Quota exceeded/);
  const submitted = [];
  const second = await reviewJobs(root, store, {}, async (url) => {
    submitted.push(url);
    return decision;
  });
  assert.equal(second.reviewed, 2);
  assert.equal(second.pending, 0);
  assert.ok(!submitted.includes(result(1).url));
  assert.equal(
    (
      await reviewJobs(root, store, {}, async () => {
        throw new Error('must not run');
      })
    ).reviewed,
    0,
  );
  const reopened = new SqliteStore(join(root, 'jobs.sqlite'));
  try {
    assert.equal(reopened.pendingCount(), 0);
  } finally {
    reopened.close();
  }
});

test('limit is total jobs; hidden jobs and completed decisions are preserved', async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1), result(2), result(3)]);
  store.setReviewStatus('1', 'hidden');
  assert.equal(
    (await reviewJobs(root, store, { limit: 1 }, async () => decision))
      .reviewed,
    1,
  );
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.listReviewJobs('hidden')[0].eligibility, 'pending');
  await assert.rejects(reviewJobs(root, store, { limit: -1 }), /Invalid batch/);
});

test('lock prevents overlap and releases after invalid decisions', async (t) => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, '.run-lock'));
  await assert.rejects(reviewJobs(root, store), /Another run/);
  await rm(join(root, '.run-lock'), { recursive: true });
  store.saveResults([result(1)]);
  const failed = await reviewJobs(root, store, {}, async () => ({
    ...decision,
    eligibility: 'deleted',
  }));
  assert.equal(failed.pending, 1);
  assert.match(failed.failures.join(' '), /Invalid review/);
  assert.equal(
    (await reviewJobs(root, store, {}, async () => decision)).reviewed,
    1,
  );
});

test('URL validation and batch-scoped writes reject unsafe inputs and overwrites', async (t) => {
  const { store } = await fixture(t);
  assert.equal(
    jobUrl('https://boards.greenhouse.io/example/jobs/1?tracking=x'),
    result(1).url,
  );
  for (const url of [
    'https://evil.test/example/jobs/1',
    'https://jobs.lever.co/example',
    'https://u:p@job-boards.greenhouse.io/example/jobs/1',
  ])
    assert.equal(jobUrl(url), null);
  store.saveResults([result(1)]);
  const batch = 'a'.repeat(32);
  store.claimBatch(batch);
  assert.throws(
    () => store.review(1, 'b'.repeat(32), 'eligible', 'ok'),
    /not pending/,
  );
  store.review(1, batch, 'eligible', 'Worldwide');
  assert.throws(
    () => store.review(1, batch, 'ineligible', 'overwrite'),
    /not pending/,
  );
});

test('SIGINT cancels the request, preserves pending work, and releases the lock', async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1)]);
  const outcome = await reviewJobs(root, store, {}, async (_, { signal }) => {
    process.emit('SIGINT');
    signal.throwIfAborted();
    return decision;
  });
  assert.equal(outcome.pending, 1);
  assert.match(outcome.failures.join(' '), /interrupted/);
  assert.equal(
    (await reviewJobs(root, store, {}, async () => decision)).reviewed,
    1,
  );
});

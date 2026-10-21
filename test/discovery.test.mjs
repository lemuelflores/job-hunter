import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQueryMatrix } from '../dist/discovery/google.js';
import { startFetchWorker } from '../dist/discovery/worker.js';
import { loadProfile } from '../dist/profile.js';
import { SqliteStore } from '../dist/sqlite.js';

const profile = await loadProfile();
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  snippet: undefined,
  position: undefined,
  query: buildQueryMatrix(profile)[0].query,
});

function fixture(t, suppliedProfile = profile) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  const key = process.env.AUTOM_API_KEY;
  process.env.AUTOM_API_KEY = 'test';
  t.after(() => {
    if (key === undefined) delete process.env.AUTOM_API_KEY;
    else process.env.AUTOM_API_KEY = key;
  });
  const scheduled = [];
  const outcomes = [];
  t.mock.method(console, 'log', (message) =>
    outcomes.push(JSON.parse(message)),
  );
  let run;
  const worker = { close() {} };
  const started = startFetchWorker(
    store,
    {
      async scheduleListing(actualStore, id) {
        assert.equal(actualStore, store);
        scheduled.push(id);
      },
    },
    {
      startWorker(callback) {
        run = callback;
        return worker;
      },
    },
    suppliedProfile,
  );
  assert.equal(started, worker);
  return { store, run, scheduled, outcomes };
}

function mockResults(t, results) {
  return t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      organic_results: results.map(({ url, title }) => ({ link: url, title })),
    }),
  );
}

test('fetch worker uses the supplied profile without a country override', async (t) => {
  const supplied = {
    location: 'Germany',
    searchLocation: ['Germany', 'Berlin', 'Europe', 'worldwide'],
    title: [
      { fullstack: ['full stack'], backend: [], frontend: [], web: [] },
      { developer: [], engineer: [] },
    ],
    skills: [{ Laravel: [], Vue: [], TypeScript: [] }],
  };
  const { run } = fixture(t, supplied);
  const search = mockResults(t, []);
  assert.equal(search.mock.calls.length, 0);
  await run();
  assert.equal(search.mock.calls.length, 1);
  const [url, options] = search.mock.calls[0].arguments;
  assert.equal(
    url.searchParams.get('query'),
    buildQueryMatrix(supplied)[0].query,
  );
  assert.equal(url.searchParams.has('gl'), false);
  assert.equal(options.headers['x-api-key'], 'test');
});

test('fetch deduplicates results and schedules only discovered unfinished listings', async (t) => {
  const { store, run, scheduled, outcomes } = fixture(t);
  store.saveResults([result(4)]);
  mockResults(t, [result(1), result(1), result(5)]);
  await run();
  assert.deepEqual(outcomes, [{ added: 1, pending: 5, failures: [] }]);
  assert.deepEqual(scheduled, [1, 5]);
});

test('fetch validates and canonicalizes URLs before persistence and scheduling', async (t) => {
  const { store, run, scheduled, outcomes } = fixture(t);
  store.saveListingText(2, 'Saved text');
  store.review(2, 'eligible', 'Worldwide');
  store.reviewStack(2, {
    status: 'match',
    reason: 'Laravel',
    evidence: 'Laravel',
  });
  const before = store.getJob(2);
  const saved = [];
  const saveResults = store.saveResults.bind(store);
  store.saveResults = (results) => {
    saved.push(...results);
    return saveResults(results);
  };
  const alias = (id) => ({
    ...result(id),
    url: `https://boards.greenhouse.io/example/jobs/${id}?source=google#top`,
  });
  mockResults(t, [
    alias(1),
    alias(2),
    alias(5),
    result(5),
    { ...result(6), url: 'https://evil.test/example/jobs/6' },
    { ...result(7), url: 'https://jobs.lever.co/example' },
  ]);
  await run();
  assert.deepEqual(saved, [result(1), result(2), result(5), result(5)]);
  assert.deepEqual(outcomes, [{ added: 1, pending: 3, failures: [] }]);
  assert.deepEqual(scheduled, [1, 4]);
  assert.equal(store.listReviewJobs('active').length, 4);
  const { last_seen: _beforeSeen, ...original } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(2);
  assert.deepEqual(after, original);
});

test('discovery saves and schedules completed search pages before failing delivery', async (t) => {
  const { store, run, scheduled, outcomes } = fixture(t);
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.searchParams.get('page') === '1'
      ? Response.json({
          organic_results: [
            { title: 'Engineer', link: result(5).url, snippet: 'Valid text' },
            { title: 'Developer', link: result(6).url, snippet: 42 },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : new Response('Unavailable', { status: 503 }),
  );
  await assert.rejects(run(), (error) => {
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].added, 2);
    assert.equal(outcomes[0].failures.length, 1);
    assert.match(outcomes[0].failures[0], /503/);
    assert.equal(error.message, outcomes[0].failures[0]);
    assert.deepEqual(scheduled, [4, 5]);
    return true;
  });
  assert.equal(store.getJob(4).snippet, 'Valid text');
  assert.equal(store.getJob(5).snippet, '');
});

test('discovery deduplicates UUID casing without changing board casing or saved decisions', async (t) => {
  const { store, run, outcomes } = fixture(t);
  const uuid = '12345678-abcd-abcd-abcd-123456789abc';
  const url = `https://jobs.ashbyhq.com/Example/${uuid}`;
  const saved = { ...result(1), url };
  mockResults(t, [
    saved,
    { ...saved, url: url.replace(uuid, uuid.toUpperCase()) },
  ]);
  await run();
  assert.equal(outcomes[0].added, 1);
  store.saveListingText(4, 'Saved listing');
  store.review(4, 'eligible', 'Saved decision');
  const before = store.getJob(4);
  await run();
  assert.equal(outcomes[1].added, 0);
  assert.equal(store.getJob(4).url, url);
  assert.equal(store.getJob(4).reason, before.reason);
  assert.equal(store.getJob(4).listing_text, before.listing_text);
});

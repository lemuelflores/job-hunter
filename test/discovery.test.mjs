import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJobs } from '../dist/discovery/discover-jobs.js';
import { buildQueryMatrix } from '../dist/discovery/google.js';
import { loadProfile } from '../dist/profile.js';
import { SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical listing results.
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});

test('fetch forwards explicit and default profile queries without a country override', async (t) => {
  // Arrange: isolate discovery and supply a profile distinct from the root configuration.
  const store = fixture(t);
  const profile = {
    location: 'Germany',
    searchLocation: ['Germany', 'Berlin', 'Europe', 'worldwide'],
    title: [
      { fullstack: ['full stack'], backend: [], frontend: [], web: [] },
      { developer: [], engineer: [] },
    ],
    skills: [{ Laravel: [], Vue: [], TypeScript: [] }],
  };
  for (const supplied of [profile, undefined]) {
    // Arrange: determine the expected explicit or default discovery scope.
    const expected = supplied ?? (await loadProfile());
    const calls = [];
    // Act: discover jobs without real search requests.
    await fetchJobs(
      store,
      async (queries, options) => {
        calls.push({ queries, options });
        return { results: [], failures: [] };
      },
      supplied,
      async () => {},
    );
    // Assert: discovery forwards precisely the profile query without a country override.
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].queries,
      buildQueryMatrix(expected).map(({ query }) => query),
    );
    assert.equal(calls[0].options.country, undefined);
  }
});

// Arrange: seed three pending listings in an isolated store with automatic cleanup.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

test('fetch deduplicates one profile query and schedules only discovered unfinished listings', async (t) => {
  // Arrange: include an existing listing outside the next discovery response.
  const store = fixture(t);
  store.saveResults([result(4)]);
  const scheduled = [];
  // Act: discover duplicate and new listings, recording scheduled IDs.
  const outcome = await fetchJobs(
    store,
    async (queries, options) => {
      // Assert: discovery receives one profile query and the expected result limit.
      assert.equal(queries.length, 1);
      assert.equal(options.num, 100);
      return {
        results: [result(1), result(1), result(5)],
        failures: [{ query: 'bad', error: 'timeout' }],
      };
    },
    undefined,
    async (ids) => scheduled.push(...ids),
  );
  // Assert: only newly discovered unfinished listings are scheduled.
  assert.deepEqual(outcome, {
    added: 1,
    pending: 5,
    failures: ['bad: timeout'],
  });
  assert.deepEqual(scheduled, [1, 5]);
});

test('fetch validates and canonicalizes URLs before persistence and scheduling', async (t) => {
  // Arrange: keep one completed listing and capture the persistence boundary.
  const store = fixture(t);
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
  const scheduled = [];
  const alias = (id) => ({
    ...result(id),
    url: `https://boards.greenhouse.io/example/jobs/${id}?source=google#top`,
  });
  // Act: discover tracked aliases, duplicates, and unsupported listing URLs.
  const outcome = await fetchJobs(
    store,
    async () => ({
      results: [
        alias(1),
        alias(2),
        alias(5),
        result(5),
        { ...result(6), url: 'https://evil.test/example/jobs/6' },
        { ...result(7), url: 'https://jobs.lever.co/example' },
      ],
      failures: [],
    }),
    undefined,
    async (ids) => scheduled.push(...ids),
  );
  // Assert: only canonical, accepted results reach SQLite, retaining their metadata.
  assert.deepEqual(saved, [result(1), result(2), result(5), result(5)]);
  assert.deepEqual(outcome, { added: 1, pending: 3, failures: [] });
  assert.deepEqual(scheduled, [1, 4]);
  assert.equal(store.listReviewJobs('active').length, 4);
  const { last_seen: _beforeSeen, ...original } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(2);
  assert.deepEqual(after, original);
});

test('discovery saves and schedules completed search pages despite a later failure', async (t) => {
  const store = fixture(t);
  const key = process.env.AUTOM_API_KEY;
  process.env.AUTOM_API_KEY = 'test';
  t.after(() => {
    if (key === undefined) delete process.env.AUTOM_API_KEY;
    else process.env.AUTOM_API_KEY = key;
  });
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
  const scheduled = [];
  const outcome = await fetchJobs(store, undefined, undefined, async (ids) => {
    scheduled.push(...ids);
  });
  assert.equal(outcome.added, 2);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0], /503/);
  assert.deepEqual(scheduled, [4, 5]);
  assert.equal(store.getJob(4).snippet, 'Valid text');
  assert.equal(store.getJob(5).snippet, '');
});

test('discovery deduplicates UUID casing without changing board casing or saved decisions', async (t) => {
  const store = fixture(t);
  const uuid = '12345678-abcd-abcd-abcd-123456789abc';
  const url = `https://jobs.ashbyhq.com/Example/${uuid}`;
  const saved = { ...result(1), url };
  const search = async () => ({
    results: [saved, { ...saved, url: url.replace(uuid, uuid.toUpperCase()) }],
    failures: [],
  });
  assert.equal(
    (await fetchJobs(store, search, undefined, async () => {})).added,
    1,
  );
  store.saveListingText(4, 'Saved listing');
  store.review(4, 'eligible', 'Saved decision');
  const before = store.getJob(4);
  assert.equal(
    (await fetchJobs(store, search, undefined, async () => {})).added,
    0,
  );
  assert.equal(store.getJob(4).url, url);
  assert.equal(store.getJob(4).reason, before.reason);
  assert.equal(store.getJob(4).listing_text, before.listing_text);
});

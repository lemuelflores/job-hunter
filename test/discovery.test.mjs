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

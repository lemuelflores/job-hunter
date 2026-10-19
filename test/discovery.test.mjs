import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJobs } from '../dist/discovery/discover-jobs.js';
import { SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical listing results.
const result = (id) => ({
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

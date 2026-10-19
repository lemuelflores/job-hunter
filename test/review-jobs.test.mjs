import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { SqliteStore } from '../dist/sqlite.js';

// Shared Arrange: use real selection/state queries without running stage processors.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults(
    [1, 2, 3].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  return store;
}
const idleQueues = {
  scheduleListing: async () => {},
  syncFailures: async () => {},
};

test('review limits selection to active unfinished listings and reports remaining work', async (t) => {
  // Arrange: hide the first listing and make scheduled work finish immediately.
  const store = fixture(t);
  store.setReviewStatus('1', 'hidden');
  const scheduled = [];
  const queues = {
    ...idleQueues,
    scheduleListing: async (_, id) => {
      scheduled.push(id);
      store.saveListingText(id, 'Saved listing');
      store.review(id, 'eligible', 'Worldwide');
      store.reviewStack(id, {
        status: 'match',
        reason: 'Laravel',
        evidence: 'Laravel',
      });
    },
  };
  // Act: review one active listing.
  const outcome = await reviewJobs(store, queues, 1);
  // Assert: only the first active listing is scheduled and counted as reviewed.
  assert.deepEqual(scheduled, [2]);
  assert.deepEqual(outcome, { reviewed: 1, pending: 1, failures: [] });
});

test('review rejects an invalid limit before scheduling work', async (t) => {
  // Arrange: forbid scheduling for an invalid request.
  const store = fixture(t);
  const queues = {
    ...idleQueues,
    scheduleListing: async () => assert.fail('invalid limit scheduled work'),
  };
  // Act / Assert: reject the invalid limit.
  await assert.rejects(reviewJobs(store, queues, 0), /Invalid review limit/);
});

test('cancelling review waiting preserves saved decisions', async (t) => {
  // Arrange: leave stack pending on a listing with saved text and location.
  const store = fixture(t);
  store.saveListingText(1, 'Saved listing');
  store.review(1, 'eligible', 'Worldwide');
  const saved = store.getJob(1);
  const stages = store.stages(1);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  // Act / Assert: propagate cancellation from the waiting loop.
  await assert.rejects(
    reviewJobs(store, idleQueues, 1, controller.signal),
    /cancelled/,
  );
  // Assert: cancellation does not reset results or processing state.
  assert.deepEqual(store.getJob(1), saved);
  assert.deepEqual(store.stages(1), stages);
});

test('review reports an exhausted crawl with its listing and cause', async (t) => {
  // Arrange: mark the selected listing's crawl as exhausted.
  const store = fixture(t);
  store.failStage(1, 'crawl', 'offline', true);
  // Act: collect its review outcome without running processors.
  const outcome = await reviewJobs(store, idleQueues, 1);
  // Assert: a failed crawl ends waiting and is not counted as reviewed.
  assert.deepEqual(outcome.failures, ['Job 1 crawl: offline']);
  assert.equal(outcome.reviewed, 0);
});

test('review reports a listing hidden while its work is scheduled', async (t) => {
  // Arrange: hide the selected listing during scheduling.
  const store = fixture(t);
  const queues = {
    ...idleQueues,
    scheduleListing: async () => store.setReviewStatus('1', 'hidden'),
  };
  // Act: wait for the selected listing's outcome.
  const outcome = await reviewJobs(store, queues, 1);
  // Assert: stop waiting when the listing is no longer active.
  assert.deepEqual(outcome.failures, ['Job 1: no longer active']);
});

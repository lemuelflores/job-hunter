import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageError } from '../dist/review/firecrawl.js';
import { processStage } from '../dist/review/worker.js';
import { SqliteStore } from '../dist/sqlite.js';

test('terminal crawl failures stop both evaluations; temporary errors remain repairable', async (t) => {
  // Arrange: seed listings whose crawls produce terminal and temporary page errors.
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults(
    [1, 2].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  let calls = 0;
  const services = {
    scrapeListing: async (url) => {
      throw new PageError(
        url.endsWith('/1') ? 404 : 500,
        'Page removed or unavailable',
      );
    },
    reviewJob: async () => assert.fail('terminal crawl'),
    reviewStack: async () => assert.fail('terminal crawl'),
  };
  const enqueue = async () => {
    calls++;
  };
  // Act: crawl the listing that returns a terminal page error.
  await processStage(store, 'crawl', 1, enqueue, services);
  // Assert: the listing records the error and blocks both assessments.
  assert.equal(store.getJob(1).eligibility, 'error');
  assert.match(store.getJob(1).reason, /Page removed/);
  assert.deepEqual(
    store.stages(1).map((s) => s.state),
    ['terminal', 'blocked', 'blocked'],
  );
  // Act: redeliver every stage for the terminal listing.
  for (const stage of ['crawl', 'location', 'stack'])
    await processStage(store, stage, 1, enqueue, services);
  // Assert: terminal redelivery never enqueues assessments.
  assert.equal(calls, 0);
  // Act / Assert: a temporary page error propagates for retry handling.
  await assert.rejects(
    processStage(store, 'crawl', 2, enqueue, services),
    PageError,
  );
  // Act: record a temporary failure while retries remain available.
  store.failStage(2, 'crawl', 'Temporary page error', false);
  // Assert: the crawl remains pending for retry.
  assert.equal(store.stages(2)[0].state, 'pending');
  // Act: exhaust retries for the temporary failure.
  store.failStage(2, 'crawl', 'Temporary page error', true);
  // Assert: only the crawl fails; the listing remains undecided.
  assert.equal(store.stages(2)[0].state, 'failed');
  assert.equal(store.getJob(2).eligibility, 'pending');
  // Act / Assert: terminal stages cannot be manually reset as failed stages.
  assert.throws(() => store.resetStage(1, 'crawl'), /not failed/);
  // Arrange: reset the retryable failed crawl.
  store.resetStage(2, 'crawl');
  // Act: retry with a healthy listing response.
  await processStage(store, 'crawl', 2, enqueue, {
    ...services,
    scrapeListing: async () => 'Recovered',
  });
  // Assert: recovery checkpoints text and enqueues both assessments.
  assert.equal(calls, 2);
  assert.equal(store.getJob(2).listing_text, 'Recovered');
});

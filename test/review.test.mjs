import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { processStage } from '../dist/review/worker.js';
import { SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical listing results.
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
const decision = {
  eligibility: 'eligible',
  reason: 'Worldwide',
  evidence: 'Anywhere',
  company: 'Example',
  location: 'Remote',
  title: 'Engineer',
};
const stack = { status: 'match', reason: 'Laravel role', evidence: 'Laravel' };
const services = {
  scrapeListing: async () => 'Worldwide Laravel',
  reviewJob: async () => decision,
  reviewStack: async () => stack,
};

// Arrange: seed three pending listings in an isolated store with automatic cleanup.
function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

test('crawl checkpoints text before fan-out; redelivery and duplicate assessments preserve saved data', async (t) => {
  // Arrange: record scrapes and verify the checkpoint inside the enqueue callback.
  const store = fixture(t);
  let scrapes = 0;
  const enqueued = [];
  const enqueue = async (stage, id) => {
    // Assert: listing text is durable before either assessment is enqueued.
    assert.equal(store.getJob(id).listing_text, 'Worldwide Laravel');
    enqueued.push(stage);
  };
  const fake = {
    ...services,
    scrapeListing: async () => {
      scrapes++;
      return 'Worldwide Laravel';
    },
  };
  // Act: crawl the listing and fan out both assessments.
  await processStage(store, 'crawl', 1, enqueue, fake);
  // Assert: both assessment stages are scheduled.
  assert.deepEqual(enqueued, ['location', 'stack']);
  // Act: redeliver the crawl stage.
  await processStage(store, 'crawl', 1, enqueue, fake);
  // Assert: redelivery reuses the saved listing text.
  assert.equal(scrapes, 1);
  // Act: complete stack assessment before location assessment.
  await processStage(store, 'stack', 1, enqueue, fake);
  // Assert: stack completion leaves location pending.
  assert.equal(store.getJob(1).eligibility, 'pending');
  // Arrange: finish location assessment and forbid subsequent service calls.
  await processStage(store, 'location', 1, enqueue, fake);
  const saved = JSON.stringify(store.getJob(1));
  const forbidden = {
    scrapeListing: async () => assert.fail('rescrape'),
    reviewJob: async () => assert.fail('location overwrite'),
    reviewStack: async () => assert.fail('stack overwrite'),
  };
  // Act: redeliver every completed stage.
  for (const stage of ['crawl', 'location', 'stack'])
    await processStage(store, stage, 1, enqueue, forbidden);
  // Assert: saved decisions remain unchanged and listing text stays out of summaries.
  assert.equal(JSON.stringify(store.getJob(1)), saved);
  assert.equal('listing_text' in store.listReviewJobs('active')[0], false);
});

test('each reviewer receives its listing URL and saved text and saves to the same listing', async (t) => {
  // Arrange: use separate listings to detect crossed URLs, text, or saved decisions.
  const store = fixture(t);
  for (const id of [1, 2]) {
    // Arrange: give this listing distinct text and reviewer reasons.
    const url = result(id).url;
    const text = `Listing ${id}: Worldwide Laravel`;
    const fake = {
      scrapeListing: async (receivedUrl) => {
        // Assert: crawling receives this listing's URL.
        assert.equal(receivedUrl, url);
        return text;
      },
      reviewJob: async (receivedUrl, options) => {
        // Assert: location assessment receives this listing's URL and saved text.
        assert.equal(receivedUrl, url);
        assert.equal(options.listingText, text);
        return { ...decision, reason: `Location ${id}` };
      },
      reviewStack: async (receivedUrl, options) => {
        // Assert: stack assessment receives this listing's URL and saved text.
        assert.equal(receivedUrl, url);
        assert.equal(options.listingText, text);
        return { ...stack, reason: `Stack ${id}` };
      },
    };
    // Act: run this listing through every pipeline stage.
    for (const stage of ['crawl', 'location', 'stack'])
      await processStage(store, stage, id, async () => {}, fake);
  }
  for (const id of [1, 2]) {
    // Assert: each listing retains its own location and stack decisions.
    assert.equal(store.getJob(id).reason, `Location ${id}`);
    assert.equal(store.getJob(id).stack_reason, `Stack ${id}`);
  }
});

test('crawl redelivery repairs a partial fan-out without scraping or reassessing saved results', async (t) => {
  // Arrange: record deliveries while allowing the first assessment to finish.
  const store = fixture(t);
  const delivered = [];
  // Act / Assert: interrupt fan-out when the stack enqueue fails.
  await assert.rejects(
    processStage(
      store,
      'crawl',
      1,
      async (stage, id) => {
        if (stage === 'stack') throw new Error('Redis unavailable');
        delivered.push(stage);
        await processStage(store, stage, id, async () => {}, services);
      },
      services,
    ),
    /Redis unavailable/,
  );
  // Assert: the successful location delivery and listing checkpoint survive.
  assert.deepEqual(delivered, ['location']);
  assert.equal(store.getJob(1).listing_text, 'Worldwide Laravel');
  // Arrange: retain the saved decision for comparison after redelivery.
  const saved = store.getJob(1);
  // Act: redeliver crawl with rescraping forbidden and working fan-out.
  await processStage(
    store,
    'crawl',
    1,
    async (stage, id) => {
      delivered.push(stage);
      await processStage(store, stage, id, async () => {}, services);
    },
    {
      ...services,
      scrapeListing: async () => assert.fail('saved text must be reused'),
    },
  );
  // Assert: only the missing assessment runs and the location decision is preserved.
  assert.deepEqual(delivered, ['location', 'stack']);
  assert.equal(store.getJob(1).reason, saved.reason);
  assert.equal(store.getJob(1).stack_status, 'match');
});

test('review bounds listing selection, shares scheduling, reports failures and cancels waiting without resetting results', async (t) => {
  // Arrange: hide the first listing and complete any selected listing through shared stages.
  const store = fixture(t);
  store.setReviewStatus('1', 'hidden');
  const queues = {
    scheduleListing: async (_, id) => {
      // Assert: bounded review selects the first active listing only.
      assert.equal(id, 2);
      for (const stage of ['crawl', 'location', 'stack'])
        await processStage(store, stage, id, async () => {}, services);
    },
    syncFailures: async () => {},
  };
  // Act / Assert: review one active listing and report remaining work.
  assert.deepEqual(await reviewJobs(store, queues, 1), {
    reviewed: 1,
    pending: 1,
    failures: [],
  });
  // Act / Assert: reject an invalid listing limit.
  await assert.rejects(reviewJobs(store, queues, 0), /Invalid review limit/);
  // Arrange: cancel before waiting for another review.
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  // Act / Assert: propagate cancellation without resetting saved results.
  await assert.rejects(
    reviewJobs(
      store,
      { scheduleListing: async () => {}, syncFailures: async () => {} },
      1,
      controller.signal,
    ),
    /cancelled/,
  );
  // Arrange: persist an exhausted crawl failure for the remaining listing.
  store.failStage(3, 'crawl', 'offline', true);
  // Act: collect failures for the selected listing.
  const failed = await reviewJobs(
    store,
    { scheduleListing: async () => {}, syncFailures: async () => {} },
    1,
  );
  // Assert: the stage failure includes its listing and cause.
  assert.deepEqual(failed.failures, ['Job 3 crawl: offline']);
  // Arrange: reset the stage so the listing can be selected again.
  store.resetStage(3, 'crawl');
  // Act: hide the listing while its review is being scheduled.
  const hidden = await reviewJobs(
    store,
    {
      scheduleListing: async () => store.setReviewStatus('3', 'hidden'),
      syncFailures: async () => {},
    },
    1,
  );
  // Assert: review reports that the selected listing is no longer active.
  assert.deepEqual(hidden.failures, ['Job 3: no longer active']);
});

const rejectedDecision = {
  ...decision,
  eligibility: 'ineligible',
  reason: 'US only',
  evidence: 'US residents',
  location: 'US',
};
const independentServices = {
  ...services,
  reviewJob: async () => rejectedDecision,
};
const enqueue = async () => {};

test('location rejection does not block technology assessment; either evaluation can fail while the other succeeds', async (t) => {
  // Arrange: exercise each assessment as the independently failing stage.
  for (const failing of ['location', 'stack']) {
    // Arrange: checkpoint listing text and make only this assessment fail.
    const store = fixture(t);
    await processStage(store, 'crawl', 1, enqueue, independentServices);
    const fake = {
      ...independentServices,
      [failing === 'location' ? 'reviewJob' : 'reviewStack']: async () => {
        throw new Error('temporary');
      },
    };
    // Act / Assert: surface the selected assessment's temporary failure.
    await assert.rejects(
      processStage(store, failing, 1, enqueue, fake),
      /temporary/,
    );
    // Arrange: persist the failure and select the unaffected assessment.
    store.failStage(1, failing, 'temporary', true);
    const other = failing === 'location' ? 'stack' : 'location';
    // Act: run the other assessment despite the failed stage.
    await processStage(store, other, 1, enqueue, fake);
    // Assert: the unaffected assessment completes independently.
    assert.equal(
      store.stages(1).find((s) => s.stage === other).state,
      'complete',
    );
    // Arrange: snapshot the successful assessment before resetting the failure.
    const before = store.getJob(1);
    store.resetStage(1, failing);
    // Act: retry the failed assessment with healthy independentServices.
    await processStage(store, failing, 1, enqueue, independentServices);
    // Assert: retry preserves the other decision and completes both assessments.
    const after = store.getJob(1);
    for (const key of other === 'location'
      ? ['eligibility', 'reason', 'evidence', 'company', 'location', 'title']
      : ['stack_status', 'stack_reason', 'stack_evidence'])
      assert.equal(after[key], before[key]);
    assert.equal(after.eligibility, 'ineligible');
    assert.equal(after.stack_status, 'match');
  }
});

test('an unfinished location request does not block technology assessment or crawling the next listing', async (t) => {
  // Arrange: create a gate that holds the first location assessment open.
  const store = fixture(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  // Act: start the blocked location request, then process unrelated work.
  await processStage(store, 'crawl', 1, enqueue, independentServices);
  const location = processStage(store, 'location', 1, enqueue, {
    ...independentServices,
    reviewJob: async () => {
      await blocked;
      return rejectedDecision;
    },
  });
  await processStage(store, 'stack', 1, enqueue, independentServices);
  await processStage(store, 'crawl', 2, enqueue, independentServices);
  // Assert: stack and the next crawl finish while location remains pending.
  assert.equal(store.getJob(1).eligibility, 'pending');
  assert.equal(store.getJob(1).stack_status, 'match');
  assert.ok(store.getJob(2).listing_text);
  // Cleanup: release and drain the outstanding location assessment.
  release();
  await location;
});

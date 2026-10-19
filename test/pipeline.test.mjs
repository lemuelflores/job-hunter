import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJobs } from '../dist/discovery/discover-jobs.js';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { processStage } from '../dist/review/worker.js';
import { jobUrl, SqliteStore } from '../dist/sqlite.js';

// Arrange: share canonical discovery results and deterministic reviewer responses.
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

test('URL validation accepts supported listing shapes and strips tracking', () => {
  // Arrange: use a valid UUID listing identifier across supported hosts.
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const host of [
    'jobs.ashbyhq.com',
    'jobs.lever.co',
    'jobs.eu.lever.co',
  ]) {
    // Arrange: construct this provider's canonical listing URL.
    const url = `https://${host}/example/${uuid}`;
    // Act / Assert: strip tracking while retaining the canonical listing URL.
    assert.equal(jobUrl(`${url}?utm_source=google#details`), url);
  }
  // Act / Assert: normalize both Greenhouse hosts to the canonical URL.
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io'])
    assert.equal(
      jobUrl(`https://${host}/example/jobs/1?tracking=x`),
      result(1).url,
    );
  // Arrange: cover unsupported hosts, paths, protocols, credentials, and encodings.
  // Act / Assert: reject each unsafe or unsupported listing URL.
  for (const url of [
    'https://evil.test/example/jobs/1',
    'https://jobs.lever.co/example',
    `https://jobs.lever.co/example/${uuid}/apply`,
    `http://jobs.lever.co/example/${uuid}`,
    `https://jobs.lever.co:8443/example/${uuid}`,
    'https://u:p@job-boards.greenhouse.io/example/jobs/1',
    `https://jobs.lever.co/ex%2Fample/${uuid}`,
    `https://jobs.lever.co/ex%5Cample/${uuid}`,
    `https://jobs.lever.co/ex%ZZample/${uuid}`,
  ])
    assert.equal(jobUrl(url), null, url);
});

test('rediscovery deduplicates canonical URLs without resetting saved decisions', (t) => {
  // Arrange: save both decisions and hide the listing before rediscovery.
  const store = fixture(t);
  store.saveListingText(1, 'Saved text');
  store.review(1, 'eligible', 'Saved location');
  store.reviewStack(1, stack);
  store.setReviewStatus('1', 'hidden');
  const before = store.getJob(1);
  // Act / Assert: rediscover tracked and canonical aliases without inserting a row.
  assert.equal(
    store.saveResults([
      {
        ...result(1),
        url: 'https://boards.greenhouse.io/example/jobs/1?source=google#top',
      },
      result(1),
    ]),
    0,
  );
  // Assert: only last_seen may change; saved decisions and completion remain intact.
  const { last_seen: _beforeSeen, ...saved } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(1);
  assert.deepEqual(after, saved);
  assert.equal(store.listReviewJobs('hidden').length, 1);
  assert.ok(store.stages(1).every((stage) => stage.state === 'complete'));
});

test('invalid results and completed-stage guards reject unsafe writes', (t) => {
  // Arrange: start with pending stages.
  const store = fixture(t);
  // Act / Assert: reject invalid location decisions and empty listing text.
  assert.throws(() => store.review(1, 'deleted', 'invalid'), /Invalid review/);
  assert.throws(() => store.review(1, 'eligible', ''), /Invalid review/);
  assert.throws(() => store.saveListingText(1, ''), /Invalid listing/);
  // Arrange: complete a valid location assessment.
  store.saveListingText(1, 'text');
  store.review(1, 'eligible', 'Worldwide');
  // Act / Assert: reject overwriting the completed location assessment.
  assert.throws(
    () => store.review(1, 'ineligible', 'overwrite'),
    /not pending/,
  );
  // Assert: the original eligibility survives the rejected overwrite.
  assert.equal(store.getJob(1).eligibility, 'eligible');
  // Act / Assert: reject each unsupported stack result status.
  for (const status of ['deleted', 'pending'])
    assert.throws(
      () => store.reviewStack(1, { ...stack, status }),
      /Invalid stack/,
    );
  // Arrange: complete a valid stack assessment.
  store.reviewStack(1, stack);
  // Act / Assert: completed stack assessments cannot be overwritten either.
  assert.throws(() => store.reviewStack(1, stack), /not pending/);
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

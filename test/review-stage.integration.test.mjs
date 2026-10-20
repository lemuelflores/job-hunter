import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAshbyListing } from '../dist/review/ashby.js';
import { crawlJob } from '../dist/review/crawl.js';
import { PageError } from '../dist/review/extraction.js';
import { checkLocation } from '../dist/review/location-check.js';
import { checkTech } from '../dist/review/tech-check.js';
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

// Exercise stage workflows directly; real worker delivery is covered by the Redis suite.
function runStage(
  store,
  stage,
  id,
  enqueue,
  { scrapeListing, reviewJob, reviewStack },
) {
  const job = store.getJob(id);
  return {
    crawl: () => crawlJob(store, job, enqueue, scrapeListing),
    location: () => checkLocation(store, job, reviewJob),
    stack: () => checkTech(store, job, reviewStack),
  }[stage]();
}

test('Ashby API text reaches both assessments and redelivery reuses the saved input', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const id = '12345678-abcd-abcd-abcd-123456789abc';
  const url = `https://jobs.ashbyhq.com/example/${id}`;
  store.saveResults([{ ...result(1), url }]);
  let requests = 0;
  const inputs = {};
  const fake = {
    scrapeListing: (url, options) =>
      fetchAshbyListing(url, {
        ...options,
        fetch: async () => {
          requests++;
          return Response.json({
            jobs: [
              {
                jobUrl: url,
                title: 'Engineer',
                location: 'Manila',
                descriptionPlain: 'Laravel services',
              },
            ],
          });
        },
      }),
    reviewJob: async (receivedUrl, options) => {
      assert.equal(receivedUrl, url);
      inputs.location = options.listingText;
      return decision;
    },
    reviewStack: async (receivedUrl, options) => {
      assert.equal(receivedUrl, url);
      inputs.stack = options.listingText;
      return stack;
    },
  };
  const enqueued = [];
  const enqueue = async (stage) => enqueued.push(stage);
  await runStage(store, 'crawl', 1, enqueue, fake);
  assert.deepEqual(enqueued, ['location', 'stack']);
  for (const stage of ['crawl', 'location', 'stack', 'crawl'])
    await runStage(store, stage, 1, enqueue, fake);
  assert.equal(requests, 1);
  assert.deepEqual(inputs, {
    location: store.getJob(1).listing_text,
    stack: store.getJob(1).listing_text,
  });
  assert.ok(store.stages(1).every(({ state }) => state === 'complete'));
});

test('missing Ashby UUID blocks assessments; invalid API responses leave crawl pending', async (t) => {
  for (const body of [
    { jobs: [] },
    { jobs: null },
    { jobs: [{ id: 'undocumented-id-only' }] },
  ]) {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    store.saveResults([
      {
        ...result(1),
        url: 'https://jobs.ashbyhq.com/example/12345678-abcd-abcd-abcd-123456789abc',
      },
    ]);
    const fake = {
      ...services,
      scrapeListing: (url, options) =>
        fetchAshbyListing(url, {
          ...options,
          fetch: async () => Response.json(body),
        }),
    };
    const run = () =>
      runStage(
        store,
        'crawl',
        1,
        async () => assert.fail('unexpected enqueue'),
        fake,
      );
    if (body.jobs === null || body.jobs.length) {
      await assert.rejects(run(), /Invalid Ashby/);
      assert.ok(store.stages(1).every(({ state }) => state === 'pending'));
    } else {
      await run();
      assert.equal(
        store.stages(1).find(({ stage }) => stage === 'crawl').state,
        'terminal',
      );
      assert.ok(
        store
          .stages(1)
          .filter(({ stage }) => stage !== 'crawl')
          .every(({ state }) => state === 'blocked'),
      );
      await run();
    }
    assert.equal(store.getJob(1).listing_text, null);
  }
});

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
  await runStage(store, 'crawl', 1, enqueue, fake);
  // Assert: both assessment stages are scheduled.
  assert.deepEqual(enqueued, ['location', 'stack']);
  // Act: redeliver the crawl stage.
  await runStage(store, 'crawl', 1, enqueue, fake);
  // Assert: redelivery reuses the saved listing text.
  assert.equal(scrapes, 1);
  // Act: complete stack assessment before location assessment.
  await runStage(store, 'stack', 1, enqueue, fake);
  // Assert: stack completion leaves location pending.
  assert.equal(store.getJob(1).eligibility, 'pending');
  // Arrange: finish location assessment and forbid subsequent service calls.
  await runStage(store, 'location', 1, enqueue, fake);
  const saved = JSON.stringify(store.getJob(1));
  const forbidden = {
    scrapeListing: async () => assert.fail('rescrape'),
    reviewJob: async () => assert.fail('location overwrite'),
    reviewStack: async () => assert.fail('stack overwrite'),
  };
  // Act: redeliver every completed stage.
  for (const stage of ['crawl', 'location', 'stack'])
    await runStage(store, stage, 1, enqueue, forbidden);
  // Assert: saved decisions remain unchanged.
  assert.equal(JSON.stringify(store.getJob(1)), saved);
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
      await runStage(store, stage, id, async () => {}, fake);
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
    runStage(
      store,
      'crawl',
      1,
      async (stage, id) => {
        if (stage === 'stack') throw new Error('Redis unavailable');
        delivered.push(stage);
        await runStage(store, stage, id, async () => {}, services);
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
  await runStage(
    store,
    'crawl',
    1,
    async (stage, id) => {
      delivered.push(stage);
      await runStage(store, stage, id, async () => {}, services);
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

test('permanent crawl errors save the page error and block both assessments', async (t) => {
  // Arrange: extraction encounters a removed listing.
  const store = fixture(t);
  const enqueued = [];
  const fake = {
    ...services,
    scrapeListing: async () => {
      throw new PageError(404, 'Page removed');
    },
  };
  // Act: process the crawl stage.
  await runStage(
    store,
    'crawl',
    1,
    async (stage) => enqueued.push(stage),
    fake,
  );
  // Assert: the page error is saved and no dependent work is scheduled.
  assert.equal(store.getJob(1).eligibility, 'error');
  assert.match(store.getJob(1).reason, /Page removed/);
  assert.deepEqual(
    store.stages(1).map(({ stage, state }) => ({ stage, state })),
    [
      { stage: 'crawl', state: 'terminal' },
      { stage: 'location', state: 'blocked' },
      { stage: 'stack', state: 'blocked' },
    ],
  );
  assert.deepEqual(enqueued, []);
});

test('redelivering terminal or blocked stages makes no external calls', async (t) => {
  // Arrange: persist the terminal state and forbid external calls and enqueues.
  const store = fixture(t);
  store.terminalCrawl(1, 'Gone');
  const saved = store.getJob(1);
  const forbidden = {
    scrapeListing: async () => assert.fail('unexpected scrape'),
    reviewJob: async () => assert.fail('unexpected location assessment'),
    reviewStack: async () => assert.fail('unexpected stack assessment'),
  };
  // Act: redeliver each stage.
  for (const stage of ['crawl', 'location', 'stack'])
    await runStage(
      store,
      stage,
      1,
      async () => assert.fail('unexpected enqueue'),
      forbidden,
    );
  // Assert: saved data remains unchanged.
  assert.deepEqual(store.getJob(1), saved);
});

test('temporary crawl errors propagate to queue retry handling', async (t) => {
  // Arrange: extraction encounters a temporary server error.
  const store = fixture(t);
  const error = new PageError(500, 'Page unavailable');
  const saved = store.getJob(1);
  const fake = {
    ...services,
    scrapeListing: async () => {
      throw error;
    },
  };
  // Act / Assert: the processor propagates the original error without enqueueing.
  await assert.rejects(
    runStage(
      store,
      'crawl',
      1,
      async () => assert.fail('unexpected enqueue'),
      fake,
    ),
    error,
  );
  // Assert: retry bookkeeping is left to queue delivery, not the processor.
  assert.deepEqual(store.getJob(1), saved);
  assert.ok(store.stages(1).every(({ state }) => state === 'pending'));
});

test('a reset crawl checkpoints recovered text and schedules both assessments', async (t) => {
  // Arrange: reset a previously exhausted crawl before delivering it again.
  const store = fixture(t);
  store.failStage(1, 'crawl', 'Temporary page error', true);
  store.resetStage(1, 'crawl');
  const enqueued = [];
  // Act: deliver the healthy crawl.
  await runStage(
    store,
    'crawl',
    1,
    async (stage, id) => enqueued.push({ stage, id }),
    {
      ...services,
      scrapeListing: async () => 'Recovered',
    },
  );
  // Assert: recovered text is saved and both dependent stages are scheduled.
  assert.equal(store.getJob(1).listing_text, 'Recovered');
  assert.deepEqual(enqueued, [
    { stage: 'location', id: 1 },
    { stage: 'stack', id: 1 },
  ]);
});

test('location rejection does not block technology assessment; either evaluation can fail while the other succeeds', async (t) => {
  // Arrange: exercise each assessment as the independently failing stage.
  for (const failing of ['location', 'stack']) {
    // Arrange: checkpoint listing text and make only this assessment fail.
    const store = fixture(t);
    await runStage(store, 'crawl', 1, enqueue, independentServices);
    const fake = {
      ...independentServices,
      [failing === 'location' ? 'reviewJob' : 'reviewStack']: async () => {
        throw new Error('temporary');
      },
    };
    // Act / Assert: surface the selected assessment's temporary failure.
    await assert.rejects(
      runStage(store, failing, 1, enqueue, fake),
      /temporary/,
    );
    // Arrange: persist the failure and select the unaffected assessment.
    store.failStage(1, failing, 'temporary', true);
    const other = failing === 'location' ? 'stack' : 'location';
    // Act: run the other assessment despite the failed stage.
    await runStage(store, other, 1, enqueue, fake);
    // Assert: the unaffected assessment completes independently.
    assert.equal(
      store.stages(1).find((s) => s.stage === other).state,
      'complete',
    );
    // Arrange: snapshot the successful assessment before resetting the failure.
    const before = store.getJob(1);
    store.resetStage(1, failing);
    // Act: retry the failed assessment with healthy independentServices.
    await runStage(store, failing, 1, enqueue, independentServices);
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
  // Arrange: checkpoint text before starting the blocked location request.
  await runStage(store, 'crawl', 1, enqueue, independentServices);
  const location = runStage(store, 'location', 1, enqueue, {
    ...independentServices,
    reviewJob: async () => {
      await blocked;
      return rejectedDecision;
    },
  });
  try {
    // Act: process unrelated stages while location remains blocked.
    await runStage(store, 'stack', 1, enqueue, independentServices);
    await runStage(store, 'crawl', 2, enqueue, independentServices);
    // Assert: stack and the next crawl finish while location remains pending.
    assert.equal(store.getJob(1).eligibility, 'pending');
    assert.equal(store.getJob(1).stack_status, 'match');
    assert.ok(store.getJob(2).listing_text);
  } finally {
    // Cleanup: release and drain the assessment even when an assertion fails.
    release();
    await location;
  }
});

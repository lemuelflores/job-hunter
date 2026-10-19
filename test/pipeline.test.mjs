import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJobs } from '../dist/discovery/discover-jobs.js';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { processStage } from '../dist/review/worker.js';
import { jobUrl, SqliteStore } from '../dist/sqlite.js';

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

function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2), result(3)]);
  return store;
}

test('fetch deduplicates one profile query and schedules only discovered unfinished listings', async (t) => {
  const store = fixture(t);
  store.saveResults([result(4)]);
  const scheduled = [];
  const outcome = await fetchJobs(
    store,
    async (queries, options) => {
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
  assert.deepEqual(outcome, {
    added: 1,
    pending: 5,
    failures: ['bad: timeout'],
  });
  assert.deepEqual(scheduled, [1, 5]);
});

test('crawl checkpoints text before fan-out; redelivery and duplicate assessments preserve saved data', async (t) => {
  const store = fixture(t);
  let scrapes = 0;
  const enqueued = [];
  const enqueue = async (stage, id) => {
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
  await processStage(store, 'crawl', 1, enqueue, fake);
  assert.deepEqual(enqueued, ['location', 'stack']);
  await processStage(store, 'crawl', 1, enqueue, fake);
  assert.equal(scrapes, 1);
  await processStage(store, 'stack', 1, enqueue, fake);
  assert.equal(store.getJob(1).eligibility, 'pending');
  await processStage(store, 'location', 1, enqueue, fake);
  const saved = JSON.stringify(store.getJob(1));
  const forbidden = {
    scrapeListing: async () => assert.fail('rescrape'),
    reviewJob: async () => assert.fail('location overwrite'),
    reviewStack: async () => assert.fail('stack overwrite'),
  };
  for (const stage of ['crawl', 'location', 'stack'])
    await processStage(store, stage, 1, enqueue, forbidden);
  assert.equal(JSON.stringify(store.getJob(1)), saved);
  assert.equal('listing_text' in store.listReviewJobs('active')[0], false);
});

test('each reviewer receives its listing URL and saved text and saves to the same listing', async (t) => {
  const store = fixture(t);
  for (const id of [1, 2]) {
    const url = result(id).url;
    const text = `Listing ${id}: Worldwide Laravel`;
    const fake = {
      scrapeListing: async (receivedUrl) => {
        assert.equal(receivedUrl, url);
        return text;
      },
      reviewJob: async (receivedUrl, options) => {
        assert.equal(receivedUrl, url);
        assert.equal(options.listingText, text);
        return { ...decision, reason: `Location ${id}` };
      },
      reviewStack: async (receivedUrl, options) => {
        assert.equal(receivedUrl, url);
        assert.equal(options.listingText, text);
        return { ...stack, reason: `Stack ${id}` };
      },
    };
    for (const stage of ['crawl', 'location', 'stack'])
      await processStage(store, stage, id, async () => {}, fake);
  }
  for (const id of [1, 2]) {
    assert.equal(store.getJob(id).reason, `Location ${id}`);
    assert.equal(store.getJob(id).stack_reason, `Stack ${id}`);
  }
});

test('crawl redelivery repairs a partial fan-out without scraping or reassessing saved results', async (t) => {
  const store = fixture(t);
  const delivered = [];
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
  assert.deepEqual(delivered, ['location']);
  assert.equal(store.getJob(1).listing_text, 'Worldwide Laravel');
  const saved = store.getJob(1);
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
  assert.deepEqual(delivered, ['location', 'stack']);
  assert.equal(store.getJob(1).reason, saved.reason);
  assert.equal(store.getJob(1).stack_status, 'match');
});

test('URL validation accepts supported listing shapes and strips tracking', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const host of [
    'jobs.ashbyhq.com',
    'jobs.lever.co',
    'jobs.eu.lever.co',
  ]) {
    const url = `https://${host}/example/${uuid}`;
    assert.equal(jobUrl(`${url}?utm_source=google#details`), url);
  }
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io'])
    assert.equal(
      jobUrl(`https://${host}/example/jobs/1?tracking=x`),
      result(1).url,
    );
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
  const store = fixture(t);
  store.saveListingText(1, 'Saved text');
  store.review(1, 'eligible', 'Saved location');
  store.reviewStack(1, stack);
  store.setReviewStatus('1', 'hidden');
  const before = store.getJob(1);
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
  const { last_seen: _beforeSeen, ...saved } = before;
  const { last_seen: _afterSeen, ...after } = store.getJob(1);
  assert.deepEqual(after, saved);
  assert.equal(store.listReviewJobs('hidden').length, 1);
  assert.ok(store.stages(1).every((stage) => stage.state === 'complete'));
});

test('invalid results and completed-stage guards reject unsafe writes', (t) => {
  const store = fixture(t);
  assert.throws(() => store.review(1, 'deleted', 'invalid'), /Invalid review/);
  assert.throws(() => store.review(1, 'eligible', ''), /Invalid review/);
  assert.throws(() => store.saveListingText(1, ''), /Invalid listing/);
  store.saveListingText(1, 'text');
  store.review(1, 'eligible', 'Worldwide');
  assert.throws(
    () => store.review(1, 'ineligible', 'overwrite'),
    /not pending/,
  );
  assert.equal(store.getJob(1).eligibility, 'eligible');
  for (const status of ['deleted', 'pending'])
    assert.throws(
      () => store.reviewStack(1, { ...stack, status }),
      /Invalid stack/,
    );
  store.reviewStack(1, stack);
  assert.throws(() => store.reviewStack(1, stack), /not pending/);
});

test('review bounds listing selection, shares scheduling, reports failures and cancels waiting without resetting results', async (t) => {
  const store = fixture(t);
  store.setReviewStatus('1', 'hidden');
  const queues = {
    scheduleListing: async (_, id) => {
      assert.equal(id, 2);
      for (const stage of ['crawl', 'location', 'stack'])
        await processStage(store, stage, id, async () => {}, services);
    },
    syncFailures: async () => {},
  };
  assert.deepEqual(await reviewJobs(store, queues, 1), {
    reviewed: 1,
    pending: 1,
    failures: [],
  });
  await assert.rejects(reviewJobs(store, queues, 0), /Invalid review limit/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    reviewJobs(
      store,
      { scheduleListing: async () => {}, syncFailures: async () => {} },
      1,
      controller.signal,
    ),
    /cancelled/,
  );
  store.failStage(3, 'crawl', 'offline', true);
  const failed = await reviewJobs(
    store,
    { scheduleListing: async () => {}, syncFailures: async () => {} },
    1,
  );
  assert.deepEqual(failed.failures, ['Job 3 crawl: offline']);
  store.resetStage(3, 'crawl');
  const hidden = await reviewJobs(
    store,
    {
      scheduleListing: async () => store.setReviewStatus('3', 'hidden'),
      syncFailures: async () => {},
    },
    1,
  );
  assert.deepEqual(hidden.failures, ['Job 3: no longer active']);
});

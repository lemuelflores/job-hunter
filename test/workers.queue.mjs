import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FetchQueue, ReviewQueues } from '../dist/bullmq.js';
import { main } from '../dist/cli.js';
import { startFetchScheduler } from '../dist/discovery/scheduler.js';
import { startFetchWorker } from '../dist/discovery/worker.js';
import { loadProfile } from '../dist/profile.js';
import { startCrawlWorker } from '../dist/review/crawl.js';
import { createLlm } from '../dist/review/llm/index.js';
import { startLocationWorker } from '../dist/review/location-check.js';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { startTechWorker } from '../dist/review/tech-check.js';
import { SqliteStore } from '../dist/sqlite.js';
import {
  externalFixture,
  profile,
  result,
  stack,
  stages,
  stream,
} from './fixtures/workflow.mjs';

async function until(check, description = 'worker outcome') {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}

test('queue dispatch, recovery and process lifecycle', {
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-workers-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const redisUrl = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380';
  const run = randomUUID();
  let sequence = 0;

  function fixture(t, respond) {
    const prefix = `workers-${run}-${++sequence}`;
    const path = join(root, `${prefix}.sqlite`);
    const store = new SqliteStore(path);
    const queues = new ReviewQueues(redisUrl, prefix);
    const fetches = new FetchQueue(redisUrl, prefix);
    // Exhaust delivery once; test our bookkeeping, not BullMQ's retry engine.
    for (const queue of Object.values(queues.queues))
      queue.jobsOpts.attempts = 1;
    const external = externalFixture(t, respond);
    const workers = [];
    const runningStages = new Set();
    const releases = [];
    const output = [];
    t.mock.method(console, 'log', (message) =>
      output.push(JSON.parse(message)),
    );
    const f = {
      path,
      store,
      queues,
      fetches,
      ...external,
      releases,
      output,
      async start(selected = stages) {
        for (const stage of selected) runningStages.add(stage);
        if (selected.includes('fetch'))
          workers.push(await startFetchWorker(store, queues, fetches, profile));
        if (selected.includes('crawl'))
          workers.push(await startCrawlWorker(store, queues));
        if (selected.includes('location'))
          workers.push(
            await startLocationWorker(store, queues, external.reviewLocation),
          );
        if (selected.includes('stack'))
          workers.push(
            await startTechWorker(store, queues, external.reviewStack),
          );
      },
      async idle() {
        await until(async () => {
          const counts = await Promise.all(
            [fetches.queue, ...Object.values(queues.queues)]
              .filter((queue) => runningStages.has(queue.name))
              .map((queue) => queue.getJobCounts('active', 'wait', 'delayed')),
          );
          return counts.every((c) => !c.active && !c.wait && !c.delayed);
        }, 'workers to settle');
      },
      async stop() {
        await Promise.all(workers.splice(0).map((worker) => worker.close()));
        runningStages.clear();
      },
    };
    t.after(async () => {
      for (const release of releases) await release();
      await f.stop();
      await Promise.all(
        [fetches.queue, ...Object.values(queues.queues)].map((queue) =>
          queue.obliterate(),
        ),
      );
      await Promise.all([queues.close(), fetches.close()]);
      store.close();
    });
    return f;
  }

  await t.test(
    'partial discovery dispatches saved results before recording a failed run',
    async (t) => {
      const f = fixture(t, ({ url }) =>
        url.hostname === 'api.autom.dev'
          ? url.searchParams.get('page') === '1'
            ? Response.json({
                organic_results: [{ link: result(1).url, title: 'Engineer' }],
                pagination: { has_next_page: true, next: 2 },
              })
            : new Response('Unavailable', { status: 503 })
          : undefined,
      );
      await f.start(['fetch', ...stages]);
      const task = await f.fetches.enqueue();
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
      assert.match((await f.fetches.queue.getJob(task.id)).failedReason, /503/);
      assert.equal(
        f.requests.filter(({ url }) => url.hostname === 'api.autom.dev').length,
        2,
      );
      assert.equal(f.output[0].added, 1);
      assert.match(f.output[0].failures[0], /503/);
    },
  );

  await t.test(
    'exhausted assessment delivery, repair and explicit retry preserve the other result',
    async (t) => {
      let offline = true;
      const f = fixture(t, ({ body }) =>
        body?.text.format.name === 'job_review' && offline
          ? new Response('Model unavailable', { status: 503 })
          : undefined,
      );
      f.store.saveResults([result(1)]);
      await f.start();
      await f.queues.enqueue('crawl', 1);
      await f.idle();
      assert.equal(f.store.stages(1)[1].state, 'failed');
      assert.match(f.store.stages(1)[1].error, /503/);
      assert.equal(f.store.stages(1)[2].state, 'complete');
      const saved = f.store.getJob(1);
      const count = f.requests.length;
      const outcome = await reviewJobs(f.store, f.queues, 1);
      assert.equal(outcome.reviewed, 0);
      assert.match(outcome.failures[0], /Job 1 location:/);
      await f.queues.repair(f.store);
      await f.idle();
      assert.equal(f.requests.length, count);
      offline = false;
      await f.queues.retry(f.store, 'location', 1);
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
      assert.equal(f.store.stages(1)[1].generation, 1);
      assert.equal(f.store.getJob(1).listing_text, saved.listing_text);
      assert.equal(f.store.getJob(1).stack_reason, saved.stack_reason);
      assert.equal(f.requests.length, count + 1);
    },
  );

  await t.test(
    'a failed-task read captured before reset cannot fail the new retry generation',
    async (t) => {
      const f = fixture(t, () => new Response('', { status: 503 }));
      f.store.saveResults([result(1)]);
      await f.start(['crawl']);
      await f.queues.enqueue('crawl', 1);
      await f.idle();
      assert.equal(f.store.stages(1)[0].state, 'failed');
      const reading = f.queues.syncFailures(f.store, 1);
      f.store.resetStage(1, 'crawl');
      await reading;
      assert.equal(f.store.stages(1)[0].state, 'pending');
      assert.equal(f.store.stages(1)[0].generation, 1);
      assert.equal(f.store.stages(1)[0].error, '');
    },
  );

  await t.test(
    'repair restores delivery after retry resets SQLite but enqueue fails',
    async (t) => {
      const f = fixture(t);
      f.store.saveResults([result(1)]);
      f.store.failStage(1, 'crawl', 'Previous outage', true);
      f.queues.queues.crawl.jobsOpts.sizeLimit = 1;
      await assert.rejects(f.queues.retry(f.store, 'crawl', 1), /size/i);
      assert.equal(f.store.stages(1)[0].state, 'pending');
      assert.equal(f.store.stages(1)[0].generation, 1);
      delete f.queues.queues.crawl.jobsOpts.sizeLimit;
      await f.start();
      await f.queues.repair(f.store);
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
    },
  );

  await t.test(
    'crawl redelivery repairs partial fan-out without repeating saved work',
    async (t) => {
      const f = fixture(t);
      f.store.saveResults([result(1)]);
      f.store.saveListingText(1, 'Checkpoint Laravel');
      f.store.review(1, 'eligible', 'Saved location');
      await f.start();
      await f.queues.enqueue('crawl', 1);
      await f.idle();
      assert.equal(f.store.getJob(1).listing_text, 'Checkpoint Laravel');
      assert.equal(f.store.getJob(1).reason, 'Saved location');
      assert.equal(f.store.getJob(1).stack_status, 'match');
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].body.text.format.name, 'job_stack_review');
    },
  );

  await t.test(
    'review selects active unfinished listings, respects its limit and repair finishes the remainder',
    async (t) => {
      const f = fixture(t);
      f.store.saveResults([result(1), result(2), result(3)]);
      f.store.setReviewStatus('1', 'hidden');
      f.store.saveListingText(2, 'Checkpoint Laravel');
      await f.start();
      assert.deepEqual(await reviewJobs(f.store, f.queues, 1), {
        reviewed: 1,
        pending: 1,
        failures: [],
      });
      await f.idle();
      assert.equal(f.store.getJob(2).listing_text, 'Checkpoint Laravel');
      assert.equal(f.store.getJob(3).listing_text, null);
      await f.queues.repair(f.store);
      await f.idle();
      assert.equal(f.store.pendingCount(), 0);
      assert.equal(f.store.getJob(1).listing_text, null);
      await assert.rejects(
        reviewJobs(f.store, f.queues, 0),
        /Invalid review limit/,
      );
      f.store.setReviewStatus('1', 'active');
      await f.queues.repair(f.store);
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
    },
  );

  await t.test(
    'cancelling review waiting preserves decisions; hiding work ends waiting',
    async (t) => {
      const f = fixture(t);
      f.store.saveResults([result(1)]);
      f.store.saveListingText(1, 'Checkpoint Laravel');
      f.store.review(1, 'eligible', 'Saved location');
      const saved = f.store.getJob(1);
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await assert.rejects(
        reviewJobs(f.store, f.queues, 1, controller.signal),
        /cancelled/,
      );
      assert.deepEqual(f.store.getJob(1), saved);
      const waiting = reviewJobs(f.store, f.queues, 1);
      await until(async () =>
        Boolean(await f.queues.queues.stack.getJob('listing-1')),
      );
      f.store.setReviewStatus('1', 'hidden');
      assert.deepEqual((await waiting).failures, ['Job 1: no longer active']);
    },
  );

  await t.test(
    'CLI starts all consumers with the shared profile and drains active work',
    async (t) => {
      const gate = Promise.withResolvers();
      let stackStarted = false;
      const f = fixture(t, async ({ url, body }) => {
        if (url.hostname === 'api.autom.dev')
          return Response.json({
            organic_results: [1, 2].map((id) => ({
              link: result(id).url,
              title: 'Engineer',
            })),
          });
        if (body?.text.format.name !== 'job_stack_review') return;
        stackStarted = true;
        await gate.promise;
        return stream(stack);
      });
      f.releases.push(gate.resolve);
      const observer = new SqliteStore(f.path);
      const signals = ['SIGINT', 'SIGTERM'].map((event) =>
        process.listeners(event),
      );
      let running;
      t.after(async () => {
        gate.resolve();
        if (running) {
          process.emit('SIGTERM');
          await running;
        }
        observer.close();
      });
      let stopped = false;
      running = main(['workers'], {
        loadProfile: async () => profile,
        createLlm: () => f.llm,
        createStore: async () => new SqliteStore(f.path),
        createReviewQueues: async () =>
          new ReviewQueues(redisUrl, f.queues.prefix),
        createFetchQueue: async () =>
          new FetchQueue(redisUrl, f.fetches.prefix),
      }).then((code) => {
        stopped = true;
        return code;
      });
      f.releases.push(async () => {
        if (running) {
          process.emit('SIGTERM');
          await running;
        }
      });
      await f.fetches.enqueue();
      await until(() => stackStarted);
      await until(
        () =>
          observer.getJob(2).listing_text !== null &&
          observer.getJob(1).eligibility === 'ineligible',
      );
      process.emit('SIGTERM');
      await delay(30);
      assert.equal(stopped, false);
      gate.resolve();
      assert.equal(await running, 0);
      running = undefined;
      assert.equal(observer.getJob(1).stack_status, 'match');
      assert.match(
        f.requests.find(({ body }) => body?.text.format.name === 'job_review')
          .body.instructions,
        /Germany/,
      );
      assert.ok(
        f.requests
          .find(({ body }) => body?.text.format.name === 'job_stack_review')
          .body.input[0].content[0].text.includes(
            JSON.stringify(profile.skills),
          ),
      );
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((event) => process.listeners(event)),
        signals,
      );
    },
  );

  for (const failing of ['fetch', 'location']) {
    await t.test(`CLI cleans up when ${failing} cannot start`, async (t) => {
      const f = fixture(t);
      const queues = new ReviewQueues(redisUrl, f.queues.prefix);
      const fetches = new FetchQueue(redisUrl, f.fetches.prefix);
      const unavailable =
        failing === 'fetch' ? fetches.queue : queues.queues.location;
      await unavailable.waitUntilReady();
      await unavailable.close();
      const errors = [];
      t.mock.method(console, 'error', (message) =>
        errors.push(String(message)),
      );
      assert.equal(
        await main(['workers'], {
          loadProfile: async () => profile,
          createLlm: () => f.llm,
          createStore: async () => new SqliteStore(f.path),
          createReviewQueues: async () => queues,
          createFetchQueue: async () => fetches,
        }),
        1,
      );
      assert.ok(errors.some((message) => /closed/i.test(message)));
      assert.deepEqual(await f.fetches.queue.getWorkers(), []);
      assert.deepEqual(await f.queues.queues.crawl.getWorkers(), []);
    });
  }

  await t.test(
    'CLI fetch only enqueues without loading profile, store or model',
    async (t) => {
      const f = fixture(t);
      assert.equal(
        await main(['fetch'], {
          createFetchQueue: async () =>
            new FetchQueue(redisUrl, f.fetches.prefix),
          loadProfile: () => loadProfile(join(root, 'missing-profile.ts')),
          createStore: async () =>
            new SqliteStore(join(root, 'missing-directory', 'jobs.sqlite')),
          createLlm: () => createLlm('unsupported'),
        }),
        0,
      );
      assert.equal(f.requests.length, 0);
      assert.ok(f.output[0].queued);
      await f.start(['fetch']);
      await f.idle();
      assert.deepEqual(f.output[1], { added: 0, pending: 0, failures: [] });
    },
  );

  await t.test(
    'CLI scheduler enqueues without a working profile, database or model',
    async (t) => {
      const f = fixture(t);
      const previous = process.env.FETCH_CRON;
      process.env.FETCH_CRON = '* * * * * *';
      t.after(() => {
        if (previous === undefined) delete process.env.FETCH_CRON;
        else process.env.FETCH_CRON = previous;
      });
      const running = main(['scheduler'], {
        createFetchQueue: async () =>
          new FetchQueue(redisUrl, f.fetches.prefix),
        loadProfile: () => loadProfile(join(root, 'missing-profile.ts')),
        createStore: async () =>
          new SqliteStore(join(root, 'missing-directory', 'jobs.sqlite')),
        createLlm: () => createLlm('unsupported'),
      });
      try {
        await until(
          async () => (await f.fetches.queue.getWaitingCount()) > 0,
          'CLI cron delivery',
        );
      } finally {
        process.emit('SIGTERM');
        assert.equal(await running, 0);
      }
      assert.equal(f.requests.length, 0);
      await f.start(['fetch']);
      await f.idle();
      assert.deepEqual(f.output, [{ added: 0, pending: 0, failures: [] }]);
    },
  );

  await t.test(
    'scheduler validates cron and delivers discovery only after a tick',
    async (t) => {
      const f = fixture(t);
      await assert.rejects(
        startFetchScheduler(f.fetches, 'invalid'),
        /FETCH_CRON/,
      );
      const scheduled = startFetchScheduler(f.fetches, '* * * * * *');
      try {
        assert.equal(await f.fetches.queue.getWaitingCount(), 0);
        await until(
          async () => (await f.fetches.queue.getWaitingCount()) > 0,
          'cron tick',
        );
      } finally {
        process.emit('SIGTERM');
        await scheduled;
      }
      await f.start(['fetch']);
      await f.idle();
      assert.deepEqual(f.output, [{ added: 0, pending: 0, failures: [] }]);
    },
  );

  await t.test(
    'scheduler continues after enqueue failures and stops cleanly',
    async (t) => {
      const f = fixture(t);
      f.fetches.queue.jobsOpts.sizeLimit = 1;
      const errors = [];
      t.mock.method(console, 'error', (...args) => errors.push(args));
      const scheduled = startFetchScheduler(f.fetches, '* * * * * *');
      try {
        await until(
          () =>
            errors.filter(
              ([message]) => message === '[scheduler] Enqueue failed:',
            ).length >= 2,
          'next tick after enqueue failure',
        );
      } finally {
        process.emit('SIGTERM');
        await scheduled;
      }
      assert.equal(f.requests.length, 0);
    },
  );
});

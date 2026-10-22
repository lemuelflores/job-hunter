import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscoveryQueue, ReviewQueues } from '../dist/bullmq.js';
import { startDiscoveryScheduler } from '../dist/discovery/scheduler.js';
import { main } from '../dist/entrypoints/cli.js';
import {
  startCrawlWorker,
  startFreehireWorker,
  startGoogleWorker,
  startLocationWorker,
  startTechWorker,
} from '../dist/entrypoints/workers.js';
import { createLlm } from '../dist/review/llm/index.js';
import { reviewJobs } from '../dist/review/review-jobs.js';
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
  const root = await mkdtemp(join(tmpdir(), 'job-workers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const redisUrl = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380';
  const run = randomUUID();
  let sequence = 0;

  function fixture(t, respond) {
    const prefix = `workers-${run}-${++sequence}`;
    const path = join(root, `${prefix}.sqlite`);
    const store = new SqliteStore(path);
    const queues = new ReviewQueues(redisUrl, prefix);
    const google = new DiscoveryQueue('google', redisUrl, prefix);
    const freehire = new DiscoveryQueue('freehire', redisUrl, prefix);
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
      google,
      freehire,
      ...external,
      releases,
      output,
      async start(selected = stages) {
        for (const stage of selected) {
          runningStages.add(stage);
          switch (stage) {
            case 'google':
              workers.push(
                await startGoogleWorker(store, queues, google, profile),
              );
              break;
            case 'freehire':
              workers.push(
                await startFreehireWorker(store, queues, freehire, {
                  ...profile.freehire,
                  enabled: true,
                }),
              );
              break;
            case 'crawl':
              workers.push(await startCrawlWorker(store, queues));
              break;
            case 'location':
              workers.push(
                await startLocationWorker(
                  store,
                  queues,
                  external.reviewLocation,
                ),
              );
              break;
            case 'stack':
              workers.push(
                await startTechWorker(store, queues, external.reviewStack),
              );
              break;
            default:
              assert.fail(`Unexpected stage: ${stage}`);
          }
        }
      },
      async idle() {
        await until(async () => {
          const counts = await Promise.all(
            [google.queue, freehire.queue, ...Object.values(queues.queues)]
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
        [google.queue, freehire.queue, ...Object.values(queues.queues)].map(
          (queue) => queue.obliterate(),
        ),
      );
      await Promise.all([queues.close(), google.close(), freehire.close()]);
      store.close();
    });
    return f;
  }

  await t.test(
    'delivery events distinguish terminal, skipped, retrying and exhausted work',
    async (t) => {
      const f = fixture(t, ({ url }) =>
        url.hostname === 'boards-api.greenhouse.io'
          ? new Response('', { status: 404 })
          : undefined,
      );
      f.store.saveResults([result(1), result(2)]);
      await f.start(['crawl']);
      await f.queues.enqueue('crawl', 1);
      await f.idle();
      assert.ok(f.output.some((event) => event.outcome === 'terminal_crawl'));
      await f.queues.enqueue('crawl', 1);
      await f.idle();
      assert.ok(
        f.output.some(
          (event) =>
            event.outcome === 'skipped' && event.stage_state === 'terminal',
        ),
      );
      await f.stop();
      const worker = await f.queues.startWorker(f.store, 'crawl', async () => {
        throw new Error('fixture delivery failure', {
          cause: new Error('fixture cause'),
        });
      });
      try {
        await f.queues.queues.crawl.add(
          'crawl',
          { id: 2 },
          {
            jobId: 'listing-2',
            attempts: 2,
            backoff: { type: 'fixed', delay: 10 },
          },
        );
        await until(async () =>
          (await f.queues.queues.crawl.getJob('listing-2'))
            ?.getState()
            .then((state) => state === 'failed'),
        );
        const ends = f.output.filter(
          (event) =>
            event.listing_id === 2 && event.event === 'delivery_finished',
        );
        assert.deepEqual(
          ends.map((event) => [
            event.outcome,
            event.attempt,
            event.attempt_limit,
          ]),
          [
            ['retrying', 1, 2],
            ['exhausted', 2, 2],
          ],
        );
        assert.equal(ends[0].stage_state, 'pending');
        assert.equal(ends[1].stage_state, 'failed');
        assert.equal(ends[1].error.cause.message, 'fixture cause');
      } finally {
        await worker.close();
      }
    },
  );

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
      await f.start(['google', ...stages]);
      const task = await f.google.enqueue();
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
      assert.match((await f.google.queue.getJob(task.id)).failedReason, /503/);
      assert.equal(
        f.requests.filter(({ url }) => url.hostname === 'api.autom.dev').length,
        2,
      );
      const end = f.output.find(
        (event) => event.outcome === 'discovery_partial_failure',
      );
      assert.equal(end.added, 1);
      assert.match(end.error.message, /503/);
      assert.equal(end.delivery_outcome, 'exhausted');
      assert.equal(end.delivery_id, task.id);
      assert.equal(end.attempt, 1);
      assert.equal(end.attempt_limit, 1);
      assert.ok(end.elapsed_ms >= 0);
      assert.ok(end.error.stack);
      for (const stage of stages) {
        const events = f.output.filter((event) => event.stage === stage);
        assert.equal(events.length, 2);
        assert.equal(events[0].event, 'delivery_started');
        assert.equal(events[1].outcome, 'checkpoint_saved');
        assert.equal(events[1].listing_id, 1);
        assert.equal(events[0].delivery_id, events[1].delivery_id);
      }
    },
  );

  await t.test(
    'Freehire source saves and dispatches both checks without extraction',
    async (t) => {
      const f = fixture(t, ({ url }) =>
        url.hostname === 'freehire.me'
          ? Response.json({
              data: [
                {
                  url: 'https://careers.example.com/1',
                  title: 'Engineer',
                  description: 'Full Freehire Laravel listing',
                },
              ],
              meta: { total: 1, limit: 100, offset: 0 },
            })
          : undefined,
      );
      await f.start(['google', 'freehire', ...stages]);
      const task = await f.freehire.enqueue();
      assert.equal(task.opts.deduplication.id, 'freehire');
      assert.equal((await f.google.enqueue()).opts.deduplication.id, 'google');
      await f.idle();
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
      assert.ok(
        f.store
          .getJob(1)
          .listing_text.endsWith('Full Freehire Laravel listing'),
      );
      assert.equal(
        f.requests.filter(
          ({ url }) => url.hostname === 'boards-api.greenhouse.io',
        ).length,
        0,
      );
      for (const queue of [f.google, f.freehire]) {
        assert.equal(queue.queue.jobsOpts.attempts, 1);
        assert.equal(await queue.queue.getGlobalConcurrency(), 1);
      }
      assert.ok(
        f.output.some(
          (outcome) => outcome.source === 'freehire' && outcome.added === 1,
        ),
      );
    },
  );

  await t.test(
    'Freehire dispatch gap is repairable without extraction or resetting failed crawls',
    async (t) => {
      const f = fixture(t, ({ url }) =>
        url.hostname === 'freehire.me'
          ? Response.json({
              data: [1, 2].map((id) => ({
                url: result(id).url,
                title: 'Engineer',
                description: 'Saved Freehire Laravel',
              })),
              meta: { total: 2, limit: 100, offset: 0 },
            })
          : undefined,
      );
      f.store.saveResults([result(2)]);
      f.store.failStage(1, 'crawl', 'Exhausted', true);
      f.queues.queues.location.jobsOpts.sizeLimit = 1;
      await f.start(['freehire']);
      const task = await f.freehire.enqueue();
      await f.idle();
      assert.match(
        (await f.freehire.queue.getJob(task.id)).failedReason,
        /size/i,
      );
      const imported = f.store
        .listReviewJobs('active')
        .find((job) => job.url === result(1).url);
      assert.ok(
        f.store
          .getJob(imported.id)
          .listing_text.endsWith('Saved Freehire Laravel'),
      );
      assert.equal(f.store.stages(1)[0].state, 'failed');
      delete f.queues.queues.location.jobsOpts.sizeLimit;
      await f.start(['location', 'stack']);
      await f.queues.repair(f.store);
      await f.idle();
      assert.ok(
        f.store.stages(imported.id).every(({ state }) => state === 'complete'),
      );
      assert.equal(
        f.requests.filter(({ url }) => url.hostname === 'freehire.me').length,
        1,
      );
    },
  );

  await t.test(
    'Freehire preserves completed pages and dispatches before a later page failure',
    async (t) => {
      const f = fixture(t, ({ url }) =>
        url.hostname === 'freehire.me'
          ? url.searchParams.get('offset') === '0'
            ? Response.json({
                data: [
                  {
                    url: result(1).url,
                    title: 'Engineer',
                    description: 'Freehire Laravel',
                  },
                ],
                meta: { total: 2, limit: 100, offset: 0 },
              })
            : new Response('', { status: 503 })
          : undefined,
      );
      await f.start(['freehire', 'location', 'stack']);
      const task = await f.freehire.enqueue();
      await f.idle();
      assert.match(
        (await f.freehire.queue.getJob(task.id)).failedReason,
        /503/,
      );
      assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
      assert.equal(f.output[0].source, 'freehire');
    },
  );

  await t.test(
    'manual source commands honor enabled without constructing unrelated dependencies',
    async (t) => {
      const f = fixture(t);
      const dependencies = {
        loadProfile: async () => profile,
        createDiscoveryQueue: async (source) => {
          assert.equal(source, 'freehire');
          return new DiscoveryQueue(source, redisUrl, f.freehire.prefix);
        },
        createStore: async () => assert.fail('database'),
        createLlm: () => assert.fail('model'),
      };
      t.mock.method(console, 'error', () => {});
      assert.equal(await main(['fetch', 'freehire'], dependencies), 1);
      assert.equal(await f.freehire.queue.getWaitingCount(), 0);
      assert.equal(
        await main(['fetch', 'freehire'], {
          ...dependencies,
          loadProfile: async () => ({
            ...profile,
            freehire: { ...profile.freehire, enabled: true },
          }),
        }),
        0,
      );
      assert.equal(await f.freehire.queue.getWaitingCount(), 1);
      assert.equal(f.requests.length, 0);
    },
  );

  await t.test(
    'independent schedules use source defaults and enabled queues only',
    async (t) => {
      const f = fixture(t);
      const logs = [];
      t.mock.method(console, 'error', (message) => logs.push(String(message)));
      const before = {
        google: process.env.GOOGLE_CRON,
        freehire: process.env.FREEHIRE_CRON,
      };
      delete process.env.GOOGLE_CRON;
      delete process.env.FREEHIRE_CRON;
      try {
        const running = startDiscoveryScheduler({
          google: f.google,
          freehire: f.freehire,
        });
        assert.ok(
          logs.includes('[scheduler] google scheduled 0 * * * * (UTC)'),
        );
        assert.ok(
          logs.includes('[scheduler] freehire scheduled */15 * * * * (UTC)'),
        );
        process.emit('SIGTERM');
        await running;
        logs.length = 0;
        const independent = startDiscoveryScheduler({
          google: f.google,
          freehire: f.freehire,
          googleCron: '0 0 1 1 *',
          freehireCron: '* * * * * *',
        });
        try {
          await until(
            async () => (await f.freehire.queue.getWaitingCount()) > 0,
          );
          assert.equal(await f.google.queue.getWaitingCount(), 0);
        } finally {
          process.emit('SIGTERM');
          await independent;
        }
        await assert.rejects(
          startDiscoveryScheduler({
            freehire: f.freehire,
            freehireCron: 'invalid',
          }),
          /FREEHIRE_CRON/,
        );
      } finally {
        if (before.google === undefined) delete process.env.GOOGLE_CRON;
        else process.env.GOOGLE_CRON = before.google;
        if (before.freehire === undefined) delete process.env.FREEHIRE_CRON;
        else process.env.FREEHIRE_CRON = before.freehire;
      }
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
        createDiscoveryQueue: async (source) =>
          new DiscoveryQueue(source, redisUrl, f.google.prefix),
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
      await f.google.enqueue();
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
      const locationRequest = f.requests.find(
        ({ body }) => body?.text.format.name === 'job_review',
      ).body;
      const stackRequest = f.requests.find(
        ({ body }) => body?.text.format.name === 'job_stack_review',
      ).body;
      assert.ok(
        locationRequest.instructions.includes(
          JSON.stringify(profile.review.location),
        ),
      );
      assert.ok(
        stackRequest.input[0].content[0].text.includes(
          JSON.stringify(profile.review.stack),
        ),
      );
      assert.ok(
        !locationRequest.input[0].content[0].text.includes(
          JSON.stringify(profile.review.stack),
        ),
      );
      assert.ok(
        !JSON.stringify(stackRequest).includes(profile.review.location),
      );
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((event) => process.listeners(event)),
        signals,
      );
    },
  );

  for (const failing of ['google', 'freehire', 'location']) {
    await t.test(`CLI cleans up when ${failing} cannot start`, async (t) => {
      const f = fixture(t);
      const queues = new ReviewQueues(redisUrl, f.queues.prefix);
      const google = new DiscoveryQueue('google', redisUrl, f.google.prefix);
      const freehire = new DiscoveryQueue(
        'freehire',
        redisUrl,
        f.google.prefix,
      );
      const unavailable =
        failing === 'google'
          ? google.queue
          : failing === 'freehire'
            ? freehire.queue
            : queues.queues.location;
      await unavailable.waitUntilReady();
      await unavailable.close();
      const errors = [];
      t.mock.method(console, 'error', (message) =>
        errors.push(String(message)),
      );
      assert.equal(
        await main(['workers'], {
          loadProfile: async () => ({
            ...profile,
            freehire: { ...profile.freehire, enabled: true },
          }),
          createLlm: () => f.llm,
          createStore: async () => new SqliteStore(f.path),
          createReviewQueues: async () => queues,
          createDiscoveryQueue: async (source) =>
            source === 'google' ? google : freehire,
        }),
        1,
      );
      assert.ok(errors.some((message) => /closed/i.test(message)));
      assert.deepEqual(await f.google.queue.getWorkers(), []);
      await Promise.all([google.close(), freehire.close()]);
      assert.deepEqual(await f.queues.queues.crawl.getWorkers(), []);
    });
  }

  await t.test(
    'CLI fetch google only enqueues without loading store or model',
    async (t) => {
      const f = fixture(t);
      assert.equal(
        await main(['fetch', 'google'], {
          createDiscoveryQueue: async (source) =>
            new DiscoveryQueue(source, redisUrl, f.google.prefix),
          loadProfile: async () => profile,
          createStore: async () =>
            new SqliteStore(join(root, 'missing-directory', 'jobs.sqlite')),
          createLlm: () => createLlm('unsupported'),
        }),
        0,
      );
      assert.equal(f.requests.length, 0);
      assert.ok(f.output[0].queued);
      await f.start(['google']);
      await f.idle();
      const end = f.output.find((event) => event.event === 'delivery_finished');
      assert.equal(end.source, 'google');
      assert.equal(end.outcome, 'discovery_complete');
      assert.equal(end.added, 0);
      assert.equal(end.pending, 0);
      assert.equal(end.failure_count, 0);
    },
  );

  await t.test(
    'CLI scheduler reads enablement without loading database or model',
    async (t) => {
      const f = fixture(t);
      const previous = process.env.GOOGLE_CRON;
      process.env.GOOGLE_CRON = '* * * * * *';
      t.after(() => {
        if (previous === undefined) delete process.env.GOOGLE_CRON;
        else process.env.GOOGLE_CRON = previous;
      });
      const running = main(['scheduler'], {
        createDiscoveryQueue: async (source) =>
          new DiscoveryQueue(source, redisUrl, f.google.prefix),
        loadProfile: async () => profile,
        createStore: async () =>
          new SqliteStore(join(root, 'missing-directory', 'jobs.sqlite')),
        createLlm: () => createLlm('unsupported'),
      });
      try {
        await until(
          async () => (await f.google.queue.getWaitingCount()) > 0,
          'CLI cron delivery',
        );
      } finally {
        process.emit('SIGTERM');
        assert.equal(await running, 0);
      }
      assert.equal(f.requests.length, 0);
      await f.start(['google']);
      await f.idle();
      assert.deepEqual(
        f.output.map((event) => event.event),
        ['delivery_started', 'delivery_finished'],
      );
      assert.equal(f.output[1].outcome, 'discovery_complete');
      assert.equal(f.output[1].added, 0);
      assert.equal(f.output[1].pending, 0);
      assert.equal(f.output[1].failure_count, 0);
    },
  );

  await t.test(
    'scheduler validates cron and delivers discovery only after a tick',
    async (t) => {
      const f = fixture(t);
      await assert.rejects(
        startDiscoveryScheduler({ google: f.google, googleCron: 'invalid' }),
        /GOOGLE_CRON/,
      );
      const scheduled = startDiscoveryScheduler({
        google: f.google,
        googleCron: '* * * * * *',
      });
      try {
        assert.equal(await f.google.queue.getWaitingCount(), 0);
        await until(
          async () => (await f.google.queue.getWaitingCount()) > 0,
          'cron tick',
        );
      } finally {
        process.emit('SIGTERM');
        await scheduled;
      }
      await f.start(['google']);
      await f.idle();
      assert.deepEqual(
        f.output.map((event) => event.event),
        ['delivery_started', 'delivery_finished'],
      );
      assert.equal(f.output[1].outcome, 'discovery_complete');
      assert.equal(f.output[1].added, 0);
      assert.equal(f.output[1].pending, 0);
      assert.equal(f.output[1].failure_count, 0);
    },
  );

  await t.test(
    'scheduler continues after enqueue failures and stops cleanly',
    async (t) => {
      const f = fixture(t);
      f.google.queue.jobsOpts.sizeLimit = 1;
      const errors = [];
      t.mock.method(console, 'error', (...args) => errors.push(args));
      const scheduled = startDiscoveryScheduler({
        google: f.google,
        googleCron: '* * * * * *',
      });
      try {
        await until(
          () =>
            errors.filter(
              ([message]) => message === '[scheduler] google enqueue failed:',
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

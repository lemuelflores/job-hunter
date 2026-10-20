import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JobQueues } from '../dist/bullmq.js';
import { reviewJobs } from '../dist/review/review-jobs.js';
import { startWorkers, workJobs } from '../dist/review/worker.js';
import { SqliteStore } from '../dist/sqlite.js';

// Shared fixtures keep external services deterministic while Redis delivery stays real.
const location = {
  eligibility: 'ineligible',
  reason: 'US only',
  evidence: 'US residents',
  company: 'Example',
  location: 'US',
  title: 'Engineer',
};
const stack = { status: 'match', reason: 'Laravel role', evidence: 'Laravel' };
const services = {
  reviewJob: async () => location,
  reviewStack: async () => stack,
};
const scrapeListing = async () => 'US Laravel role';
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
// A missed asynchronous checkpoint fails the test instead of waiting indefinitely.
async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for queue state');
    await delay(25);
  }
}

// Redis restarts can finish before every BullMQ connection has reconnected.
async function queuesReady(queues) {
  await until(async () => {
    try {
      await Promise.all(
        Object.values(queues.queues).map((queue) => queue.getJobCounts()),
      );
      return true;
    } catch {
      return false;
    }
  });
}

test('isolated Redis delivery, independent consumers, repair, retries and real restarts', {
  timeout: 180_000,
}, async (t) => {
  // Arrange: isolate SQLite, Redis persistence, and the published port from live services.
  // This suite intentionally fails if Docker or the Redis image is unavailable.
  const root = await mkdtemp('/tmp/opencode/job-queues-');
  const container = `job-hunter-test-${process.pid}-${Date.now()}`;
  const path = join(root, 'jobs.sqlite');
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const store = new SqliteStore(path);
  let queues,
    workers = [],
    child;
  t.after(async () => {
    child?.kill('SIGKILL');
    await Promise.all(workers.map((worker) => worker.close()));
    await queues?.close();
    store.close();
    try {
      docker('rm', '-f', container);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  docker(
    'run',
    '--detach',
    '--name',
    container,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--publish',
    `127.0.0.1:${port}:6379`,
    '--volume',
    `${root}:/data`,
    'redis:8.10.2-alpine',
    'redis-server',
    '--appendonly',
    'yes',
    '--appendfsync',
    'everysec',
    '--maxmemory-policy',
    'noeviction',
  );
  const url = `redis://127.0.0.1:${port}`;
  await until(() => docker('exec', container, 'redis-cli', 'ping') === 'PONG');
  queues = new JobQueues(url, 'isolated-job-hunter');
  for (const queue of Object.values(queues.queues))
    queue.defaultJobOptions.backoff.delay = 10;

  // Act: exercise delivery and recovery against the same disposable Redis instance.
  // Assert: each subtest checks its persisted results and queue checkpoints below.
  await t.test(
    'deduplicates tasks and lets stack/crawl progress while location is blocked',
    async () => {
      // Arrange: hold location processing open while counting crawl and stack calls.
      store.saveResults([result(1), result(2)]);
      let release,
        started = false,
        scrapes = 0,
        stackCalls = 0;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      workers = await startWorkers(
        store,
        queues,
        {
          ...services,
          reviewJob: async () => {
            started = true;
            await blocked;
            return location;
          },
          reviewStack: async () => {
            stackCalls++;
            return stack;
          },
        },
        async () => {
          scrapes++;
          return 'US Laravel role';
        },
      );
      try {
        // Act: enqueue duplicates and a second listing while location remains blocked.
        await Promise.all(
          Array.from({ length: 5 }, () => queues.enqueue('crawl', 1)),
        );
        await until(() => started && store.getJob(1).stack_status === 'match');
        await queues.enqueue('crawl', 2);
        await until(() => store.getJob(2).stack_status === 'match');
        // Assert: other stages progress once per listing without raising concurrency.
        assert.equal(store.getJob(1).eligibility, 'pending');
        assert.equal(scrapes, 2);
        assert.equal(stackCalls, 2);
        // Even an accidental second process cannot raise stage concurrency.
        assert.equal(await queues.queues.location.getGlobalConcurrency(), 1);
      } finally {
        release();
      }
      // Arrange: finish the first run and snapshot its saved result before redelivery.
      await until(() => store.pendingCount() === 0);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
      const saved = JSON.stringify(store.getJob(1));
      // Act: redeliver all completed stages to workers that reject duplicate service calls.
      for (const stage of ['crawl', 'location', 'stack'])
        await queues.enqueue(stage, 1);
      workers = await startWorkers(
        store,
        queues,
        {
          reviewJob: async () => assert.fail('duplicate location'),
          reviewStack: async () => assert.fail('duplicate stack'),
        },
        async () => assert.fail('duplicate scrape'),
      );
      await until(async () =>
        (
          await Promise.all(
            Object.values(queues.queues).map((q) =>
              q.getJobCounts('active', 'wait'),
            ),
          )
        ).every((c) => !c.active && !c.wait),
      );
      // Assert: redelivery leaves the saved listing untouched.
      assert.equal(JSON.stringify(store.getJob(1)), saved);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'failed location does not block stack; targeted retry resets BullMQ attempts without changing stack',
    async () => {
      // Arrange: make only the location service fail for a fresh listing.
      store.saveResults([result(3)]);
      let calls = 0;
      workers = await startWorkers(
        store,
        queues,
        {
          ...services,
          reviewJob: async () => {
            calls++;
            throw new Error('model offline');
          },
        },
        scrapeListing,
      );
      // Act: run the pipeline until location exhausts its attempts.
      await queues.enqueue('crawl', 3);
      await until(
        () =>
          store
            .stages(3)
            .some((s) => s.stage === 'location' && s.state === 'failed') &&
          store.getJob(3).stack_status === 'match',
      );
      await until(
        async () =>
          (await (
            await queues.queues.location.getJob('listing-3')
          ).getState()) === 'failed',
      );
      // Assert: stack completes independently and location stops after three attempts.
      assert.equal(calls, 3);
      const saved = store.getJob(3);
      // Act: repair delivery without explicitly granting another attempt.
      await queues.repair(store);
      await delay(50);
      // Assert: repair does not retry an exhausted stage.
      assert.equal(calls, 3);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
      // Act: explicitly reset only location's retry allowance.
      await queues.retry(store, 'location', 3);
      // Assert: BullMQ starts the targeted retry with a fresh attempt count.
      assert.equal(
        (await queues.queues.location.getJob('listing-3')).attemptsMade,
        0,
      );
      // Act: resume with a healthy location service.
      workers = await startWorkers(store, queues, services, scrapeListing);
      await until(() => store.getJob(3).eligibility === 'ineligible');
      // Assert: the recovered location check preserves stack results and saved text.
      for (const key of [
        'stack_status',
        'stack_reason',
        'stack_evidence',
        'listing_text',
      ])
        assert.equal(store.getJob(3)[key], saved[key]);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'repair closes save/enqueue gaps and review waits on the same worker with a bounded selection',
    async () => {
      // Arrange: leave one listing with saved text but no assessment delivery.
      store.saveResults([result(4), result(5)]);
      store.saveListingText(4, 'Saved before interrupted enqueue');
      workers = await startWorkers(store, queues, services, scrapeListing);
      // Act: review just one unfinished listing using the running consumers.
      const outcome = await reviewJobs(store, queues, 1);
      // Assert: review reuses the checkpoint and leaves the unselected listing alone.
      assert.equal(outcome.reviewed, 1);
      assert.equal(
        store.getJob(4).listing_text,
        'Saved before interrupted enqueue',
      );
      assert.equal(store.getJob(5).listing_text, null);
      // Act: restore the remaining listing's missing crawl delivery.
      await queues.repair(store, 'crawl');
      // Assert: all pending stages finish before the bounded wait expires.
      await until(() => store.pendingCount() === 0);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'Redis restart retains waiting work and workers reconnect',
    async () => {
      // Arrange: persist queued work alongside an unrelated Firecrawl key.
      store.saveResults([result(6)]);
      docker(
        'exec',
        container,
        'redis-cli',
        'SET',
        'firecrawl:test',
        'preserved',
      );
      await queues.enqueue('crawl', 6);
      // Act: stop and restart Redis with work still waiting.
      docker('stop', container);
      docker('start', container);
      await until(
        () => docker('exec', container, 'redis-cli', 'ping') === 'PONG',
      );
      // Assert: both the unrelated key and queued listing survive the restart.
      assert.equal(
        docker('exec', container, 'redis-cli', 'GET', 'firecrawl:test'),
        'preserved',
      );
      await until(async () => {
        try {
          return Boolean(await queues.queues.crawl.getJob('listing-6'));
        } catch {
          return false;
        }
      });
      await queuesReady(queues);
      // Act: start consumers against the recovered queue.
      workers = await startWorkers(store, queues, services, scrapeListing);
      // Assert: waiting work reaches both saved assessments.
      await until(
        () =>
          store.getJob(6).stack_status === 'match' &&
          store.getJob(6).eligibility === 'ineligible',
      );
      // Act: restart Redis under running consumers, then enqueue another listing.
      docker('restart', container);
      await queuesReady(queues);
      store.saveResults([result(7)]);
      await queues.enqueue('crawl', 7);
      // Assert: existing consumers reconnect and complete the new work.
      await until(
        () =>
          store.getJob(7).stack_status === 'match' &&
          store.getJob(7).eligibility === 'ineligible',
      );
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'SIGKILL interrupts real worker ownership; another worker recovers stalled work and keeps checkpoints',
    async () => {
      // Arrange: give a separate worker a saved crawl checkpoint and blocking services.
      store.saveResults([result(8), result(9)]);
      store.saveListingText(8, 'Checkpoint before model interruption');
      const transport = new URL('../dist/bullmq.js', import.meta.url).href;
      const worker = new URL('../dist/review/worker.js', import.meta.url).href;
      const persistence = new URL('../dist/sqlite.js', import.meta.url).href;
      const code = `
      import {JobQueues} from ${JSON.stringify(transport)};
      import {startWorkers} from ${JSON.stringify(worker)};
      import {SqliteStore} from ${JSON.stringify(persistence)};
      const store=new SqliteStore(${JSON.stringify(path)});
      const queues=new JobQueues(${JSON.stringify(url)},'isolated-job-hunter');
      await startWorkers(store,queues,{
        reviewJob:async()=>{process.send('active');return new Promise(()=>{});},
        reviewStack:async()=>(${JSON.stringify(stack)}),
      },async()=>new Promise(()=>{}));
      process.send('ready');
    `;
      child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const ready = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {
          throw new Error(`Worker exited: ${code}`);
        }),
      ]);
      // Assert: the child is ready before handing it real queue ownership.
      assert.equal(ready[0], 'ready');
      // Act: interrupt owned work, then repair delivery with replacement consumers.
      const active = once(child, 'message');
      await queues.enqueue('location', 8);
      await active;
      await queues.enqueue('crawl', 9);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      workers = await startWorkers(store, queues, services, scrapeListing);
      await queues.repair(store);
      await until(() => store.pendingCount() === 0, 100_000);
      // Assert: stalled work completes without losing the saved crawl checkpoint.
      assert.equal(
        store.getJob(8).listing_text,
        'Checkpoint before model interruption',
      );
      assert.equal(store.getJob(8).eligibility, 'ineligible');
      assert.equal(store.getJob(9).stack_status, 'match');
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test('worker drains active consumers on shutdown', async () => {
    // Arrange: block an active stack check and observe when worker shutdown resolves.
    store.saveResults([result(10)]);
    const id = store.unfinished().find((job) => job.url === result(10).url).id;
    const controller = new AbortController();
    let release,
      started = false,
      stopped = false;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const running = workJobs(
      store,
      queues,
      {
        ...services,
        reviewStack: async () => {
          started = true;
          await blocked;
          return stack;
        },
      },
      controller.signal,
      scrapeListing,
    ).then(() => {
      stopped = true;
    });
    try {
      // Act: request shutdown while the stack consumer is still blocked.
      await queues.enqueue('crawl', id);
      await until(() => started);
      controller.abort();
      await delay(25);
      // Assert: shutdown waits for active work rather than abandoning it.
      assert.equal(stopped, false);
    } finally {
      // Cleanup: release the consumer even when an assertion fails, then drain it.
      release();
      controller.abort();
      await running;
    }
    // Assert: draining preserves the active consumer's completed assessment.
    assert.equal(store.getJob(id).stack_status, 'match');
  });

  await t.test(
    'workers skip missing, hidden and rejected listings in every stage',
    async () => {
      store.saveResults([result(11), result(12)]);
      store.setReviewStatus('11', 'hidden');
      store.setReviewStatus('12', 'rejected');
      const before = [11, 12].map((id) => ({
        job: store.getJob(id),
        stages: store.stages(id),
      }));
      const calls = [];
      workers = await startWorkers(
        store,
        queues,
        {
          reviewJob: async () => {
            calls.push('location');
            return location;
          },
          reviewStack: async () => {
            calls.push('stack');
            return stack;
          },
        },
        async () => {
          calls.push('crawl');
          return 'Unexpected extraction';
        },
      );
      for (const stage of ['crawl', 'location', 'stack'])
        for (const id of [11, 12, 999]) await queues.enqueue(stage, id);
      await until(async () =>
        (
          await Promise.all(
            Object.values(queues.queues).map((queue) =>
              queue.getJobCounts('active', 'wait', 'failed'),
            ),
          )
        ).every((counts) => !counts.active && !counts.wait && !counts.failed),
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(
        [11, 12].map((id) => ({
          job: store.getJob(id),
          stages: store.stages(id),
        })),
        before,
      );
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'unavailable Redis fails producers instead of hanging the CLI',
    async () => {
      // Arrange: target a local port with no Redis listener.
      const unavailable = new JobQueues(
        'redis://127.0.0.1:1',
        'isolated-unavailable',
      );
      try {
        // Act / Assert: enqueue rejects instead of buffering forever while disconnected.
        await assert.rejects(unavailable.enqueue('crawl', 1));
      } finally {
        await unavailable.close();
      }
    },
  );
});

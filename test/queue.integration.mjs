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
  scrapeListing: async () => 'US Laravel role',
  reviewJob: async () => location,
  reviewStack: async () => stack,
};
const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
async function until(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for queue state');
    await delay(25);
  }
}

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

  await t.test(
    'deduplicates tasks and lets stack/crawl progress while location is blocked',
    async () => {
      store.saveResults([result(1), result(2)]);
      let release,
        started = false,
        scrapes = 0,
        stackCalls = 0;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      workers = await startWorkers(store, queues, {
        ...services,
        scrapeListing: async () => {
          scrapes++;
          return 'US Laravel role';
        },
        reviewJob: async () => {
          started = true;
          await blocked;
          return location;
        },
        reviewStack: async () => {
          stackCalls++;
          return stack;
        },
      });
      try {
        await Promise.all(
          Array.from({ length: 5 }, () => queues.enqueue('crawl', 1)),
        );
        await until(() => started && store.getJob(1).stack_status === 'match');
        await queues.enqueue('crawl', 2);
        await until(() => store.getJob(2).stack_status === 'match');
        assert.equal(store.getJob(1).eligibility, 'pending');
        assert.equal(scrapes, 2);
        assert.equal(stackCalls, 2);
        // Even an accidental second process cannot raise stage concurrency.
        assert.equal(await queues.queues.location.getGlobalConcurrency(), 1);
      } finally {
        release();
      }
      await until(() => store.pendingCount() === 0);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
      const saved = JSON.stringify(store.getJob(1));
      for (const stage of ['crawl', 'location', 'stack'])
        await queues.enqueue(stage, 1);
      workers = await startWorkers(store, queues, {
        scrapeListing: async () => assert.fail('duplicate scrape'),
        reviewJob: async () => assert.fail('duplicate location'),
        reviewStack: async () => assert.fail('duplicate stack'),
      });
      await until(async () =>
        (
          await Promise.all(
            Object.values(queues.queues).map((q) =>
              q.getJobCounts('active', 'wait'),
            ),
          )
        ).every((c) => !c.active && !c.wait),
      );
      assert.equal(JSON.stringify(store.getJob(1)), saved);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'failed location does not block stack; targeted retry resets BullMQ attempts without changing stack',
    async () => {
      store.saveResults([result(3)]);
      let calls = 0;
      workers = await startWorkers(store, queues, {
        ...services,
        reviewJob: async () => {
          calls++;
          throw new Error('model offline');
        },
      });
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
      assert.equal(calls, 3);
      const saved = store.getJob(3);
      await queues.repair(store);
      await delay(50);
      assert.equal(calls, 3);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
      await queues.retry(store, 'location', 3);
      assert.equal(
        (await queues.queues.location.getJob('listing-3')).attemptsMade,
        0,
      );
      workers = await startWorkers(store, queues, services);
      await until(() => store.getJob(3).eligibility === 'ineligible');
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
      store.saveResults([result(4), result(5)]);
      store.saveListingText(4, 'Saved before interrupted enqueue');
      workers = await startWorkers(store, queues, services);
      const outcome = await reviewJobs(store, queues, 1);
      assert.equal(outcome.reviewed, 1);
      assert.equal(
        store.getJob(4).listing_text,
        'Saved before interrupted enqueue',
      );
      assert.equal(store.getJob(5).listing_text, null);
      await queues.repair(store, 'crawl');
      await until(() => store.pendingCount() === 0);
      await Promise.all(workers.map((worker) => worker.close()));
      workers = [];
    },
  );

  await t.test(
    'Redis restart retains waiting work and workers reconnect',
    async () => {
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
      docker('stop', container);
      docker('start', container);
      await until(
        () => docker('exec', container, 'redis-cli', 'ping') === 'PONG',
      );
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
      workers = await startWorkers(store, queues, services);
      await until(
        () =>
          store.getJob(6).stack_status === 'match' &&
          store.getJob(6).eligibility === 'ineligible',
      );
      docker('restart', container);
      await queuesReady(queues);
      store.saveResults([result(7)]);
      await queues.enqueue('crawl', 7);
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
        scrapeListing:async()=>new Promise(()=>{}),
        reviewJob:async()=>{process.send('active');return new Promise(()=>{});},
        reviewStack:async()=>(${JSON.stringify(stack)}),
      });
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
      assert.equal(ready[0], 'ready');
      const active = once(child, 'message');
      await queues.enqueue('location', 8);
      await active;
      await queues.enqueue('crawl', 9);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      workers = await startWorkers(store, queues, services);
      await queues.repair(store);
      await until(() => store.pendingCount() === 0, 100_000);
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
    ).then(() => {
      stopped = true;
    });
    try {
      await queues.enqueue('crawl', id);
      await until(() => started);
      controller.abort();
      await delay(25);
      assert.equal(stopped, false);
    } finally {
      release();
      controller.abort();
      await running;
    }
    assert.equal(store.getJob(id).stack_status, 'match');
  });

  await t.test(
    'unavailable Redis fails producers instead of hanging the CLI',
    async () => {
      const unavailable = new JobQueues(
        'redis://127.0.0.1:1',
        'isolated-unavailable',
      );
      try {
        await assert.rejects(unavailable.enqueue('crawl', 1));
      } finally {
        await unavailable.close();
      }
    },
  );
});

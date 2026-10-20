import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobQueues } from '../dist/bullmq.js';
import { SqliteStore } from '../dist/sqlite.js';

test('retry ignores stale failure reads and removes old delivery before reset', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { url: 'https://example.test/1', title: 'Role', query: 'q' },
  ]);
  store.failStage(1, 'crawl', 'Old failure', true);
  const reading = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  const old = {
    failedReason: 'Old failure',
    async getState() {
      if (++reads === 1) {
        reading.resolve();
        await release.promise;
      }
      return 'failed';
    },
    async remove() {
      task = undefined;
    },
  };
  let task = old;
  const queues = Object.create(JobQueues.prototype);
  queues.queues = Object.fromEntries(
    ['crawl', 'location', 'stack'].map((stage) => [
      stage,
      {
        getJob: async () => (stage === 'crawl' ? task : undefined),
        add: async () => {
          assert.equal(task, undefined);
          // A concurrent repair sees no old failed delivery after reset.
          await queues.syncFailures(store, 1);
          assert.equal(store.stages(1)[0].state, 'pending');
          task = { getState: async () => 'waiting' };
        },
      },
    ]),
  );
  const syncing = queues.syncFailures(store, 1);
  await reading.promise;
  try {
    await queues.retry(store, 'crawl', 1);
  } finally {
    release.resolve();
    await syncing;
  }
  assert.equal(store.stages(1)[0].generation, 1);
  assert.equal(store.needsStage(1, 'crawl'), true);
  assert.equal(await task.getState(), 'waiting');
});

test('repair restores delivery when enqueue fails after a retry reset', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { url: 'https://example.test/1', title: 'Role', query: 'q' },
  ]);
  store.failStage(1, 'crawl', 'Old failure', true);
  const queues = Object.create(JobQueues.prototype);
  let unavailable = true;
  let delivered = 0;
  queues.queues = Object.fromEntries(
    ['crawl', 'location', 'stack'].map((stage) => [
      stage,
      {
        getJob: async () => undefined,
        add: async () => {
          assert.equal(stage, 'crawl');
          if (unavailable) throw new Error('Redis unavailable');
          delivered++;
        },
      },
    ]),
  );
  await assert.rejects(queues.retry(store, 'crawl', 1), /Redis unavailable/);
  assert.equal(store.needsStage(1, 'crawl'), true);
  unavailable = false;
  await queues.repair(store);
  assert.equal(delivered, 1);
});

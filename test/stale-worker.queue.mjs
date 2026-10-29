import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { ReviewQueues } from '../src/infra/bullmq.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { PageError } from '../src/integrations/extraction.ts';

test('stale worker processes scheduled deliveries through the dedicated queue', async (t) => {
  const store = new SqliteStore(':memory:');
  const queues = new ReviewQueues(
    process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380',
    `stale-test-${randomUUID()}`,
  );
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.com/job',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  let worker;
  t.after(async () => {
    if (worker) await worker.close();
    if (queues.stale) await queues.stale.obliterate({ force: true });
    await queues.close();
    store.close();
  });
  worker = await queues.startStaleWorker(store, {
    ats: [],
    fallback: async () => {
      throw new PageError(404);
    },
  });
  const done = once(worker, 'completed');
  await queues.stale.add('stale-check', {});
  await done;
  assert.equal(store.getJob(1).status, 'stale');
  assert.deepEqual(store.pendingStaleSweep(), []);
  assert.equal(await queues.stale.getGlobalConcurrency(), 1);
  assert.ok(await queues.stale.getJobScheduler('daily-stale-check'));
});

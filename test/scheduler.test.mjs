import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { startFetchScheduler } from '../dist/discovery/scheduler.js';

test('fetch scheduler rejects invalid cron before enqueueing', async () => {
  // Arrange: use a queue that must never run for an invalid schedule.
  // Act / Assert: reject the cron expression before invoking discovery.
  await assert.rejects(
    startFetchScheduler({ enqueue: async () => assert.fail() }, 'invalid'),
    /FETCH_CRON/,
  );
});

test('fetch scheduler waits for cron, skips overlap, and drains on shutdown', {
  timeout: 8000,
}, async () => {
  // Arrange: gate the first fetch so overlap and shutdown can be observed.
  let calls = 0;
  let release;
  let started;
  const first = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let stopped = false;
  // Act: start a worker scheduled to fetch every second.
  const worker = startFetchScheduler(
    {
      async enqueue() {
        calls++;
        started();
        await gate;
      },
    },
    '* * * * * *',
  ).then(() => {
    stopped = true;
  });
  // Assert: startup waits for cron rather than fetching immediately.
  assert.equal(calls, 0);
  try {
    // Act: hold the first fetch open across another scheduled tick.
    await first;
    await setTimeout(1200);
    // Assert: the next tick does not start an overlapping fetch.
    assert.equal(calls, 1);
    // Act: request shutdown while the fetch is still blocked.
    process.emit('SIGTERM');
    await setTimeout(20);
    // Assert: shutdown waits for the active fetch to finish.
    assert.equal(stopped, false);
  } finally {
    // Cleanup: signal shutdown and release the fetch even if an assertion fails.
    process.emit('SIGTERM');
    release();
    await worker;
  }
  // Assert: the worker stops after draining its active fetch.
  assert.equal(stopped, true);
});

test('fetch scheduler continues scheduling after a failed enqueue', {
  timeout: 8000,
}, async () => {
  // Arrange: observe recovery after the first scheduled fetch fails.
  let calls = 0;
  let complete;
  const recovered = new Promise((resolve) => {
    complete = resolve;
  });
  // Act: start scheduling with a one-time fetch failure.
  const worker = startFetchScheduler(
    {
      async enqueue() {
        if (++calls === 1) throw new Error('mock enqueue failure');
        complete();
      },
    },
    '* * * * * *',
  );
  try {
    // Act: wait for the next scheduled fetch to succeed.
    await recovered;
    // Assert: scheduling survives the initial failure and runs again.
    assert.equal(calls, 2);
  } finally {
    // Cleanup: stop and drain the scheduled worker.
    process.emit('SIGTERM');
    await worker;
  }
});

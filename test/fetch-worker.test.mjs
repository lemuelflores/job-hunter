import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { workFetch } from '../dist/fetch-worker.js';

test('fetch worker rejects invalid cron before fetching', async () => {
  await assert.rejects(
    workFetch(async () => assert.fail(), 'invalid'),
    /FETCH_CRON/,
  );
});

test('fetch worker waits for cron, skips overlap, and drains on shutdown', {
  timeout: 8000,
}, async () => {
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
  const worker = workFetch(async () => {
    calls++;
    started();
    await gate;
  }, '* * * * * *').then(() => {
    stopped = true;
  });
  assert.equal(calls, 0);
  try {
    await first;
    await setTimeout(1200);
    assert.equal(calls, 1);
    process.emit('SIGTERM');
    await setTimeout(20);
    assert.equal(stopped, false);
  } finally {
    process.emit('SIGTERM');
    release();
    await worker;
  }
  assert.equal(stopped, true);
});

test('fetch worker continues scheduling after a failed fetch', {
  timeout: 8000,
}, async () => {
  let calls = 0;
  let complete;
  const recovered = new Promise((resolve) => {
    complete = resolve;
  });
  const worker = workFetch(async () => {
    if (++calls === 1) throw new Error('mock search failure');
    complete();
  }, '* * * * * *');
  try {
    await recovered;
    assert.equal(calls, 2);
  } finally {
    process.emit('SIGTERM');
    await worker;
  }
});

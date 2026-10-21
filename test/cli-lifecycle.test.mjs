import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../dist/cli.js';

async function fixture(t, start = async () => ({ async close() {} })) {
  const events = [];
  const profile = { location: 'Germany', skills: [{ TypeScript: [] }] };
  const store = { close: () => events.push('database closed') };
  const queues = { close: async () => events.push('queues closed') };
  const fetchQueue = {
    enqueue: t.mock.fn(async () => ({ id: '42' })),
    close: async () => events.push('fetch queue closed'),
  };
  const loadProfile = t.mock.fn(async () => profile);
  const database = t.mock.fn();
  const llm = { reviewJob: t.mock.fn(), reviewStack: t.mock.fn() };
  const createLlm = t.mock.fn(() => llm);
  const startFetchScheduler = t.mock.fn(async (queue) => {
    assert.equal(queue, fetchQueue);
    await queue.enqueue();
  });
  const dependencies = {
    loadProfile,
    createLlm,
    createStore: async () => {
      database();
      return store;
    },
    createReviewQueues: async () => queues,
    createFetchQueue: async () => fetchQueue,
    startFetchScheduler,
    ...Object.fromEntries(
      [
        ['startFetchWorker', 'fetch'],
        ['startCrawlWorker', 'crawl'],
        ['startLocationWorker', 'location'],
        ['startTechWorker', 'stack'],
      ].map(([name, stage]) => [
        name,
        async (...args) => {
          events.push(`${stage} started`);
          return start(stage, args);
        },
      ]),
    ),
  };
  const output = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'info', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const listeners = ['SIGINT', 'SIGTERM'].map((event) =>
    process.listeners(event),
  );
  t.after(() => {
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((event) => process.listeners(event)),
      listeners,
    );
  });
  return {
    main: (argv) => main(argv, dependencies),
    events,
    profile,
    store,
    queues,
    fetchQueue,
    loadProfile,
    database,
    createLlm,
    llm,
    startFetchScheduler,
    output,
    errors,
  };
}

for (const command of ['fetch', 'scheduler']) {
  test(`${command} only enqueues without loading profile, database or model`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      await f.main([command]),
      0,
      JSON.stringify(f.errors.mock.calls),
    );
    assert.equal(f.fetchQueue.enqueue.mock.calls.length, 1);
    assert.equal(
      f.startFetchScheduler.mock.calls.length,
      command === 'scheduler' ? 1 : 0,
    );
    assert.equal(f.loadProfile.mock.calls.length, 0);
    assert.equal(f.database.mock.calls.length, 0);
    assert.equal(f.createLlm.mock.calls.length, 0);
    assert.deepEqual(f.events, ['fetch queue closed']);
    if (command === 'fetch')
      assert.deepEqual(f.output.mock.calls[0].arguments, ['{"queued":"42"}']);
  });
}

test('workers share dependencies and drain all consumers before queues and database', async (t) => {
  const { promise: drained, resolve: release } = Promise.withResolvers();
  const f = await fixture(t, async (stage, args) => {
    assert.equal(args[0], f.store);
    assert.equal(args[1], f.queues);
    if (stage === 'fetch') {
      assert.equal(args[2], f.fetchQueue);
      assert.equal(args[3], f.profile);
    }
    if (stage === 'location' || stage === 'stack')
      await args[2]('https://example.test', { listingText: 'Saved text' });
    if (stage === 'stack') setImmediate(() => process.emit('SIGTERM'));
    return {
      async close() {
        f.events.push(`${stage} closing`);
        assert.ok(!f.events.includes('queues closed'));
        if (stage === 'stack') release();
        await drained;
        f.events.push(`${stage} closed`);
      },
    };
  });
  assert.equal(
    await f.main(['workers']),
    0,
    JSON.stringify(f.errors.mock.calls),
  );
  assert.equal(f.loadProfile.mock.calls.length, 1);
  assert.equal(f.database.mock.calls.length, 1);
  assert.deepEqual(f.llm.reviewJob.mock.calls[0].arguments, [
    'https://example.test',
    { listingText: 'Saved text', location: 'Germany' },
  ]);
  assert.deepEqual(f.llm.reviewStack.mock.calls[0].arguments, [
    'https://example.test',
    { listingText: 'Saved text', skills: f.profile.skills },
  ]);
  for (const stage of ['fetch', 'crawl', 'location', 'stack']) {
    const closed = f.events.indexOf(`${stage} closed`);
    assert.ok(closed >= 0);
    assert.ok(closed < f.events.indexOf('queues closed'));
    assert.ok(closed < f.events.indexOf('fetch queue closed'));
  }
  assert.equal(f.events.at(-1), 'database closed');
});

for (const failing of ['fetch', 'location']) {
  test(`workers clean up after ${failing} startup fails`, async (t) => {
    const f = await fixture(t, async (stage) => {
      if (stage === failing) throw new Error('startup failed');
      return {
        async close() {
          await Promise.resolve();
          f.events.push(`${stage} closed`);
        },
      };
    });
    assert.equal(await f.main(['workers']), 1);
    assert.deepEqual(f.errors.mock.calls[0].arguments, ['startup failed']);
    assert.deepEqual(
      f.events,
      failing === 'fetch'
        ? [
            'fetch started',
            'queues closed',
            'fetch queue closed',
            'database closed',
          ]
        : [
            'fetch started',
            'crawl started',
            'location started',
            'fetch closed',
            'crawl closed',
            'queues closed',
            'fetch queue closed',
            'database closed',
          ],
    );
  });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { main } from '../src/entrypoints/cli.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';

test('backfill CLI previews without Redis and explicitly queues only its limit', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-backfill-cli-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults(
    [1, 2].map((id) => ({
      source: 'google',
      url: `https://example.test/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  store.saveListingText(1, 'First full description');
  store.saveListingText(2, 'Second full description');
  store.close();
  const historical = new DatabaseSync(path);
  historical.exec("DELETE FROM job_stages WHERE stage='assessment'");
  historical.close();
  const output = [];
  t.mock.method(console, 'log', (value) => output.push(JSON.parse(value)));
  const deliveries = [];
  let queuesCreated = 0;
  const dependencies = {
    createStore: async () => new SqliteStore(path),
    createReviewQueues: async () => {
      queuesCreated++;
      return {
        enqueue: async (stage, id) => deliveries.push([stage, id]),
        close: async () => {},
      };
    },
  };
  assert.equal(
    await main(['backfill', '--preview', '--limit', '1'], dependencies),
    0,
  );
  assert.deepEqual(output.shift(), {
    mode: 'preview',
    eligible: 2,
    missingText: 0,
    terminalCrawl: 0,
    crawlNotComplete: 0,
    selectedIds: [1],
  });
  assert.equal(queuesCreated, 0);
  assert.equal(await main(['backfill', '--limit', '1'], dependencies), 0);
  assert.deepEqual(output.shift(), { mode: 'run', queued: [1] });
  assert.deepEqual(deliveries, [['assessment', 1]]);
  const reopened = new SqliteStore(path);
  t.after(() => reopened.close());
  assert.equal(
    reopened.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  assert.equal(
    reopened.stages(2).some((stage) => stage.stage === 'assessment'),
    false,
  );
});

test('backfill CLI validates its required positive limit before opening storage', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dependencies = {
    createStore: async () => assert.fail('must not open storage'),
  };
  for (const args of [
    [],
    ['--limit', '0'],
    ['--limit', '1.5'],
    ['--limit', '1', '--unexpected'],
  ])
    assert.equal(await main(['backfill', ...args], dependencies), 1);
});

test('backfill CLI reports an enqueue gap without losing the selected work', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-backfill-gap-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/1',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  store.saveListingText(1, 'Full description');
  store.close();
  const historical = new DatabaseSync(path);
  historical.exec("DELETE FROM job_stages WHERE stage='assessment'");
  historical.close();
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  const code = await main(['backfill', '--limit', '1'], {
    createStore: async () => new SqliteStore(path),
    createReviewQueues: async () => ({
      enqueue: async () => {
        throw new Error('Redis unavailable');
      },
      close: async () => {},
    }),
  });
  assert.equal(code, 1);
  assert.match(errors[0], /run repair --stage assessment/);
  const reopened = new SqliteStore(path);
  t.after(() => reopened.close());
  assert.equal(
    reopened.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
});

test('backfill CLI targets the requested historical ID rather than the first eligible listing', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-backfill-id-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults(
    [1, 2].map((id) => ({
      source: 'google',
      url: `https://example.test/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  store.saveListingText(1, 'First description');
  store.saveListingText(2, 'Second description');
  store.close();
  const historical = new DatabaseSync(path);
  historical.exec("DELETE FROM job_stages WHERE stage='assessment'");
  historical.close();
  const output = [];
  const deliveries = [];
  t.mock.method(console, 'log', (value) => output.push(JSON.parse(value)));
  const dependencies = {
    createStore: async () => new SqliteStore(path),
    createReviewQueues: async () => ({
      enqueue: async (stage, id) => deliveries.push([stage, id]),
      close: async () => {},
    }),
  };
  assert.equal(await main(['backfill', '--id', '2'], dependencies), 0);
  assert.deepEqual(output, [{ mode: 'run', queued: [2] }]);
  assert.deepEqual(deliveries, [['assessment', 2]]);
  const reopened = new SqliteStore(path);
  t.after(() => reopened.close());
  assert.equal(
    reopened.stages(1).some((stage) => stage.stage === 'assessment'),
    false,
  );
});

test('backfill CLI rejects conflicting selectors and unavailable IDs', async (t) => {
  const store = new SqliteStore(':memory:');
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  const dependencies = {
    createStore: async () => store,
    createReviewQueues: async () => ({
      enqueue: async () => assert.fail('must not enqueue'),
      close: async () => {},
    }),
  };
  assert.equal(
    await main(['backfill', '--id', '1', '--limit', '1'], dependencies),
    1,
  );
  assert.equal(await main(['backfill', '--id', '0'], dependencies), 1);
  assert.equal(await main(['backfill', '--id', '99'], dependencies), 1);
  assert.match(errors.at(-1), /not eligible/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { main } from '../src/entrypoints/cli.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { addManualListing } from '../src/workflow/add-manual-listing.ts';

test('manual URL creates a user listing and queues its crawl', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const queued = [];
  const result = await addManualListing(
    store,
    'https://example.com/job?ref=1',
    async (stage, id) => queued.push({ stage, id }),
  );
  assert.equal(result.added, true);
  assert.equal(store.getJob(result.id).source, 'user');
  assert.deepEqual(queued, [{ stage: 'crawl', id: result.id }]);
});

test('invalid URLs are rejected before persistence', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  await assert.rejects(
    addManualListing(store, 'file:///etc/passwd', async () => {}),
    /URL/,
  );
  assert.equal(store.listReviewJobs('active').length, 0);
});

test('existing listings retain their source and are not requeued', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.com/job',
      title: 'Engineer',
      query: 'test',
    },
  ]);
  const queued = [];
  const result = await addManualListing(
    store,
    'https://example.com/job',
    async (stage, id) => queued.push({ stage, id }),
  );
  assert.equal(result.added, false);
  assert.equal(store.getJob(result.id).source, 'google');
  assert.deepEqual(queued, []);
});

test('a queue failure leaves the saved crawl pending for repair', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  await assert.rejects(
    addManualListing(store, 'https://example.com/job', async () => {
      throw new Error('queue down');
    }),
    /queue down/,
  );
  assert.equal(store.needsStage(1, 'crawl'), true);
});

test('existing databases migrate their source constraint without losing listings', async (t) => {
  const dir = mkdtempSync('/tmp/opencode/manual-migration-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.sqlite');
  const original = new SqliteStore(path);
  original.saveResults([
    {
      source: 'google',
      url: 'https://example.com/old',
      title: 'Old',
      query: 'test',
    },
  ]);
  original.close();
  const db = new DatabaseSync(path);
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE name='jobs'")
    .get().sql;
  const legacy = schema
    .replace('CREATE TABLE jobs', 'CREATE TABLE legacy_jobs')
    .replace("'google','freehire','user'", "'google','freehire'");
  db.exec(
    `PRAGMA foreign_keys=OFF; ${legacy}; INSERT INTO legacy_jobs SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE legacy_jobs RENAME TO jobs;`,
  );
  db.close();
  const migrated = new SqliteStore(path);
  t.after(() => migrated.close());
  const result = await addManualListing(
    migrated,
    'https://example.com/new',
    async () => {},
  );
  assert.equal(migrated.getJob(1).title, 'Old');
  assert.equal(migrated.getJob(result.id).source, 'user');
  assert.equal(migrated.needsStage(1, 'crawl'), true);
});

test('CLI adds a URL and delivers its crawl task', async (t) => {
  const dir = mkdtempSync('/tmp/opencode/manual-cli-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.sqlite');
  const queued = [];
  const code = await main(['add', 'https://example.com/cli-job'], {
    createStore: async () => new SqliteStore(path),
    createReviewQueues: async () => ({
      enqueue: async (stage, id) => queued.push({ stage, id }),
      close: async () => {},
    }),
  });
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(code, 0);
  assert.equal(store.getJob(1).source, 'user');
  assert.deepEqual(queued, [{ stage: 'crawl', id: 1 }]);
});

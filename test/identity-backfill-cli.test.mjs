import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { main } from '../src/entrypoints/cli.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessment } from './fixtures/workflow.mjs';

async function historical(t) {
  const root = await mkdtemp('/tmp/opencode/identity-backfill-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/1',
      title: 'Existing',
      query: '',
    },
    { source: 'freehire', url: 'https://example.test/2', query: '' },
  ]);
  store.saveListingText(1, 'description');
  store.saveListingText(2, 'description');
  store.saveAssessment(1, {
    ...assessment,
    company: 'Company one',
    role: 'Model role',
  });
  store.saveAssessment(2, {
    ...assessment,
    company: 'Company two',
    role: 'Role two',
  });
  store.setReviewStatus('2', 'hidden');
  store.close();
  const db = new DatabaseSync(path);
  db.exec(
    "UPDATE jobs SET company=' ' WHERE id=1; UPDATE jobs SET company='',title='' WHERE id=2",
  );
  db.close();
  return path;
}

test('identity backfill preview is read-only and run fills only missing fields without queues', async (t) => {
  const path = await historical(t);
  const output = [];
  t.mock.method(console, 'log', (value) => output.push(JSON.parse(value)));
  const deps = {
    createStore: async () => new SqliteStore(path),
    createReviewQueues: async () => assert.fail('must not create queues'),
    createLlm: () => assert.fail('must not create model'),
  };
  assert.equal(await main(['backfill-identity', '--preview'], deps), 0);
  assert.deepEqual(output.shift(), {
    mode: 'preview',
    listings: 2,
    companies: 2,
    titles: 1,
  });
  const before = new SqliteStore(path);
  assert.equal(before.getJob(1).company, ' ');
  before.close();
  assert.equal(await main(['backfill-identity'], deps), 0);
  assert.deepEqual(output.shift(), {
    mode: 'run',
    listings: 2,
    companies: 2,
    titles: 1,
  });
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(store.getJob(1).company, 'Company one');
  assert.equal(store.getJob(1).title, 'Existing');
  assert.equal(store.getJob(2).company, 'Company two');
  assert.equal(store.getJob(2).title, 'Role two');
  assert.equal(store.getJob(2).status, 'hidden');
  assert.equal(store.getAssessment(1).assessment.role, 'Model role');
  assert.equal(await main(['backfill-identity'], deps), 0);
  assert.deepEqual(output.shift(), {
    mode: 'run',
    listings: 0,
    companies: 0,
    titles: 0,
  });
});

test('invalid saved assessments abort the identity backfill without partial writes', async (t) => {
  const path = await historical(t);
  const db = new DatabaseSync(path);
  db.exec("UPDATE job_assessments SET report='invalid' WHERE job_id=2");
  db.close();
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  assert.equal(
    await main(['backfill-identity'], {
      createStore: async () => new SqliteStore(path),
    }),
    1,
  );
  assert.match(errors[0], /2/);
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(store.getJob(1).company, ' ');
  assert.equal(store.getJob(2).company, '');
});

test('blank assessment values do not replace missing identity', async (t) => {
  const path = await historical(t);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE job_assessments SET report=? WHERE job_id=2').run(
    JSON.stringify({ ...assessment, company: ' \t', role: null }),
  );
  db.close();
  const output = [];
  t.mock.method(console, 'log', (value) => output.push(JSON.parse(value)));
  assert.equal(
    await main(['backfill-identity'], {
      createStore: async () => new SqliteStore(path),
    }),
    0,
  );
  assert.deepEqual(output, [
    { mode: 'run', listings: 1, companies: 1, titles: 0 },
  ]);
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(store.getJob(2).company, '');
  assert.equal(store.getJob(2).title, '');
});

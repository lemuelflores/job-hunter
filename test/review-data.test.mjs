import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { listInbox } from '../src/app/review-data.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessment, result } from './fixtures/workflow.mjs';

test('the inbox exposes the location extracted from the saved listing', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2)]);
  store.saveListingText(1, 'Remote in Germany');
  store.saveAssessment(1, { ...assessment, location: 'Remote in Germany' });
  const jobs = listInbox(store);
  assert.equal(jobs.find((job) => job.id === 1).location, 'Remote in Germany');
  assert.equal(jobs.find((job) => job.id === 2).location, '');
});

test('inbox exposes saved reports and honest processing states without source text', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([1, 2, 3, 4].map(result));
  store.saveListingText(1, 'Private listing snapshot');
  store.saveAssessment(1, assessment);
  store.failStage(2, 'crawl', 'Crawl failed', true);
  store.terminalCrawl(3, 'Listing removed');
  store.setReviewStatus('4', 'hidden');
  const jobs = listInbox(store);
  const byId = (id) => jobs.find((job) => job.id === id);
  assert.equal(byId(1).processing, 'complete');
  assert.deepEqual(byId(1).assessment, assessment);
  assert.equal(byId(2).processing, 'failed');
  assert.equal(byId(2).error, 'Crawl failed');
  assert.equal(byId(3).processing, 'unavailable');
  assert.equal(byId(3).error, 'Listing removed');
  assert.equal(byId(4).processing, 'waiting');
  assert.equal(byId(4).reviewStatus, 'hidden');
  assert.ok(!JSON.stringify(jobs).includes('Private listing snapshot'));
});

test('an older listing without an assessment stage is not queued or failed', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-inbox-historical-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults([result(1)]);
  store.saveListingText(1, 'Saved text');
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DELETE FROM job_stages WHERE stage='assessment'");
  legacy.close();
  store = new SqliteStore(path);
  t.after(() => store.close());
  const [job] = listInbox(store);
  assert.equal(job.processing, 'not_scheduled');
  assert.equal(job.error, null);
});

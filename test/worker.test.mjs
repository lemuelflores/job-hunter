import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageError } from '../dist/review/firecrawl.js';
import { processStage } from '../dist/review/worker.js';
import { SqliteStore } from '../dist/sqlite.js';

test('terminal crawl failures stop both evaluations; temporary errors remain repairable', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults(
    [1, 2].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  let calls = 0;
  const services = {
    scrapeListing: async (url) => {
      throw new PageError(
        url.endsWith('/1') ? 404 : 500,
        'Page removed or unavailable',
      );
    },
    reviewJob: async () => assert.fail('terminal crawl'),
    reviewStack: async () => assert.fail('terminal crawl'),
  };
  const enqueue = async () => {
    calls++;
  };
  await processStage(store, 'crawl', 1, enqueue, services);
  assert.equal(store.getJob(1).eligibility, 'error');
  assert.match(store.getJob(1).reason, /Page removed/);
  assert.deepEqual(
    store.stages(1).map((s) => s.state),
    ['terminal', 'blocked', 'blocked'],
  );
  for (const stage of ['crawl', 'location', 'stack'])
    await processStage(store, stage, 1, enqueue, services);
  assert.equal(calls, 0);
  await assert.rejects(
    processStage(store, 'crawl', 2, enqueue, services),
    PageError,
  );
  store.failStage(2, 'crawl', 'Temporary page error', false);
  assert.equal(store.stages(2)[0].state, 'pending');
  store.failStage(2, 'crawl', 'Temporary page error', true);
  assert.equal(store.stages(2)[0].state, 'failed');
  assert.equal(store.getJob(2).eligibility, 'pending');
  assert.throws(() => store.resetStage(1, 'crawl'), /not failed/);
  store.resetStage(2, 'crawl');
  await processStage(store, 'crawl', 2, enqueue, {
    ...services,
    scrapeListing: async () => 'Recovered',
  });
  assert.equal(calls, 2);
  assert.equal(store.getJob(2).listing_text, 'Recovered');
});

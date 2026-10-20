import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCrawlWorker } from '../dist/review/crawl.js';
import { SqliteStore } from '../dist/sqlite.js';

const id = '12345678-abcd-abcd-abcd-123456789abc';
const ashbyUrl = `https://jobs.ashbyhq.com/example/${id}`;

async function runCrawl(store, enqueue = async () => {}) {
  const process = await startCrawlWorker(store, {
    enqueue,
    startWorker: (receivedStore, stage, process) => {
      assert.equal(receivedStore, store);
      assert.equal(stage, 'crawl');
      return process;
    },
  });
  return process(store.getJob(1));
}

function fixture(t, url) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([{ url, title: 'Engineer', query: 'remote' }]);
  return store;
}

test('Ashby extraction uses its public API, never Firecrawl', async (t) => {
  const store = fixture(t, ashbyUrl);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    requests++;
    assert.equal(
      endpoint,
      'https://api.ashbyhq.com/posting-api/job-board/example?includeCompensation=true',
    );
    return Response.json({
      jobs: [
        {
          jobUrl: ashbyUrl,
          title: 'Engineer',
          descriptionPlain: 'Laravel services',
        },
      ],
    });
  });
  await runCrawl(store);
  assert.equal(requests, 1);
  assert.ok(store.getJob(1).listing_text.includes('Laravel services'));
});

test('missing listings and API failures do not fall back to Firecrawl', async (t) => {
  for (const [name, response, error] of [
    ['absent', Response.json({ jobs: [] }), null],
    ['malformed', Response.json({ jobs: null }), /Invalid Ashby/],
    ['unavailable', new Response('', { status: 503 }), /Ashby API HTTP 503/],
  ]) {
    await t.test(name, async (t) => {
      const store = fixture(t, ashbyUrl);
      const endpoints = [];
      t.mock.method(globalThis, 'fetch', async (endpoint) => {
        endpoints.push(endpoint);
        return response;
      });
      const run = () =>
        runCrawl(store, async () => assert.fail('unexpected enqueue'));
      if (error) {
        await assert.rejects(run(), error);
        assert.equal(
          store.stages(1).find(({ stage }) => stage === 'crawl').state,
          'pending',
        );
      } else {
        await run();
        assert.equal(
          store.stages(1).find(({ stage }) => stage === 'crawl').state,
          'terminal',
        );
      }
      assert.deepEqual(endpoints, [
        'https://api.ashbyhq.com/posting-api/job-board/example?includeCompensation=true',
      ]);
    });
  }
});

test('Lever and Greenhouse extraction uses Firecrawl', async (t) => {
  for (const url of [
    `https://jobs.lever.co/example/${id}`,
    `https://jobs.eu.lever.co/example/${id}`,
    'https://job-boards.greenhouse.io/example/jobs/123',
  ]) {
    await t.test(url, async (t) => {
      const store = fixture(t, url);
      t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
        assert.ok(endpoint.endsWith('/v2/scrape'));
        assert.equal(init.method, 'POST');
        assert.equal(JSON.parse(init.body).url, url);
        return Response.json({
          success: true,
          data: { markdown: 'Existing text' },
        });
      });
      await runCrawl(store);
      assert.equal(store.getJob(1).listing_text, 'Existing text');
    });
  }
});

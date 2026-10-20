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

test('Greenhouse uses its direct API and schedules both assessments', async (t) => {
  for (const host of ['job-boards.greenhouse.io', 'boards.greenhouse.io']) {
    await t.test(host, async (t) => {
      const store = fixture(t, `https://${host}/example/jobs/123`);
      const enqueued = [];
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async (endpoint) => {
        requests++;
        assert.equal(
          endpoint,
          'https://boards-api.greenhouse.io/v1/boards/example/jobs/123?pay_transparency=true',
        );
        return Response.json({
          id: 123,
          content: '&lt;p&gt;Laravel services&lt;/p&gt;',
        });
      });
      await runCrawl(store, async (stage, id) => enqueued.push([stage, id]));
      assert.equal(requests, 1);
      assert.match(
        store.getJob(1).listing_text,
        /Description:\nLaravel services$/,
      );
      assert.deepEqual(enqueued, [
        ['location', 1],
        ['stack', 1],
      ]);
    });
  }
});

test('Greenhouse failures never fall back to Firecrawl', async (t) => {
  for (const [name, response, error] of [
    ['absent', new Response('', { status: 404 }), null],
    ['gone', new Response('', { status: 410 }), null],
    [
      'malformed',
      Response.json({ id: 123, content: null }),
      /Invalid Greenhouse/,
    ],
    [
      'unavailable',
      new Response('', { status: 503 }),
      /Greenhouse API HTTP 503/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const store = fixture(
        t,
        'https://job-boards.greenhouse.io/example/jobs/123',
      );
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async (endpoint) => {
        requests++;
        assert.ok(endpoint.startsWith('https://boards-api.greenhouse.io/'));
        return response;
      });
      const run = () =>
        runCrawl(store, async () => assert.fail('unexpected enqueue'));
      if (error) {
        await assert.rejects(run(), error);
        assert.ok(store.stages(1).every(({ state }) => state === 'pending'));
      } else {
        await run();
        assert.equal(
          store.stages(1).find(({ stage }) => stage === 'crawl').state,
          'terminal',
        );
        assert.ok(
          store
            .stages(1)
            .filter(({ stage }) => stage !== 'crawl')
            .every(({ state }) => state === 'blocked'),
        );
      }
      assert.equal(requests, 1);
      assert.equal(store.getJob(1).listing_text, null);
    });
  }
});

test('Lever extraction uses Firecrawl', async (t) => {
  for (const url of [
    `https://jobs.lever.co/example/${id}`,
    `https://jobs.eu.lever.co/example/${id}`,
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

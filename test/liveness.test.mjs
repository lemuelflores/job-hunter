import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/entrypoints/cli.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { PageError } from '../src/integrations/extraction.ts';
import { scrapeListing } from '../src/integrations/firecrawl.ts';

function firecrawlAt(url) {
  return () => ({
    ats: [],
    fallback: (listingUrl) =>
      scrapeListing(listingUrl, {
        fetch: (_input, options) => fetch(url, options),
      }),
  });
}

test('a supported ATS is checked using its extractor rather than the listing page', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-liveness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = 'https://jobs.example.test/company/123';
  const path = join(directory, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([
    { url, title: 'Engineer', query: 'test', source: 'google' },
  ]);
  store.close();
  const output = t.mock.method(console, 'log', () => {});

  assert.equal(
    await main(['check-url', url], {
      createStore: async () => new SqliteStore(path),
      createCrawlExtractors: () => ({
        ats: [
          {
            selector: 'test',
            hosts: ['jobs.example.test'],
            normalizeUrl: (value) => value,
            extract: async () => {
              throw new PageError(404);
            },
          },
        ],
        fallback: async () => {
          throw new Error('unexpected fallback');
        },
      }),
    }),
    0,
  );
  const result = new SqliteStore(path);
  t.after(() => result.close());
  assert.equal(result.listReviewJobs('hidden')[0].url, url);
  assert.equal(JSON.parse(output.mock.calls[0].arguments[0]).status, 404);
});

for (const [status, expected, code] of [
  [200, 'active', 0],
  [404, 'hidden', 0],
  [410, 'hidden', 0],
  [403, 'active', 1],
  [500, 'active', 1],
]) {
  test(`liveness HTTP ${status} leaves the listing ${expected}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'job-liveness-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          success: status < 400,
          data: {
            markdown: status < 400 ? 'Job description' : '',
            metadata: { statusCode: status },
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/job`;
    const path = join(directory, 'jobs.sqlite');
    const store = new SqliteStore(path);
    store.saveResults([
      { url, title: 'Engineer', query: 'test', source: 'google' },
    ]);
    store.close();
    const output = t.mock.method(console, 'log', () => {});
    const errors = t.mock.method(console, 'error', () => {});

    assert.equal(
      await main(['check-url', url], {
        createStore: async () => new SqliteStore(path),
        createCrawlExtractors: firecrawlAt(url),
      }),
      code,
    );
    const result = new SqliteStore(path);
    t.after(() => result.close());
    assert.equal(result.listReviewJobs(expected)[0].url, url);
    if (code === 0) {
      assert.deepEqual(JSON.parse(output.mock.calls[0].arguments[0]), {
        url,
        status,
        hidden: expected === 'hidden',
      });
    } else {
      assert.match(
        errors.mock.calls[0].arguments[0],
        new RegExp(`${status} status`),
      );
    }
  });
}

test('a missing URL does not overwrite a rejected listing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-liveness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((_request, response) =>
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        success: false,
        data: { metadata: { statusCode: 404 } },
      }),
    ),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/job`;
  const path = join(directory, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([
    { url, title: 'Engineer', query: 'test', source: 'google' },
  ]);
  store.setReviewStatus('1', 'rejected');
  store.close();
  const output = t.mock.method(console, 'log', () => {});

  assert.equal(
    await main(['check-url', url], {
      createStore: async () => new SqliteStore(path),
      createCrawlExtractors: firecrawlAt(url),
    }),
    0,
  );
  const result = new SqliteStore(path);
  t.after(() => result.close());
  assert.equal(result.listReviewJobs('rejected')[0].url, url);
  assert.equal(JSON.parse(output.mock.calls[0].arguments[0]).hidden, false);
});

test('a network failure leaves the listing active and reports an error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-liveness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((request) => request.socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/job`;
  const path = join(directory, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([
    { url, title: 'Engineer', query: 'test', source: 'google' },
  ]);
  store.close();
  const errors = t.mock.method(console, 'error', () => {});

  assert.equal(
    await main(['check-url', url], {
      createStore: async () => new SqliteStore(path),
      createCrawlExtractors: firecrawlAt(url),
    }),
    1,
  );
  const result = new SqliteStore(path);
  t.after(() => result.close());
  assert.equal(result.listReviewJobs('active')[0].url, url);
  assert.match(errors.mock.calls[0].arguments[0], /fetch failed/);
});

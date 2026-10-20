import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  googleSearch,
  runParallelGoogleSearchesDetailed,
} from '../dist/discovery/google.js';

// Shared Arrange: isolate API credentials and fetch, then restore both after each test.
function mock(t, fetcher) {
  const original = globalThis.fetch;
  const key = process.env.AUTOM_API_KEY;
  process.env.AUTOM_API_KEY = 'test-key';
  globalThis.fetch = fetcher;
  t.after(() => {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.AUTOM_API_KEY;
    else process.env.AUTOM_API_KEY = key;
  });
}

test('Google integration has no hardcoded country bias and preserves credentials, metadata and a request timeout', async (t) => {
  // Arrange: return one valid listing alongside malformed organic results.
  mock(t, async (raw, options) => {
    // Assert: the outgoing request keeps neutral geography, credentials and a timeout.
    assert.equal(raw.origin, 'https://api.autom.dev');
    assert.equal(raw.searchParams.get('gl'), null);
    assert.equal(raw.searchParams.get('hl'), 'en');
    assert.equal(raw.searchParams.get('query'), 'remote engineer');
    assert.equal(options.headers['x-api-key'], 'test-key');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({
      organic_results: [
        {
          title: 'Engineer',
          link: 'https://example.test/job',
          snippet: 'Remote',
          position: 1,
        },
        { title: 42, link: 'https://example.test/bad' },
        { title: 'Bad', link: null },
      ],
    });
  });
  // Act / Assert: search and retain only the valid listing with its metadata.
  assert.deepEqual(await googleSearch('remote engineer'), [
    {
      title: 'Engineer',
      url: 'https://example.test/job',
      snippet: 'Remote',
      position: 1,
      query: 'remote engineer',
    },
  ]);
});

test('parallel searches retain successes and report failed requests independently', async (t) => {
  // Arrange: fail only the bad query while the other queries return listings.
  mock(t, async (raw) =>
    raw.searchParams.get('query') === 'bad'
      ? new Response('unavailable', { status: 503 })
      : Response.json({
          organic_results: [
            { title: 'Engineer', link: 'https://example.test/job' },
          ],
        }),
  );
  // Act: run all three queries with two workers.
  const outcome = await runParallelGoogleSearchesDetailed(
    ['good', 'bad', 'other'],
    { concurrency: 2 },
  );
  // Assert: successful listings survive and the failed query is identified.
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].query, 'bad');
  assert.match(outcome.failures[0].error, /503/);
});

test('pagination follows next pages, preserves localization and stops at 100 unique results', async (t) => {
  // Arrange: advertise unlimited pages with one overlapping listing per page.
  const pages = [];
  mock(t, async (raw) => {
    const page = Number(raw.searchParams.get('page'));
    pages.push(page);
    // Assert: localization survives pagination without an unsupported num parameter.
    assert.equal(raw.searchParams.get('gl'), 'ph');
    assert.equal(raw.searchParams.get('hl'), 'en');
    assert.equal(raw.searchParams.get('num'), null);
    return Response.json({
      organic_results: Array.from({ length: 11 }, (_, index) => ({
        title: 'Engineer',
        link: `https://example.test/${(page - 1) * 10 + index}`,
      })),
      pagination: { has_next_page: true, next: page + 1 },
    });
  });
  // Act: request more results than the supported maximum.
  const results = await googleSearch('remote engineer', {
    country: 'ph',
    num: 200,
  });
  // Assert: deduplication and the cap stop fetching after ten pages.
  assert.equal(results.length, 100);
  assert.equal(new Set(results.map((result) => result.url)).size, 100);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('pagination follows advertised next page even after a short page', async (t) => {
  // Arrange: a short first page explicitly points to page three.
  const pages = [];
  mock(t, async (raw) => {
    const page = Number(raw.searchParams.get('page'));
    pages.push(page);
    return Response.json({
      organic_results: [
        { title: 'Engineer', link: `https://example.test/${page}` },
      ],
      pagination: { has_next_page: page === 1, next: 3 },
    });
  });
  // Act / Assert: follow the advertised page rather than stopping at a short page.
  assert.equal((await googleSearch('remote engineer')).length, 2);
  assert.deepEqual(pages, [1, 3]);
});

for (const ending of ['empty', 'duplicate', 'backwards']) {
  test(`pagination stops on ${ending} pages`, async (t) => {
    // Arrange: simulate this table case's empty, repeated or backwards continuation.
    let calls = 0;
    mock(t, async () => {
      calls++;
      // Assert: no termination case may keep requesting pages indefinitely.
      assert.ok(calls <= 2);
      return Response.json({
        organic_results:
          ending === 'empty' && calls === 2
            ? []
            : [{ title: 'Engineer', link: 'https://example.test/job' }],
        pagination: {
          has_next_page: true,
          next: ending === 'backwards' ? 1 : calls + 1,
        },
      });
    });
    // Act / Assert: search stops with one unique listing at the expected page count.
    assert.equal((await googleSearch('remote engineer')).length, 1);
    assert.equal(calls, ending === 'backwards' ? 1 : 2);
  });
}

test('pagination honors a smaller requested result limit', async (t) => {
  // Arrange: return ten listings and advertise another page.
  let calls = 0;
  mock(t, async () => {
    calls++;
    return Response.json({
      organic_results: Array.from({ length: 10 }, (_, index) => ({
        title: 'Engineer',
        link: `https://example.test/${index}`,
      })),
      pagination: { has_next_page: true, next: 2 },
    });
  });
  // Act / Assert: a three-result request truncates the page without fetching another.
  assert.equal((await googleSearch('remote engineer', { num: 3 })).length, 3);
  assert.equal(calls, 1);
});

test('later page failures preserve successful results and report the query failure', async (t) => {
  mock(t, async (url) =>
    Number(url.searchParams.get('page')) === 1
      ? Response.json({
          organic_results: [
            { title: 'Engineer', link: 'https://example.test/1' },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : new Response('unavailable', { status: 503 }),
  );
  const outcome = await runParallelGoogleSearchesDetailed(['remote engineer']);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].url, 'https://example.test/1');
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0].error, /503/);
});

test('search skips malformed entries and drops invalid optional fields', async (t) => {
  mock(t, async () =>
    Response.json({
      organic_results: [
        null,
        [],
        42,
        {},
        { title: ' ', link: 'https://example.test/blank' },
        {
          title: 'Engineer',
          link: 'https://example.test/1',
          snippet: 42,
          position: '1',
        },
        { title: 'Developer', link: 'https://example.test/2', snippet: null },
      ],
    }),
  );
  const results = await googleSearch('remote engineer');
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.snippet === undefined));
  assert.ok(results.every((result) => result.position === undefined));
});

test('search rejects malformed response containers and pagination', async (t) => {
  for (const body of [
    null,
    [],
    { organic_results: {} },
    { pagination: [] },
    { pagination: { has_next_page: 'yes' } },
    { pagination: { next: 1.5 } },
  ]) {
    mock(t, async () => Response.json(body));
    await assert.rejects(googleSearch('remote engineer'), /Invalid Autom.dev/);
  }
});

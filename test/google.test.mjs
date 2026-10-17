import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  googleSearch,
  runParallelGoogleSearchesDetailed,
} from '../dist/discovery/google.js';

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
  mock(t, async (raw, options) => {
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
  mock(t, async (raw) =>
    raw.searchParams.get('query') === 'bad'
      ? new Response('unavailable', { status: 503 })
      : Response.json({
          organic_results: [
            { title: 'Engineer', link: 'https://example.test/job' },
          ],
        }),
  );
  const outcome = await runParallelGoogleSearchesDetailed(
    ['good', 'bad', 'other'],
    { concurrency: 2 },
  );
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].query, 'bad');
  assert.match(outcome.failures[0].error, /503/);
});

test('pagination follows next pages, preserves localization and stops at 100 unique results', async (t) => {
  const pages = [];
  mock(t, async (raw) => {
    const page = Number(raw.searchParams.get('page'));
    pages.push(page);
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
  const results = await googleSearch('remote engineer', {
    country: 'ph',
    num: 200,
  });
  assert.equal(results.length, 100);
  assert.equal(new Set(results.map((result) => result.url)).size, 100);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('pagination follows advertised next page even after a short page', async (t) => {
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
  assert.equal((await googleSearch('remote engineer')).length, 2);
  assert.deepEqual(pages, [1, 3]);
});

for (const ending of ['empty', 'duplicate', 'backwards']) {
  test(`pagination stops on ${ending} pages`, async (t) => {
    let calls = 0;
    mock(t, async () => {
      calls++;
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
    assert.equal((await googleSearch('remote engineer')).length, 1);
    assert.equal(calls, ending === 'backwards' ? 1 : 2);
  });
}

test('pagination honors a smaller requested result limit', async (t) => {
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
  assert.equal((await googleSearch('remote engineer', { num: 3 })).length, 3);
  assert.equal(calls, 1);
});

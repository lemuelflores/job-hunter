import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  googleSearch,
  runParallelGoogleSearchesDetailed,
} from '../dist/integrations/search/google.js';

test('a final page with a null next pointer retains its listings', async (t) => {
  mock(t, async () =>
    Response.json({
      organic_results: [
        { title: 'Engineer', link: 'https://jobs.ashbyhq.com/example/job' },
      ],
      pagination: { next: null, has_next_page: false },
    }),
  );

  const outcome = await runParallelGoogleSearchesDetailed(['engineer']);

  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].url, 'https://jobs.ashbyhq.com/example/job');
});

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

test('search logs every unique URL across pages, including before a later failure', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (message) => logs.push(message));
  mock(t, async (raw) => {
    const page = Number(raw.searchParams.get('page'));
    if (page === 3) return new Response('unavailable', { status: 403 });
    return Response.json({
      organic_results: (page === 1 ? [1, 2, 3, 4] : [4, 5]).map((id) => ({
        title: 'Engineer',
        link: `https://example.test/${id}`,
      })),
      pagination: { has_next_page: true, next: page + 1 },
    });
  });
  await assert.rejects(googleSearch('engineer'), /403/);
  assert.deepEqual(logs, [
    '[google] page 1: 4 new results (4 total)\n  query: engineer\n  https://example.test/1\n  https://example.test/2\n  https://example.test/3\n  https://example.test/4',
    '[google] page 2: 1 new results (5 total)\n  query: engineer\n  https://example.test/5',
    '[google] page 3 failed (5 results retained)\n  query: engineer\n  error: Autom.dev Google search failed (HTTP 403)',
  ]);
});

test('concurrent ATS searches log each page together with its own query and URLs', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (message) => logs.push(message));
  mock(t, async (url) => {
    const query = url.searchParams.get('query');
    return Response.json({
      organic_results: [{ title: 'Engineer', link: `https://${query}/job` }],
    });
  });

  await Promise.all([
    googleSearch('jobs.ashbyhq.com', { ats: 'ashby' }),
    googleSearch('jobs.lever.co', { ats: 'lever' }),
  ]);

  assert.ok(
    logs.includes(
      '[google:ashby] page 1: 1 new results (1 total)\n  query: jobs.ashbyhq.com\n  https://jobs.ashbyhq.com/job',
    ),
  );
  assert.ok(
    logs.includes(
      '[google:lever] page 1: 1 new results (1 total)\n  query: jobs.lever.co\n  https://jobs.lever.co/job',
    ),
  );
});

test('a failed page logs its ATS, query and retained result count', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (message) => logs.push(message));
  mock(t, async (url) =>
    url.searchParams.get('page') === '1'
      ? Response.json({
          organic_results: [
            { title: 'Unexpected domain', link: 'https://outside.test/job' },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : Response.json({ error: 'Search denied' }, { status: 403 }),
  );

  await assert.rejects(
    googleSearch('site:breezy.hr engineer', { ats: 'breezyhr' }),
    /Search denied/,
  );

  assert.deepEqual(logs, [
    '[google:breezyhr] page 1: 1 new results (1 total)\n  query: site:breezy.hr engineer\n  https://outside.test/job',
    '[google:breezyhr] page 2 failed (1 results retained)\n  query: site:breezy.hr engineer\n  error: Search denied',
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

for (const status of [400, 401, 402, 403, 429, 503]) {
  test(`HTTP ${status} preserves Autom's error without retrying`, async (t) => {
    let calls = 0;
    const message = `Provider explanation for ${status}`;
    mock(t, async () => {
      calls++;
      return Response.json({ error: message }, { status });
    });
    await assert.rejects(googleSearch('engineer'), { message });
    assert.equal(calls, 1);
  });
}

test('unusable error bodies get an HTTP-specific fallback', async (t) => {
  for (const body of [
    'not JSON',
    'null',
    '[]',
    '{}',
    '{"error":42}',
    '{"error":"  "}',
  ]) {
    mock(t, async () => new Response(body, { status: 402 }));
    await assert.rejects(googleSearch('engineer'), {
      message: 'Autom.dev Google search failed (HTTP 402)',
    });
  }
});

for (const [status, message, delays] of [
  [500, 'Internal server error from Autom', [500, 1000]],
  [
    401,
    "Rate limit exceeded: You've exceeded the subscription rate limit",
    [2000, 2000],
  ],
  [401, 'RATE LIMIT exceeded for the API key: quota daily', [2000, 2000]],
]) {
  for (const recover of [true, false]) {
    test(`HTTP ${status} ${recover ? 'recovers' : 'stops'} after three attempts: ${message}`, async (t) => {
      const waits = [];
      t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        waits.push(delay);
        queueMicrotask(callback);
      });
      let calls = 0;
      mock(t, async () => {
        calls++;
        return recover && calls === 3
          ? Response.json({ organic_results: [] })
          : Response.json({ error: message }, { status });
      });
      if (recover) assert.deepEqual(await googleSearch('engineer'), []);
      else await assert.rejects(googleSearch('engineer'), { message });
      assert.equal(calls, 3);
      assert.deepEqual(waits, delays);
    });
  }
}

test('HTTP 404 ends pagination with no failure and retains earlier results', async (t) => {
  const pages = [];
  mock(t, async (url) => {
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    return page === 1
      ? Response.json({
          organic_results: [
            { title: 'Engineer', link: 'https://example.test/1' },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : new Response('not JSON', { status: 404 });
  });
  const outcome = await runParallelGoogleSearchesDetailed(['engineer']);
  assert.equal(outcome.results.length, 1);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(pages, [1, 2]);
});

test('exhausted later-page retries preserve earlier results and the provider error', async (t) => {
  const pages = [];
  t.mock.method(globalThis, 'setTimeout', (callback) =>
    queueMicrotask(callback),
  );
  mock(t, async (url) => {
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    return page === 1
      ? Response.json({
          organic_results: [
            { title: 'Engineer', link: 'https://example.test/1' },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : Response.json({ error: 'Search backend unavailable' }, { status: 500 });
  });
  const outcome = await runParallelGoogleSearchesDetailed(['engineer']);
  assert.equal(outcome.results.length, 1);
  assert.deepEqual(outcome.failures, [
    { query: 'engineer', error: 'Error: Search backend unavailable' },
  ]);
  assert.deepEqual(pages, [1, 2, 2, 2]);
});

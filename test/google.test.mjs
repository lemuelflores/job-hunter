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

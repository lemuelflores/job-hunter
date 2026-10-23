import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  breezyhr,
  fetchBoard,
  fetchBreezyhrListing,
  normalizeBreezyhrUrl,
} from '../src/integrations/ats/breezyhr.ts';
import { PageError } from '../src/integrations/extraction.ts';

const id = '026d43128c81';
const url = `https://example.breezy.hr/p/${id}`;
const job = {
  id,
  name: 'Engineer',
  description:
    '<p>Build Laravel &amp; PostgreSQL.</p><ul><li>Remote only</li></ul>',
  published_date: '2026-10-20T12:00:00Z',
  extra: { opaque: [null, true] },
};

test('BreezyHR normalizes strict tenant listing URLs without registry wiring', () => {
  assert.equal(breezyhr.selector, 'breezyhr');
  assert.deepEqual(breezyhr.hosts, ['*.breezy.hr']);
  assert.equal(
    normalizeBreezyhrUrl(
      `${url.replace(id, id.toUpperCase())}-Engineer/?x=1#top`,
    ),
    url,
  );
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('example.', ''),
    url.replace('example.', 'nested.example.'),
    url.replace('example.', 'example.breezy.hr.evil.'),
    url.replace('example.', 'user@example.'),
    url.replace('.hr/', '.hr:444/'),
    url.replace(id, 'invalid'),
    `${url}/apply`,
    url.replace(id, `${id}%2Fbad`),
    url.replace(id, `${id}%5Cbad`),
    url.replace(id, '%'),
    'not a URL',
  ])
    assert.equal(normalizeBreezyhrUrl(invalid), null, invalid);
});

test('BreezyHR verbose feed preserves opaque metadata and publication date and converts full HTML', async () => {
  const listing = await fetchBreezyhrListing(`${url}-engineer?source=jobs`, {
    fetch: async (endpoint, options) => {
      assert.equal(endpoint, 'https://example.breezy.hr/json?verbose=true');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json([job]);
    },
  });
  const [metadata, text] = listing.text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  const { description: _description, ...expected } = job;
  assert.deepEqual(JSON.parse(metadata), expected);
  assert.match(text, /Build Laravel & PostgreSQL/);
  assert.match(text, /Remote only/);
  assert.doesNotMatch(text, /<p>|&amp;/);
  assert.equal(listing.postedAt, job.published_date);
  const data = await fetchBoard('example.breezy.hr', {
    fetch: async () => Response.json([job]),
  });
  assert.deepEqual(data, [job]);
});

test('BreezyHR distinguishes absent rows from malformed, duplicate and empty feeds', async () => {
  for (const data of [[], [{ ...job, id: '000000000000' }]])
    await assert.rejects(
      fetchBreezyhrListing(url, { fetch: async () => Response.json(data) }),
      (error) => error instanceof PageError && !error.retryable,
    );
  for (const data of [
    null,
    {},
    [null],
    [{}],
    [{ ...job, id: 'bad' }],
    [{ ...job, description: null }],
    [job, job],
    [{ ...job, description: '<p>&nbsp;</p>' }],
  ])
    await assert.rejects(
      fetchBreezyhrListing(url, { fetch: async () => Response.json(data) }),
      (error) => !(error instanceof PageError),
    );
  const listing = await fetchBreezyhrListing(url, {
    fetch: async () => Response.json([{ ...job, published_date: 123 }]),
  });
  assert.equal(listing.postedAt, null);
  assert.match(listing.text, /"published_date": 123/);
});

test('BreezyHR HTTP failures never fall back and only 404/410 are terminal', async () => {
  for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchBreezyhrListing(url, {
        fetch: async () => {
          assert.equal(++calls, 1);
          return new Response(null, { status });
        },
      }),
      (error) =>
        [404, 410].includes(status)
          ? error instanceof PageError && !error.retryable
          : !(error instanceof PageError) &&
            error.message.includes(String(status)),
    );
  }
});

test('BreezyHR validates API hosts and propagates timeout, cancellation and network errors', async () => {
  const noFetch = { fetch: async () => assert.fail('unexpected fetch') };
  for (const host of [
    'breezy.hr',
    'nested.example.breezy.hr',
    'evil.test',
    'example.breezy.hr/path',
  ])
    await assert.rejects(
      fetchBoard(host, noFetch),
      /Invalid BreezyHR board host/,
    );
  await assert.rejects(
    fetchBreezyhrListing(`${url}/apply`, noFetch),
    /Invalid BreezyHR listing URL/,
  );
  const timeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchBreezyhrListing(url, {
        fetch: async (_url, options) => options.signal.throwIfAborted(),
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    AbortSignal.timeout = timeout;
  }
  await assert.rejects(
    fetchBreezyhrListing(url, {
      signal: AbortSignal.abort(new Error('Cancelled')),
      fetch: async (_url, options) => options.signal.throwIfAborted(),
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchBreezyhrListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

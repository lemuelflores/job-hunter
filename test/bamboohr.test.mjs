import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bamboohr,
  fetchBamboohrListing,
  fetchJob,
  normalizeBamboohrUrl,
} from '../dist/integrations/ats/bamboohr.js';
import { PageError } from '../dist/integrations/extraction.js';

const id = '1178';
const url = `https://example.bamboohr.com/careers/${id}`;
const legacy = `https://example.bamboohr.com/jobs/view.php?id=${id}&source=jobs`;
const job = {
  jobOpeningShareUrl: url,
  jobOpeningName: 'Engineer',
  description:
    '<p>Build Laravel &amp; PostgreSQL.</p><ul><li>Remote only</li></ul>',
  datePosted: '2026-07-29',
  compensation: null,
  extra: { opaque: [null, true] },
};
const response = (value) => Response.json({ result: { jobOpening: value } });

test('BambooHR normalizes current and legacy URLs with strict tenant guards', () => {
  assert.equal(bamboohr.selector, 'bamboohr');
  assert.deepEqual(bamboohr.hosts, ['*.bamboohr.com']);
  assert.equal(normalizeBamboohrUrl(`${url}/?x=1#top`), url);
  assert.equal(normalizeBamboohrUrl(legacy), url);
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('example.', ''),
    url.replace('example.', 'nested.example.'),
    url.replace('example.', 'user@example.'),
    url.replace('.com/', '.com.evil.test/'),
    url.replace('.com/', '.com:444/'),
    `${url}/apply`,
    url.replace(id, 'bad'),
    url.replace(id, '12%2F34'),
    url.replace(id, '12%5C34'),
    url.replace(id, '%'),
    legacy.replace(`id=${id}`, 'id=bad'),
    legacy.split('?')[0],
    'not a URL',
  ])
    assert.equal(normalizeBamboohrUrl(invalid), null, invalid);
});

test('BambooHR fetches full details from legacy identity and preserves metadata and date precision', async () => {
  const listing = await fetchBamboohrListing(legacy, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        `https://example.bamboohr.com/careers/${id}/detail`,
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return response(job);
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
  assert.equal(listing.postedAt, '2026-07-29');
  assert.deepEqual(
    await fetchJob('example.bamboohr.com', id, {
      fetch: async () => response(job),
    }),
    { result: { jobOpening: job } },
  );
});

test('BambooHR rejects malformed details, mismatched share URLs and empty HTML retryably', async () => {
  for (const data of [
    null,
    {},
    { result: null },
    { result: { jobOpening: {} } },
  ])
    await assert.rejects(
      fetchBamboohrListing(url, { fetch: async () => Response.json(data) }),
      /Invalid BambooHR job response/,
    );
  for (const value of [
    { ...job, description: null },
    { ...job, jobOpeningShareUrl: null },
    { ...job, jobOpeningShareUrl: url.replace(id, '999') },
    { ...job, jobOpeningShareUrl: url.replace('example.', 'other.') },
    { ...job, jobOpeningShareUrl: url.replace('https:', 'http:') },
    { ...job, description: '<p>&nbsp;</p><script>ignored</script>' },
  ])
    await assert.rejects(
      fetchBamboohrListing(url, { fetch: async () => response(value) }),
      (error) => !(error instanceof PageError),
    );
  const listing = await fetchBamboohrListing(url, {
    fetch: async () => response({ ...job, datePosted: 123 }),
  });
  assert.equal(listing.postedAt, null);
  assert.match(listing.text, /"datePosted": 123/);
});

test('BambooHR treats only 404/410 as terminal without fallback', async () => {
  for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchBamboohrListing(url, {
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

test('BambooHR validates before network and propagates timeout, cancellation and network failures', async () => {
  const noFetch = { fetch: async () => assert.fail('unexpected fetch') };
  for (const host of [
    'bamboohr.com',
    'nested.example.bamboohr.com',
    'evil.test',
    'example.bamboohr.com/path',
  ])
    await assert.rejects(
      fetchJob(host, id, noFetch),
      /Invalid BambooHR board host/,
    );
  await assert.rejects(
    fetchJob('example.bamboohr.com', 'bad', noFetch),
    /Invalid BambooHR job ID/,
  );
  await assert.rejects(
    fetchBamboohrListing(`${url}/apply`, noFetch),
    /Invalid BambooHR listing URL/,
  );
  const timeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchBamboohrListing(url, {
        fetch: async (_url, options) => options.signal.throwIfAborted(),
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    AbortSignal.timeout = timeout;
  }
  await assert.rejects(
    fetchBamboohrListing(url, {
      signal: AbortSignal.abort(new Error('Cancelled')),
      fetch: async (_url, options) => options.signal.throwIfAborted(),
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchBamboohrListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

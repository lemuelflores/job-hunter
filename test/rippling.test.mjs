import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchJob,
  fetchRipplingListing,
  normalizeRipplingUrl,
  rippling,
} from '../src/integrations/ats/rippling.ts';
import { PageError } from '../src/integrations/extraction.ts';

const id = 'ef0b7266-678c-4a23-a439-1a5e7362b604';
const url = `https://ats.rippling.com/example/jobs/${id}`;
const job = {
  uuid: id,
  url,
  name: 'Engineer',
  description: {
    company: '<p>Build &amp; ship.</p>',
    role: '<h2>Requirements</h2><ul><li>Laravel</li></ul><p>Health cover</p>',
  },
  createdOn: '2026-10-20T00:00:00Z',
  workLocations: ['Remote'],
  extra: { opaque: [null, true] },
};

test('Rippling normalizes only safe detail URLs', async () => {
  assert.equal(rippling.selector, 'rippling');
  assert.deepEqual(rippling.hosts, ['ats.rippling.com']);
  assert.equal(rippling.extract, fetchRipplingListing);
  assert.equal(normalizeRipplingUrl(`${url}/?tracking=x#details`), url);
  assert.equal(normalizeRipplingUrl(url.replace(id, id.toUpperCase())), url);
  for (const locale of ['en-US', 'en-GB'])
    assert.equal(
      normalizeRipplingUrl(url.replace('/example/', `/${locale}/example/`)),
      url,
    );
  assert.equal(
    normalizeRipplingUrl(url.replace('/example/', '/Example%20Board/')),
    url.replace('/example/', '/Example%20Board/'),
  );
  for (const invalid of [
    'not a URL',
    url.replace('https:', 'http:'),
    url.replace('ats.rippling.com', 'ats.rippling.com.evil.test'),
    url.replace('ats.rippling.com', 'jobs.rippling.com'),
    url.replace('ats.rippling.com', 'user:pass@ats.rippling.com'),
    url.replace('ats.rippling.com', 'ats.rippling.com:444'),
    url.replace('/jobs/', '/'),
    url.replace(id, 'invalid'),
    `${url}/apply`,
    url.replace('example', 'ex%2Fample'),
    url.replace('example', 'ex%5Cample'),
    url.replace('example', '%ZZ'),
    url.replace('/example/', '/invalid-locale/example/'),
  ]) {
    assert.equal(normalizeRipplingUrl(invalid), null, invalid);
    await assert.rejects(
      fetchRipplingListing(invalid, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Rippling listing URL/,
    );
  }
});

test('Rippling fetches public details, renders both sections and preserves opaque metadata without a posting date', async () => {
  const listing = await fetchRipplingListing(`${url}/?tracking=x#details`, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        `https://api.rippling.com/platform/api/ats/v1/board/example/jobs/${id}`,
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(job);
    },
  });
  const [metadata, description] = listing.text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  const { description: _description, ...expected } = job;
  assert.deepEqual(JSON.parse(metadata), expected);
  assert.match(description, /Build & ship/);
  assert.match(description, /Requirements/i);
  assert.match(description, /Laravel/);
  assert.match(description, /Health cover/);
  assert.doesNotMatch(description, /<p>|<li>|&amp;/);
  assert.equal(listing.postedAt, null);
  assert.deepEqual(
    await fetchJob('Example Board', id, {
      fetch: async (endpoint) => {
        assert.match(endpoint, /\/board\/Example%20Board\/jobs\//);
        return Response.json(job);
      },
    }),
    job,
  );
});

test('Rippling treats only 404 and 410 as terminal without fallback', async () => {
  for (const status of [400, 401, 403, 404, 408, 410, 422, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchRipplingListing(url, {
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

test('Rippling rejects malformed responses, mismatched identities and empty descriptions', async () => {
  for (const response of [
    null,
    {},
    { ...job, uuid: 'invalid' },
    { ...job, url: null },
    { ...job, description: null },
    { ...job, description: { role: 42 } },
    { ...job, description: { role: '', company: [] } },
  ])
    await assert.rejects(
      fetchJob('example', id, { fetch: async () => Response.json(response) }),
      /Invalid Rippling job response/,
    );
  for (const response of [
    { ...job, uuid: '00000000-0000-0000-0000-000000000000' },
    { ...job, url: url.replace('example', 'other') },
    { ...job, url: url.replace('ats.rippling.com', 'evil.test') },
  ])
    await assert.rejects(
      fetchRipplingListing(url, { fetch: async () => Response.json(response) }),
      /identity mismatch/,
    );
  await assert.rejects(
    fetchRipplingListing(url, {
      fetch: async () =>
        Response.json({
          ...job,
          description: { company: null, role: '<p>&nbsp;</p>' },
        }),
    }),
    /Empty Rippling description/,
  );
  const listing = await fetchRipplingListing(url, {
    fetch: async () =>
      Response.json({ ...job, description: { role: '<p>Laravel</p>' } }),
  });
  assert.match(listing.text, /Laravel/);
  const options = { fetch: async () => assert.fail('unexpected fetch') };
  await assert.rejects(fetchJob('', id, options), /board is required/);
  await assert.rejects(
    fetchJob('example', 'invalid', options),
    /Invalid Rippling job ID/,
  );
});

test('Rippling forwards the 75-second timeout and caller cancellation and propagates network failures', async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchRipplingListing(url, {
        signal: new AbortController().signal,
        fetch: async (_endpoint, options) => options.signal.throwIfAborted(),
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  const controller = new AbortController();
  await assert.rejects(
    fetchRipplingListing(url, {
      signal: controller.signal,
      fetch: async (_endpoint, options) => {
        controller.abort(new Error('Cancelled'));
        options.signal.throwIfAborted();
      },
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchRipplingListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

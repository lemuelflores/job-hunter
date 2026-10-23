import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchJob,
  fetchPolymerListing,
  normalizePolymerUrl,
  polymer,
} from '../dist/integrations/ats/polymer.js';
import { PageError } from '../dist/integrations/extraction.js';

const id = '41538';
const url = `https://jobs.polymer.co/example/${id}`;
const job = {
  id: Number(id),
  job_post_url: url,
  title: 'Engineer',
  description:
    '<h2>About us</h2><p>Build &amp; ship.</p><h2>Requirements</h2><ul><li>Laravel</li></ul><p>Health cover</p>',
  published_at: '2026-10-20T00:00:00Z',
  extra: { opaque: [null, true] },
};

test('Polymer normalizes only safe numeric detail URLs', async () => {
  assert.equal(polymer.selector, 'polymer');
  assert.deepEqual(polymer.hosts, ['jobs.polymer.co']);
  assert.equal(polymer.extract, fetchPolymerListing);
  assert.equal(normalizePolymerUrl(`${url}/?tracking=x#details`), url);
  assert.equal(
    normalizePolymerUrl(url.replace('example', 'Example%20Board')),
    url.replace('example', 'Example%20Board'),
  );
  for (const invalid of [
    'not a URL',
    url.replace('https:', 'http:'),
    url.replace('jobs.polymer.co', 'jobs.polymer.co.evil.test'),
    url.replace('jobs.polymer.co', 'polymer.co'),
    url.replace('jobs.polymer.co', 'user:pass@jobs.polymer.co'),
    url.replace('jobs.polymer.co', 'jobs.polymer.co:444'),
    url.replace(id, 'invalid'),
    url.replace(id, '0'),
    url.replace(id, '-12'),
    url.replace(id, '12.3'),
    `${url}/apply`,
    url.replace('example', 'ex%2Fample'),
    url.replace('example', 'ex%5Cample'),
    url.replace('example', '%ZZ'),
  ]) {
    assert.equal(normalizePolymerUrl(invalid), null, invalid);
    await assert.rejects(
      fetchPolymerListing(invalid, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Polymer listing URL/,
    );
  }
});

test('Polymer fetches public details and renders HTML with opaque metadata and publication date', async () => {
  const listing = await fetchPolymerListing(`${url}/?tracking=x#details`, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        `https://api.polymer.co/v1/hire/organizations/example/jobs/${id}`,
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
  assert.equal(listing.postedAt, job.published_at);
  assert.deepEqual(
    await fetchJob('Example Board', id, {
      fetch: async (endpoint) => {
        assert.match(endpoint, /\/organizations\/Example%20Board\/jobs\//);
        return Response.json(job);
      },
    }),
    job,
  );
});

test('Polymer treats only 404, 410 and exact missing-resource 422 bodies as terminal', async () => {
  for (const status of [400, 401, 403, 404, 408, 410, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchPolymerListing(url, {
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
  for (const message of ['no job found', 'no careers_page found'])
    await assert.rejects(
      fetchPolymerListing(url, {
        fetch: async () =>
          Response.json({ errors: { general: [message] } }, { status: 422 }),
      }),
      (error) => error instanceof PageError && !error.retryable,
    );
  for (const body of [
    null,
    {},
    { errors: { general: 'no job found' } },
    { errors: { general: [] } },
    { errors: { general: ['validation failed'] } },
    { errors: { general: ['no job found', 'no careers_page found'] } },
    { errors: { general: ['no job found', 'other error'] } },
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchPolymerListing(url, {
        fetch: async () => {
          assert.equal(++calls, 1);
          return Response.json(body, { status: 422 });
        },
      }),
      (error) => !(error instanceof PageError) && /422/.test(error.message),
    );
  }
  await assert.rejects(
    fetchPolymerListing(url, {
      fetch: async () => new Response('invalid JSON', { status: 422 }),
    }),
    (error) => !(error instanceof PageError),
  );
});

test('Polymer rejects malformed responses, identity mismatches and empty descriptions', async () => {
  for (const response of [
    null,
    {},
    { ...job, id },
    { ...job, id: 1.5 },
    { ...job, job_post_url: null },
    { ...job, description: null },
    { ...job, published_at: 42 },
  ])
    await assert.rejects(
      fetchJob('example', id, { fetch: async () => Response.json(response) }),
      /Invalid Polymer job response/,
    );
  for (const response of [
    { ...job, id: 123 },
    { ...job, job_post_url: url.replace('example', 'other') },
    { ...job, job_post_url: url.replace('jobs.polymer.co', 'evil.test') },
  ])
    await assert.rejects(
      fetchPolymerListing(url, { fetch: async () => Response.json(response) }),
      /identity mismatch/,
    );
  await assert.rejects(
    fetchPolymerListing(url, {
      fetch: async () =>
        Response.json({ ...job, description: '<p>&nbsp;</p>' }),
    }),
    /Empty Polymer description/,
  );
  for (const published_at of [null, undefined]) {
    const listing = await fetchPolymerListing(url, {
      fetch: async () => Response.json({ ...job, published_at }),
    });
    assert.equal(listing.postedAt, null);
  }
  const options = { fetch: async () => assert.fail('unexpected fetch') };
  await assert.rejects(fetchJob('', id, options), /organization is required/);
  await assert.rejects(
    fetchJob('example', 'invalid', options),
    /Invalid Polymer job ID/,
  );
});

test('Polymer forwards the 75-second timeout and caller cancellation and propagates network failures', async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchPolymerListing(url, {
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
    fetchPolymerListing(url, {
      signal: controller.signal,
      fetch: async (_endpoint, options) => {
        controller.abort(new Error('Cancelled'));
        options.signal.throwIfAborted();
      },
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchPolymerListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

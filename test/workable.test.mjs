import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchJob,
  fetchWorkableListing,
} from '../src/integrations/ats/workable.ts';
import { PageError } from '../src/integrations/extraction.ts';

const id = 'AB1234CDEF';
const url = `https://apply.workable.com/example/j/${id}`;
const job = {
  shortcode: id,
  title: 'Backend engineer',
  description: '<p>Build Laravel &amp; PostgreSQL services.</p>',
  requirements: '<ul><li>Remote from the Philippines only</li></ul>',
  benefits: '<p><a href="https://example.test/benefits">Health cover</a></p>',
  published: '2026-10-20T00:00:00Z',
  workplace: 'remote',
  locations: [{ country: 'Philippines', hidden: false }],
  extra: { opaque: [null, true] },
};

test('Workable requests public details and renders all sections with opaque metadata and publication date', async () => {
  const listing = await fetchWorkableListing(`${url}/?tracking=x#details`, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        `https://apply.workable.com/api/v2/accounts/example/jobs/${id}`,
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(job);
    },
  });
  const [metadata, description] = listing.text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  const {
    description: _description,
    requirements: _requirements,
    benefits: _benefits,
    ...expected
  } = job;
  assert.deepEqual(JSON.parse(metadata), expected);
  assert.match(description, /Build Laravel & PostgreSQL services/);
  assert.match(
    description,
    /Requirements\n.*Remote from the Philippines only/s,
  );
  assert.match(
    description,
    /Benefits\nHealth cover \[https:\/\/example.test\/benefits\]/,
  );
  assert.doesNotMatch(listing.text, /<p>|<li>|&amp;/);
  assert.equal(listing.postedAt, job.published);
});

test('Workable resolves short links only to the same listing on its own host', async () => {
  const requests = [];
  const listing = await fetchWorkableListing(
    `https://apply.workable.com/j/${id}`,
    {
      fetch: async (endpoint, options) => {
        requests.push(endpoint);
        if (requests.length === 1) {
          assert.equal(options.redirect, 'manual');
          return new Response(null, {
            status: 301,
            headers: { location: `/example/j/${id}/` },
          });
        }
        return Response.json(job);
      },
    },
  );
  assert.match(listing.text, /Backend engineer/);
  assert.deepEqual(requests, [
    `https://apply.workable.com/j/${id}`,
    `https://apply.workable.com/api/v2/accounts/example/jobs/${id}`,
  ]);
  for (const location of [
    'https://evil.test/example/j/AB1234CDEF',
    '/example/j/0000000000',
    `/j/${id}`,
    `/example/j/${id}/apply`,
    `http://apply.workable.com/example/j/${id}`,
    '',
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchWorkableListing(`https://apply.workable.com/j/${id}`, {
        fetch: async () => {
          assert.equal(++calls, 1);
          return new Response(null, { status: 302, headers: { location } });
        },
      }),
      /Invalid Workable short-link redirect/,
    );
  }
});

test('Workable treats only missing/gone details and short links as terminal', async () => {
  for (const listing of [url, `https://apply.workable.com/j/${id}`])
    for (const status of [400, 401, 403, 404, 408, 410, 425, 429, 500, 503])
      await assert.rejects(
        fetchWorkableListing(listing, {
          fetch: async () => new Response(null, { status }),
        }),
        (error) =>
          [404, 410].includes(status)
            ? error instanceof PageError && !error.retryable
            : !(error instanceof PageError) &&
              error.message.includes(String(status)),
      );
});

test('Workable rejects malformed responses, mismatched identities and empty descriptions retryably', async () => {
  for (const response of [
    null,
    {},
    { ...job, shortcode: 'invalid' },
    { ...job, description: null },
    { ...job, requirements: 42 },
    { ...job, benefits: [] },
  ])
    await assert.rejects(
      fetchJob('example', id, { fetch: async () => Response.json(response) }),
      /Invalid Workable job response/,
    );
  await assert.rejects(
    fetchWorkableListing(url, {
      fetch: async () => Response.json({ ...job, shortcode: '0000000000' }),
    }),
    /shortcode mismatch/,
  );
  await assert.rejects(
    fetchWorkableListing(url, {
      fetch: async () =>
        Response.json({
          shortcode: id,
          description: '<p>&nbsp;</p><script>ignored</script>',
        }),
    }),
    /Empty Workable description/,
  );
  const listing = await fetchWorkableListing(url, {
    fetch: async () =>
      Response.json({
        shortcode: id.toLowerCase(),
        description: '',
        requirements: '<p>Laravel</p>',
        benefits: null,
      }),
  });
  assert.match(listing.text, /Requirements\nLaravel/);
  assert.equal(listing.postedAt, null);
});

test('Workable validates request identity before network access', async () => {
  const options = { fetch: async () => assert.fail('unexpected fetch') };
  for (const invalid of [
    url.replace('https:', 'http:'),
    `${url}/apply`,
    url.replace(id, 'invalid'),
    url.replace('apply.workable.com', 'example.test'),
  ])
    await assert.rejects(
      fetchWorkableListing(invalid, options),
      /Invalid Workable listing URL/,
    );
  await assert.rejects(
    fetchJob('', id, options),
    /Workable account is required/,
  );
  await assert.rejects(
    fetchJob('example', 'invalid', options),
    /Invalid Workable shortcode/,
  );
});

test('Workable encodes the account and propagates timeout, cancellation and network failures', async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchJob('Example Board', id.toLowerCase(), {
        fetch: async (endpoint, options) => {
          assert.equal(
            endpoint,
            `https://apply.workable.com/api/v2/accounts/Example%20Board/jobs/${id}`,
          );
          options.signal.throwIfAborted();
        },
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  for (const listing of [url, `https://apply.workable.com/j/${id}`])
    await assert.rejects(
      fetchWorkableListing(listing, {
        signal: AbortSignal.abort(new Error('Cancelled')),
        fetch: async (_endpoint, options) => options.signal.throwIfAborted(),
      }),
      /Cancelled/,
    );
  await assert.rejects(
    fetchWorkableListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATS_DEFINITIONS,
  GOOGLE_ATS,
  normalizeJobUrl,
} from '../src/entrypoints/compose.ts';
import {
  fetchGemListing,
  fetchJob,
  gem,
  normalizeGemUrl,
} from '../src/integrations/ats/gem.ts';
import { PageError } from '../src/integrations/extraction.ts';

const id = 'am9icG9zdDo9c6jW7mtOuHjHM3IfuJzM';
const url = `https://jobs.gem.com/example/${id}`;
const job = {
  id,
  absolute_url: url,
  title: 'Staff Platform Engineer',
  content: '<p>HTML must not reach assessments</p>',
  content_plain: 'Build & ship platform services with Laravel.',
  first_published_at: '2026-10-20T00:00:00.000Z',
  location: { name: 'Remote' },
  location_type: 'remote',
  employment_type: 'full_time',
  extra: { opaque: [null, true] },
};

test('Gem normalizes only safe detail URLs and is registered for discovery and extraction', async () => {
  assert.equal(gem.selector, 'gem');
  assert.deepEqual(gem.hosts, ['jobs.gem.com']);
  assert.equal(gem.extract, fetchGemListing);
  assert.ok(GOOGLE_ATS.includes('gem'));
  assert.equal(
    ATS_DEFINITIONS.find((ats) => ats.selector === 'gem').extract,
    fetchGemListing,
  );
  assert.equal(normalizeGemUrl(`${url}/?tracking=x#details`), url);
  assert.equal(normalizeJobUrl(`${url}?utm_source=google`), url);
  assert.equal(
    normalizeGemUrl('https://jobs.gem.com/gem/4965519002'),
    'https://jobs.gem.com/gem/4965519002',
  );
  assert.equal(
    normalizeGemUrl(url.replace('example', 'Example%20Board')),
    url.replace('example', 'Example%20Board'),
  );
  for (const invalid of [
    'not a URL',
    url.replace('https:', 'http:'),
    url.replace('jobs.gem.com', 'jobs.gem.com.evil.test'),
    url.replace('jobs.gem.com', 'gem.com'),
    url.replace('jobs.gem.com', 'user:pass@jobs.gem.com'),
    url.replace('jobs.gem.com', 'jobs.gem.com:444'),
    'https://jobs.gem.com/example',
    `${url}/application`,
    `${url}/apply`,
    url.replace(id, 'invalid!id'),
    url.replace('example', 'ex%2Fample'),
    url.replace('example', 'ex%5Cample'),
    url.replace('example', '%ZZ'),
  ]) {
    assert.equal(normalizeGemUrl(invalid), null, invalid);
    await assert.rejects(
      fetchGemListing(invalid, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Gem listing URL/,
    );
  }
});

test('Gem fetches public details, preserves plain text and opaque metadata while omitting HTML content', async () => {
  const listing = await fetchGemListing(`${url}/?tracking=x#details`, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        `https://api.gem.com/job_board/v0/example/job_posts/${id}`,
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(job);
    },
  });
  const [metadata, description] = listing.text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  const { content: _content, content_plain, ...expected } = job;
  assert.deepEqual(JSON.parse(metadata), expected);
  assert.equal(description, content_plain);
  assert.doesNotMatch(listing.text, /HTML must not reach assessments|<p>/);
  assert.equal(listing.title, job.title);
  assert.equal(listing.postedAt, job.first_published_at);
  assert.deepEqual(
    await fetchJob('Example Board', id, {
      fetch: async (endpoint) => {
        assert.match(endpoint, /\/job_board\/v0\/Example%20Board\/job_posts\//);
        return Response.json(job);
      },
    }),
    job,
  );
});

test('Gem treats only 404 and 410 as terminal without fallback', async () => {
  for (const status of [400, 401, 403, 404, 408, 410, 422, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchGemListing(url, {
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

test('Gem rejects malformed responses, mismatched identities and empty descriptions', async () => {
  for (const response of [
    null,
    {},
    { ...job, id: null },
    { ...job, id: 'invalid!id' },
    { ...job, absolute_url: null },
    { ...job, content_plain: null },
    { ...job, first_published_at: 42 },
  ])
    await assert.rejects(
      fetchJob('example', id, { fetch: async () => Response.json(response) }),
      /Invalid Gem job response/,
    );
  for (const response of [
    { ...job, id: id.toLowerCase() },
    { ...job, id: '4965519002' },
    { ...job, absolute_url: url.replace('example', 'other') },
    { ...job, absolute_url: url.replace('jobs.gem.com', 'evil.test') },
  ])
    await assert.rejects(
      fetchGemListing(url, { fetch: async () => Response.json(response) }),
      /identity mismatch/,
    );
  for (const content_plain of ['', '   \n\t  '])
    await assert.rejects(
      fetchGemListing(url, {
        fetch: async () => Response.json({ ...job, content_plain }),
      }),
      /Empty Gem description/,
    );
  for (const first_published_at of [null, undefined]) {
    const listing = await fetchGemListing(url, {
      fetch: async () =>
        Response.json({ ...job, title: undefined, first_published_at }),
    });
    assert.equal(listing.postedAt, null);
    assert.equal(listing.title, undefined);
  }
  const options = { fetch: async () => assert.fail('unexpected fetch') };
  await assert.rejects(fetchJob('', id, options), /board is required/);
  await assert.rejects(
    fetchJob('example', 'invalid!id', options),
    /Invalid Gem job ID/,
  );
});

test('Gem forwards the 75-second timeout and caller cancellation and propagates network failures', async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchGemListing(url, {
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
    fetchGemListing(url, {
      signal: controller.signal,
      fetch: async (_endpoint, options) => {
        controller.abort(new Error('Cancelled'));
        options.signal.throwIfAborted();
      },
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchGemListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATS_DEFINITIONS,
  GOOGLE_ATS,
  normalizeJobUrl,
} from '../src/entrypoints/compose.ts';
import {
  fetchHimalayasListing,
  normalizeHimalayasUrl,
} from '../src/integrations/ats/himalayas.ts';
import { PageError } from '../src/integrations/extraction.ts';

const url = 'https://himalayas.app/companies/linear/jobs/senior-engineer';
const job = () => ({
  guid: url,
  description: '<h2>Role</h2><p>Build &amp; ship.</p>',
  pubDate: 1793276907,
  title: 'Engineer',
  applicationLink: `${url}?utm_source=api`,
});

test('Himalayas detail URLs are normalized and registered for discovery and extraction', () => {
  assert.equal(normalizeHimalayasUrl(`${url}/?ref=search#role`), url);
  assert.equal(normalizeJobUrl(url), url);
  assert.ok(GOOGLE_ATS.includes('himalayas'));
  assert.equal(
    ATS_DEFINITIONS.find((item) => item.selector === 'himalayas').extract,
    fetchHimalayasListing,
  );
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('himalayas.app', 'evil.himalayas.app'),
    url.replace('himalayas.app', 'user@himalayas.app'),
    url.replace('/companies/', '/jobs/'),
    `${url}/apply`,
    url.replace('linear', 'a%2Fb'),
    url.replace('linear', '..'),
  ]) {
    assert.equal(normalizeHimalayasUrl(invalid), null, invalid);
  }
});

test('Himalayas fetches full details, preserving metadata without treating update time as posting time', async () => {
  const listing = await fetchHimalayasListing(`${url}?tracking=1`, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        'https://himalayas.app/jobs/api/companies/linear/jobs/senior-engineer',
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ job: job() });
    },
  });
  assert.match(listing.text, /Build & ship/);
  assert.match(listing.text, /"title": "Engineer"/);
  assert.match(listing.text, /utm_source=api/);
  assert.doesNotMatch(listing.text, /<h2>|<p>/);
  assert.equal(listing.postedAt ?? null, null);
});

test('Himalayas distinguishes closed jobs from missing API paths and transient failures', async () => {
  for (const status of [404, 410, 429, 500]) {
    await assert.rejects(
      fetchHimalayasListing(url, {
        fetch: async () => new Response(null, { status }),
      }),
      (error) =>
        status === 410
          ? error instanceof PageError && !error.retryable
          : !(error instanceof PageError) &&
            error.message.includes(String(status)),
    );
  }
});

test('Himalayas rejects malformed responses, mismatched identities and empty descriptions', async () => {
  for (const body of [
    null,
    {},
    { job: { ...job(), guid: null } },
    { job: { ...job(), description: null } },
  ]) {
    await assert.rejects(
      fetchHimalayasListing(url, { fetch: async () => Response.json(body) }),
      /Invalid Himalayas job response/,
    );
  }
  await assert.rejects(
    fetchHimalayasListing(url, {
      fetch: async () =>
        Response.json({
          job: { ...job(), guid: url.replace('linear', 'other') },
        }),
    }),
    /identity mismatch/,
  );
  await assert.rejects(
    fetchHimalayasListing(url, {
      fetch: async () =>
        Response.json({ job: { ...job(), description: '<p>&nbsp;</p>' } }),
    }),
    /Empty Himalayas description/,
  );
  await assert.rejects(
    fetchHimalayasListing('https://evil.test/', {
      fetch: async () => assert.fail('unexpected fetch'),
    }),
    /Invalid Himalayas listing URL/,
  );
});

test('Himalayas forwards caller cancellation and network errors', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(
    fetchHimalayasListing(url, {
      signal: controller.signal,
      fetch: async (_endpoint, options) => options.signal.throwIfAborted(),
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchHimalayasListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

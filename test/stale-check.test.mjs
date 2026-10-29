import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAshbyListing } from '../src/integrations/ats/ashby.ts';
import { PageError } from '../src/integrations/extraction.ts';
import {
  checkAvailability,
  rateLimitDelay,
} from '../src/workflow/stale-check.ts';

test('confirmed missing listings are stale', async () => {
  const result = await checkAvailability(
    'https://example.com/job',
    async () => {
      throw new PageError(404);
    },
  );
  assert.equal(result.kind, 'missing');
});

test('failed checks are inconclusive', async () => {
  const result = await checkAvailability(
    'https://example.com/job',
    async () => {
      throw new Error('invalid response');
    },
  );
  assert.equal(result.kind, 'inconclusive');
});

test('rate-limit delays respect Retry-After and increase the fallback', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.equal(rateLimitDelay(null, 1, now), 60_000);
  assert.equal(rateLimitDelay(null, 2, now), 120_000);
  assert.equal(rateLimitDelay('300', 1, now), 300_000);
  assert.equal(
    rateLimitDelay('Thu, 29 Oct 2026 00:05:00 GMT', 1, now),
    300_000,
  );
  assert.equal(rateLimitDelay('invalid', 1, now), 60_000);
});

test('a validated board missing the listing is classified as missing', async () => {
  const url =
    'https://jobs.ashbyhq.com/example/12345678-abcd-abcd-abcd-123456789abc';
  const result = await checkAvailability(url, fetchAshbyListing, async () =>
    Response.json({ jobs: [] }),
  );
  assert.deepEqual(result, { kind: 'missing' });
});

test('a missing board is inconclusive rather than a missing listing', async () => {
  const url =
    'https://jobs.ashbyhq.com/example/12345678-abcd-abcd-abcd-123456789abc';
  const result = await checkAvailability(
    url,
    fetchAshbyListing,
    async () => new Response('', { status: 404 }),
  );
  assert.equal(result.kind, 'inconclusive');
});

test('rate limits retain Retry-After even when the adapter discards headers', async () => {
  const url =
    'https://jobs.ashbyhq.com/example/12345678-abcd-abcd-abcd-123456789abc';
  const result = await checkAvailability(
    url,
    fetchAshbyListing,
    async () =>
      new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
  );
  assert.deepEqual(result, { kind: 'rate-limited', retryAfter: '120' });
});

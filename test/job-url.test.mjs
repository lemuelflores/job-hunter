import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeJobUrl } from '../src/entrypoints/compose.ts';
import {
  matchesAtsHost,
  parseListingUrl,
} from '../src/integrations/ats/url.ts';

test('listing URLs accept supported shapes and strip tracking', () => {
  // Arrange: use a valid UUID listing identifier across supported hosts.
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const host of [
    'jobs.ashbyhq.com',
    'jobs.lever.co',
    'jobs.eu.lever.co',
  ]) {
    // Arrange: construct this provider's canonical listing URL.
    const url = `https://${host}/example/${uuid}`;
    // Act / Assert: strip tracking while retaining the canonical listing URL.
    assert.equal(normalizeJobUrl(`${url}?utm_source=google#details`), url);
    assert.equal(
      normalizeJobUrl(`https://${host}/example/${uuid.toUpperCase()}`),
      url,
    );
  }
  for (const host of ['boards.greenhouse.io', 'job-boards.greenhouse.io']) {
    // Arrange: use either supported Greenhouse hostname.
    // Act / Assert: normalize to the canonical URL.
    assert.equal(
      normalizeJobUrl(`https://${host}/example/jobs/1?tracking=x`),
      'https://job-boards.greenhouse.io/example/jobs/1',
    );
  }
  for (const path of ['example/j', 'j'])
    assert.equal(
      normalizeJobUrl(
        `https://apply.workable.com/${path}/ab1234cdef/?source=x#top`,
      ),
      `https://apply.workable.com/${path}/AB1234CDEF`,
    );
});

test('listing URLs reject unsupported hosts, paths and unsafe components', () => {
  // Arrange: cover unsupported hosts, paths, protocols, credentials, and encodings.
  const uuid = '12345678-1234-1234-1234-123456789abc';
  for (const url of [
    'https://evil.test/example/jobs/1',
    'https://apply.workable.com/example',
    'https://apply.workable.com/example/j/AB1234CDEF/apply',
    'https://apply.workable.com/j/AB1234CDEF/apply',
    'https://apply.workable.com/example/jobs/AB1234CDEF',
    'https://apply.workable.com/example/j/not-a-code',
    'https://apply.workable.com/ex%2Fample/j/AB1234CDEF',
    'https://apply.workable.com:8443/example/j/AB1234CDEF',
    'http://apply.workable.com/example/j/AB1234CDEF',
    'https://user:pass@apply.workable.com/example/j/AB1234CDEF',
    'https://jobs.lever.co/example',
    `https://jobs.lever.co/example/${uuid}/apply`,
    `http://jobs.lever.co/example/${uuid}`,
    `https://jobs.lever.co:8443/example/${uuid}`,
    'https://u:p@job-boards.greenhouse.io/example/jobs/1',
    `https://jobs.lever.co/ex%2Fample/${uuid}`,
    `https://jobs.lever.co/ex%5Cample/${uuid}`,
    `https://jobs.lever.co/ex%ZZample/${uuid}`,
  ]) {
    // Act / Assert: reject each unsafe or unsupported listing URL.
    assert.equal(normalizeJobUrl(url), null, url);
  }
});

test('tenant host patterns accept exactly one DNS label without broadening fixed hosts', () => {
  const hosts = ['*.breezy.hr'];
  assert.ok(matchesAtsHost('example-company.breezy.hr', hosts));
  assert.ok(parseListingUrl('https://example.breezy.hr/p/123', hosts));
  for (const host of [
    'breezy.hr',
    'evil.example.breezy.hr',
    'example.breezy.hr.evil.test',
    '-example.breezy.hr',
    'example-.breezy.hr',
  ])
    assert.equal(matchesAtsHost(host, hosts), false, host);
  assert.equal(matchesAtsHost('evil.jobs.lever.co', ['jobs.lever.co']), false);
  for (const url of [
    'http://example.breezy.hr/p/123',
    'https://u:p@example.breezy.hr/p/123',
    'https://example.breezy.hr:8080/p/123',
    'https://example.breezy.hr/p/ex%2Fample',
  ])
    assert.equal(parseListingUrl(url, hosts), null, url);
});

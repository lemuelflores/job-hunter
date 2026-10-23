import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATS_DEFINITIONS,
  normalizeJobUrl,
} from '../src/entrypoints/compose.ts';
import {
  fetchJob,
  fetchSmartrecruitersListing,
} from '../src/integrations/ats/smartrecruiters.ts';
import { PageError } from '../src/integrations/extraction.ts';

const url = 'https://jobs.smartrecruiters.com/Example/123';
const job = {
  id: '123',
  releasedDate: '2026-10-23T01:00:00Z',
  location: { remote: true, country: 'PH' },
  jobAd: {
    sections: {
      jobDescription: { title: 'Role', text: '<p>Build services</p>' },
      qualifications: {
        title: 'Qualifications',
        text: '<ul><li>PHP &amp; Vue</li></ul>',
      },
      additionalInformation: {
        title: 'Other',
        text: '<p>Philippines only</p>',
      },
    },
  },
};

test('SmartRecruiters canonicalizes numeric posting identity and rejects unsafe URLs', () => {
  assert.ok(
    ATS_DEFINITIONS.find((ats) => ats.selector === 'smartrecruiters').extract,
  );
  assert.equal(normalizeJobUrl(`${url}-engineer/?tracking=1#top`), url);
  for (const invalid of [
    url.replace('https:', 'http:'),
    `${url}/apply`,
    url.replace('123', 'no-id'),
    url.replace('Example', 'ex%2Fample'),
    url.replace('jobs.', 'evil.jobs.'),
    url.replace('jobs.', 'user:pass@jobs.'),
    url.replace('.com/', '.com:8080/'),
  ])
    assert.equal(normalizeJobUrl(invalid), null, invalid);
});

test('SmartRecruiters requests full details, renders every section and preserves metadata/date', async () => {
  const listing = await fetchSmartrecruitersListing(url, {
    fetch: async (endpoint, options) => {
      assert.equal(
        endpoint,
        'https://api.smartrecruiters.com/v1/companies/Example/postings/123',
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(job);
    },
  });
  assert.match(listing.text, /Role\nBuild services/);
  assert.match(listing.text, /Qualifications\n.*PHP & Vue/s);
  assert.match(listing.text, /Philippines only/);
  assert.match(listing.text, /"country": "PH"/);
  assert.doesNotMatch(listing.text, /<p>|&amp;/);
  assert.equal(listing.postedAt, job.releasedDate);
});

test('SmartRecruiters treats only missing responses as terminal; bad data stays retryable', async () => {
  for (const status of [401, 403, 404, 408, 410, 425, 429, 500])
    await assert.rejects(
      fetchSmartrecruitersListing(url, {
        fetch: async () => new Response('', { status }),
      }),
      (error) =>
        [404, 410].includes(status)
          ? error instanceof PageError && !error.retryable
          : !(error instanceof PageError),
    );
  for (const invalid of [
    null,
    {},
    { ...job, id: '999' },
    { ...job, jobAd: { sections: {} } },
    {
      ...job,
      jobAd: { sections: { role: { title: 'Role', text: '<p> </p>' } } },
    },
  ])
    await assert.rejects(
      fetchSmartrecruitersListing(url, {
        fetch: async () => Response.json(invalid),
      }),
      (error) => !(error instanceof PageError),
    );
  await assert.rejects(
    fetchJob('', '123', { fetch: async () => assert.fail('unexpected HTTP') }),
  );
  await assert.rejects(
    fetchSmartrecruitersListing(`${url}/apply`, {
      fetch: async () => assert.fail('unexpected HTTP'),
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchSmartrecruitersListing(url, {
      signal: controller.signal,
      fetch: async (_, options) => {
        options.signal.throwIfAborted();
      },
    }),
    { name: 'AbortError' },
  );
});

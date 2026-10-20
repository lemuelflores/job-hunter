import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAshbyListing } from '../dist/review/ashby.js';
import { PageError } from '../dist/review/extraction.js';

const ashbyId = '12345678-abcd-abcd-abcd-123456789abc';
const ashbyUrl = `https://jobs.ashbyhq.com/Example%20Board/${ashbyId}`;
const posting = {
  jobUrl: ashbyUrl,
  title: 'Backend engineer',
  department: 'Engineering',
  team: 'Platform',
  location: 'Manila',
  address: { postalAddress: { addressCountry: 'Philippines' } },
  secondaryLocations: [
    { location: 'Singapore', address: { addressCountry: 'SG' } },
  ],
  workplaceType: 'Hybrid',
  isRemote: true,
  employmentType: 'FullTime',
  compensation: { compensationTierSummary: 'PHP 100–200 per year' },
  descriptionHtml: '<p>HTML must not reach assessments</p>',
  publishedAt: '2026-09-04T21:29:33.316+00:00',
  newProviderField: { nested: [true, null, 42] },
  descriptionPlain: 'Build services with Laravel and PostgreSQL.',
};

test('Ashby selects the exact UUID and preserves description and structured metadata', async () => {
  const text = await fetchAshbyListing(ashbyUrl, {
    fetch: async () => {
      return Response.json({
        jobs: [
          {
            ...posting,
            jobUrl: ashbyUrl.replace(
              ashbyId,
              '00000000-0000-0000-0000-000000000000',
            ),
            descriptionPlain: 'WRONG',
          },
          posting,
        ],
      });
    },
  });
  const metadata = JSON.parse(
    text.split('metadata:\n')[1].split('\n\nDescription:')[0],
  );
  const { descriptionHtml: _html, descriptionPlain, ...expected } = posting;
  assert.deepEqual(metadata, expected);
  assert.ok(text.endsWith(descriptionPlain));
  assert.ok(!text.includes('WRONG'));
  assert.ok(!text.includes('HTML must not reach assessments'));
});

test('a valid board without the UUID is terminal, including an empty board', async () => {
  for (const jobs of [
    [],
    [
      {
        ...posting,
        jobUrl: ashbyUrl.replace(
          ashbyId,
          '00000000-0000-0000-0000-000000000000',
        ),
      },
    ],
  ]) {
    await assert.rejects(
      fetchAshbyListing(ashbyUrl, {
        fetch: async () => Response.json({ jobs }),
      }),
      (error) =>
        error instanceof PageError &&
        !error.retryable &&
        /absent/.test(error.message),
    );
  }
});

test('selection uses canonical jobUrl identity, not undocumented id', async () => {
  const text = await fetchAshbyListing(ashbyUrl, {
    fetch: async () =>
      Response.json({
        jobs: [
          {
            ...posting,
            id: 'not-the-requested-uuid',
            jobUrl: `${ashbyUrl.replace(ashbyId, ashbyId.toUpperCase())}?tracking=1#details`,
          },
        ],
      }),
  });
  assert.ok(text.endsWith(posting.descriptionPlain));
  assert.ok(text.includes('not-the-requested-uuid'));
});

test('unsupported posting identities fail retryably', async () => {
  for (const jobUrl of [
    `https://example.test/board/${ashbyId}`,
    `https://jobs.ashbyhq.com/other-board/${ashbyId}`,
    `${ashbyUrl}/application`,
  ]) {
    await assert.rejects(
      fetchAshbyListing(ashbyUrl, {
        fetch: async () => Response.json({ jobs: [{ ...posting, jobUrl }] }),
      }),
      {
        message:
          'Invalid Ashby posting URL at index 0 on board Example%20Board',
      },
    );
  }
});

test('posting identities are still validated after finding a match', async () => {
  await assert.rejects(
    fetchAshbyListing(ashbyUrl, {
      fetch: async () =>
        Response.json({
          jobs: [
            posting,
            {
              ...posting,
              jobUrl: `https://example.test/board/${ashbyId}`,
            },
          ],
        }),
    }),
    {
      message: 'Invalid Ashby posting URL at index 1 on board Example%20Board',
    },
  );
});

test('empty and ambiguous selected listings fail retryably', async () => {
  for (const descriptionPlain of ['', '  ', undefined]) {
    await assert.rejects(
      fetchAshbyListing(ashbyUrl, {
        fetch: async () =>
          Response.json({ jobs: [{ ...posting, descriptionPlain }] }),
      }),
      { message: 'Empty or invalid Ashby description' },
    );
  }
  await assert.rejects(
    fetchAshbyListing(ashbyUrl, {
      fetch: async () => Response.json({ jobs: [posting, posting] }),
    }),
    { message: 'Ambiguous Ashby listing' },
  );
});

test('metadata passes through unchanged, including nulls and extra provider fields', async () => {
  const text = await fetchAshbyListing(ashbyUrl, {
    fetch: async () =>
      Response.json({
        jobs: [
          {
            jobUrl: ashbyUrl,
            title: 'Engineer',
            descriptionPlain: 'Laravel services',
            location: null,
            compensation: {
              compensationTierSummary: null,
              scrapeableCompensationSalarySummary: null,
              compensationTiers: [],
              summaryComponents: [],
            },
            extra: { preserved: true },
          },
        ],
      }),
  });
  assert.ok(text.includes('Laravel services'));
  const metadata = JSON.parse(
    text.split('metadata:\n')[1].split('\n\nDescription:')[0],
  );
  assert.deepEqual(metadata, {
    jobUrl: ashbyUrl,
    title: 'Engineer',
    location: null,
    compensation: {
      compensationTierSummary: null,
      scrapeableCompensationSalarySummary: null,
      compensationTiers: [],
      summaryComponents: [],
    },
    extra: { preserved: true },
  });
});

test('Ashby rejects invalid URLs before fetching', async () => {
  for (const url of [
    `http://jobs.ashbyhq.com/board/${ashbyId}`,
    `https://jobs.ashbyhq.com/board%2Fother/${ashbyId}`,
    `https://jobs.ashbyhq.com/board/${ashbyId}/application`,
    `https://example.test/board/${ashbyId}`,
  ])
    await assert.rejects(
      fetchAshbyListing(url, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Ashby/,
    );
});

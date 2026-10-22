import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLeverListing } from '../dist/review/extraction/lever.js';
import { PageError } from '../dist/review/extraction/types.js';

const id = '12345678-abcd-abcd-abcd-123456789abc';
const url = `https://jobs.lever.co/Example%20Board/${id}`;
const metadata = {
  id,
  text: 'Backend engineer',
  categories: {
    location: 'Philippines',
    allLocations: ['Philippines', 'Singapore'],
  },
  workplaceType: 'remote',
  country: 'PH',
  salaryRange: {
    currency: 'USD',
    min: 50000,
    max: 80000,
    interval: 'per-year',
  },
  extra: { nested: [null, true] },
};

test('Lever renders all description sections and preserves opaque metadata without duplicate HTML', async () => {
  const posting = {
    ...metadata,
    descriptionPlain: 'Remote from the Philippines. Generics <T> & APIs.',
    lists: [
      {
        text: 'Requirements',
        content:
          '<ul><li>Laravel &amp; PostgreSQL</li><li><a href="https://example.test/policy">Policy</a></li></ul><script>unwanted</script>',
      },
    ],
    additionalPlain: 'Must overlap Singapore hours.',
    salaryDescriptionPlain: 'Salary depends on location.',
    description: 'duplicate HTML',
    opening: 'duplicate HTML',
    openingPlain: 'duplicate opening',
    descriptionBody: 'duplicate HTML',
    descriptionBodyPlain: 'duplicate body',
    additional: 'duplicate HTML',
    salaryDescription: 'duplicate HTML',
  };
  const { text } = await fetchLeverListing(`${url}?tracking=1#details`, {
    fetch: async () => Response.json(posting),
  });
  const [savedMetadata, description] = text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  assert.deepEqual(JSON.parse(savedMetadata), metadata);
  assert.match(
    description,
    /Remote from the Philippines\. Generics <T> & APIs\./,
  );
  assert.match(description, /Requirements\n/);
  assert.match(description, /Laravel & PostgreSQL/);
  assert.match(description, /Policy \[https:\/\/example.test\/policy\]/);
  assert.match(description, /Must overlap Singapore hours\./);
  assert.match(description, /Salary depends on location\./);
  assert.doesNotMatch(text, /duplicate|unwanted|<li>|&amp;/);
});

test('Lever includes list-only descriptions and compares UUIDs case-insensitively', async () => {
  const { text } = await fetchLeverListing(url.replace(id, id.toUpperCase()), {
    fetch: async () =>
      Response.json({
        id,
        descriptionPlain: '',
        lists: [{ text: 'Role', content: '<p>Build services</p>' }],
      }),
  });
  assert.match(text, /Role\nBuild services/);
});

test('Lever marks only 404 and 410 terminal', async () => {
  for (const status of [400, 401, 403, 404, 408, 410, 425, 429, 500, 503])
    await assert.rejects(
      fetchLeverListing(url, {
        fetch: async () => new Response('', { status }),
      }),
      (error) =>
        [404, 410].includes(status)
          ? error instanceof PageError && !error.retryable
          : !(error instanceof PageError) &&
            error.message.includes(String(status)),
    );
});

test('Lever rejects empty descriptions and mismatched IDs retryably', async () => {
  for (const posting of [
    { id, descriptionPlain: '', lists: [] },
    {
      id,
      descriptionPlain: '  ',
      lists: [
        {
          text: 'Requirements',
          content: '<p>&nbsp;</p><script>ignored</script>',
        },
      ],
    },
  ])
    await assert.rejects(
      fetchLeverListing(url, {
        fetch: async () => Response.json(posting),
      }),
      /Empty Lever description/,
    );
  await assert.rejects(
    fetchLeverListing(url, {
      fetch: async () =>
        Response.json({
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          descriptionPlain: 'Wrong job',
          lists: [],
        }),
    }),
    /Lever listing ID mismatch/,
  );
});

test('Lever rejects unsupported listing URLs before fetching', async () => {
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('Example%20Board', 'board%2Fother'),
    `${url}/apply`,
    url.replace(id, 'invalid'),
    url.replace('jobs.lever.co', 'example.test'),
    url.replace('jobs.lever.co', 'jobs.ashbyhq.com'),
  ])
    await assert.rejects(
      fetchLeverListing(invalid, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Lever listing URL/,
    );
});

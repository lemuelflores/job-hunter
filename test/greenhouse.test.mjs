import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeHTML } from 'entities';
import { fetchGreenhouseListing } from '../dist/review/extraction/greenhouse.js';
import { PageError } from '../dist/review/extraction/types.js';

const url = 'https://job-boards.greenhouse.io/Example%20Board/jobs/123';
const metadata = {
  id: 123,
  title: 'Backend engineer',
  company_name: 'Example',
  location: { name: 'Remote — Philippines' },
  offices: [{ location: 'Manila' }],
  departments: [{ name: 'Engineering' }],
  pay_input_ranges: [{ min_cents: 5000000, currency_type: 'USD' }],
  metadata: null,
  extra: { nested: [true, null] },
};

test('Greenhouse converts encoded HTML and preserves all other metadata', async () => {
  const content = encodeHTML(
    '<h2>Role</h2><p>Remote from the Philippines &amp; Singapore.</p>' +
      '<ul><li>Laravel &amp; PostgreSQL</li><li>Generics &lt;T&gt; &#x2014; &#8369;100</li></ul>' +
      '<p>First<br>Second <a href="https://example.test/policy">Remote policy</a></p>' +
      '<script>unwanted script</script><style>unwanted style</style>',
  );
  for (const host of ['job-boards.greenhouse.io', 'boards.greenhouse.io']) {
    const text = await fetchGreenhouseListing(
      `${url.replace('job-boards.greenhouse.io', host)}?tracking=1#details`,
      { fetch: async () => Response.json({ ...metadata, content }) },
    );
    const [savedMetadata, description] = text
      .split('metadata:\n')[1]
      .split('\n\nDescription:\n');
    assert.deepEqual(JSON.parse(savedMetadata), metadata);
    assert.match(description, /Remote from the Philippines & Singapore/);
    assert.match(description, /Laravel & PostgreSQL/);
    assert.match(description, /Generics <T> — ₱100/);
    assert.match(description, /First\nSecond/);
    assert.match(
      description,
      /Remote policy \[https:\/\/example.test\/policy\]/,
    );
    assert.doesNotMatch(description, /<\/?(?:p|li|h2)>|&(?:lt|amp);|unwanted/);
  }
});

test('missing Greenhouse postings are terminal; other HTTP failures remain retryable', async () => {
  for (const status of [400, 401, 403, 404, 408, 410, 425, 429, 500, 503])
    await assert.rejects(
      fetchGreenhouseListing(url, {
        fetch: async () => new Response('', { status }),
      }),
      (error) =>
        [404, 410].includes(status)
          ? error instanceof PageError && !error.retryable
          : !(error instanceof PageError) &&
            error.message.includes(String(status)),
    );
});

test('empty descriptions and mismatched posting IDs fail retryably', async () => {
  for (const content of [
    '',
    '  ',
    '&lt;p&gt;&amp;nbsp;&lt;/p&gt;',
    '&lt;script&gt;ignored&lt;/script&gt;',
  ])
    await assert.rejects(
      fetchGreenhouseListing(url, {
        fetch: async () => Response.json({ ...metadata, content }),
      }),
      /Empty Greenhouse description/,
    );
  await assert.rejects(
    fetchGreenhouseListing(url, {
      fetch: async () => Response.json({ id: 456, content: 'Wrong job' }),
    }),
    /Greenhouse listing ID mismatch/,
  );
});

test('Greenhouse rejects unsupported URLs before fetching', async () => {
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('Example%20Board', 'board%2Fother'),
    `${url}/application`,
    url.replace('123', 'not-an-id'),
    url.replace('job-boards.greenhouse.io', 'example.test'),
    'https://jobs.ashbyhq.com/example/12345678-abcd-abcd-abcd-123456789abc',
  ])
    await assert.rejects(
      fetchGreenhouseListing(invalid, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      /Invalid Greenhouse listing URL/,
    );
});

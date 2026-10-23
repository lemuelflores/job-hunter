import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchBoard,
  fetchPinpointhqListing,
  normalizePinpointhqUrl,
  pinpointhq,
} from '../dist/integrations/ats/pinpointhq.js';
import { PageError } from '../dist/integrations/extraction.js';

const id = 'ce6c9e5c-a2d3-42b0-a01e-9edeae315b04';
const url = `https://example.pinpointhq.com/postings/${id}`;
const job = {
  id: '559663',
  job: { id: '562609', department: { name: 'Engineering' } },
  url,
  title: 'Engineer',
  description: '<p>Build Laravel &amp; PostgreSQL.</p>',
  key_responsibilities: '<ul><li>Ship services</li></ul>',
  key_responsibilities_header: 'What you do',
  skills_knowledge_expertise: '<p>Remote from the Philippines only</p>',
  skills_knowledge_expertise_header: 'What you bring',
  benefits: '<p>Health cover</p>',
  benefits_header: 'What you get',
  deadline_at: '2026-12-31T00:00:00Z',
  extra: { opaque: [null, true] },
};
const response = (data) => Response.json({ data });

test('PinpointHQ normalizes UUID and legacy numeric URLs with optional locales and strict tenant guards', () => {
  assert.equal(pinpointhq.selector, 'pinpointhq');
  assert.deepEqual(pinpointhq.hosts, ['*.pinpointhq.com']);
  assert.equal(
    normalizePinpointhqUrl(
      `${url.toUpperCase()}/?x=1#top`.replace('/POSTINGS/', '/postings/'),
    ),
    url,
  );
  assert.equal(
    normalizePinpointhqUrl(url.replace('/postings/', '/pt-BR/postings/')),
    url.replace('/postings/', '/pt-BR/postings/'),
  );
  assert.equal(
    normalizePinpointhqUrl('https://example.pinpointhq.com/en/jobs/562609?x=1'),
    'https://example.pinpointhq.com/en/jobs/562609',
  );
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('example.', ''),
    url.replace('example.', 'nested.example.'),
    url.replace('example.', 'user@example.'),
    url.replace('.com/', '.com.evil.test/'),
    url.replace('.com/', '.com:444/'),
    `${url}/apply`,
    url.replace(id, '559663'),
    url.replace('/postings/', '/jobs/'),
    url.replace(id, `${id}%2Fbad`),
    url.replace(id, `${id}%5Cbad`),
    url.replace('/postings/', '/invalid/postings/'),
    url.replace(id, '%'),
    'not a URL',
  ])
    assert.equal(normalizePinpointhqUrl(invalid), null, invalid);
});

test('PinpointHQ fetches localized feeds, uses URL UUID identity, renders all sections and never uses deadline as publication', async () => {
  const listing = await fetchPinpointhqListing(
    url.replace('/postings/', '/en/postings/'),
    {
      fetch: async (endpoint, options) => {
        assert.equal(
          endpoint,
          'https://example.pinpointhq.com/en/postings.json',
        );
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return response([job]);
      },
    },
  );
  const [metadata, text] = listing.text
    .split('metadata:\n')[1]
    .split('\n\nDescription:\n');
  const {
    description: _description,
    key_responsibilities: _responsibilities,
    skills_knowledge_expertise: _skills,
    benefits: _benefits,
    ...expected
  } = job;
  assert.deepEqual(JSON.parse(metadata), expected);
  assert.match(text, /Build Laravel & PostgreSQL/);
  assert.match(text, /What you do\n.*Ship services/s);
  assert.match(text, /What you bring\nRemote from the Philippines only/);
  assert.match(text, /What you get\nHealth cover/);
  assert.doesNotMatch(text, /<p>|&amp;/);
  assert.equal(listing.postedAt, null);
  assert.deepEqual(
    await fetchBoard('example.pinpointhq.com', '', {
      fetch: async () => response([job]),
    }),
    { data: [job] },
  );
});

test('PinpointHQ legacy identity uses job.id, not numeric posting id', async () => {
  const listing = await fetchPinpointhqListing(
    'https://example.pinpointhq.com/jobs/562609',
    {
      fetch: async (endpoint) => {
        assert.equal(endpoint, 'https://example.pinpointhq.com/postings.json');
        return response([job]);
      },
    },
  );
  assert.match(listing.text, /Engineer/);
  await assert.rejects(
    fetchPinpointhqListing('https://example.pinpointhq.com/jobs/559663', {
      fetch: async () => response([job]),
    }),
    (error) => error instanceof PageError && !error.retryable,
  );
});

test('PinpointHQ separates absent entries from malformed feeds, invalid identities, duplicates and empty content', async () => {
  for (const data of [
    [],
    [{ ...job, url: url.replace(id, '00000000-0000-0000-0000-000000000000') }],
  ])
    await assert.rejects(
      fetchPinpointhqListing(url, { fetch: async () => response(data) }),
      (error) => error instanceof PageError && !error.retryable,
    );
  for (const data of [
    null,
    {},
    { data: null },
    { data: [{}] },
    { data: [{ ...job, description: null }] },
    { data: [{ ...job, benefits: 42 }] },
    { data: [{ ...job, job: null }] },
  ])
    await assert.rejects(
      fetchPinpointhqListing(url, { fetch: async () => Response.json(data) }),
      /Invalid PinpointHQ board response/,
    );
  for (const data of [
    [job, job],
    [{ ...job, url: url.replace('example.', 'other.') }],
    [{ ...job, url: url.replace(id, job.id) }],
    [
      {
        ...job,
        description: '<p>&nbsp;</p>',
        key_responsibilities: null,
        skills_knowledge_expertise: '',
        benefits: null,
      },
    ],
  ])
    await assert.rejects(
      fetchPinpointhqListing(url, { fetch: async () => response(data) }),
      (error) => !(error instanceof PageError),
    );
  const listing = await fetchPinpointhqListing(url, {
    fetch: async () =>
      response([
        {
          url,
          job: { id: '562609' },
          description: '',
          benefits: '<p>Health cover</p>',
        },
      ]),
  });
  assert.match(listing.text, /Benefits\nHealth cover/);
  assert.equal(listing.postedAt, null);
});

test('PinpointHQ only treats HTTP 404/410 as terminal and never falls back', async () => {
  for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchPinpointhqListing(url, {
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

test('PinpointHQ validates API inputs and propagates timeout, cancellation and network failures', async () => {
  const noFetch = { fetch: async () => assert.fail('unexpected fetch') };
  for (const host of [
    'pinpointhq.com',
    'nested.example.pinpointhq.com',
    'evil.test',
    'example.pinpointhq.com/path',
  ])
    await assert.rejects(
      fetchBoard(host, '', noFetch),
      /Invalid PinpointHQ board host/,
    );
  await assert.rejects(
    fetchBoard('example.pinpointhq.com', '../en', noFetch),
    /Invalid PinpointHQ locale/,
  );
  await assert.rejects(
    fetchPinpointhqListing(`${url}/apply`, noFetch),
    /Invalid PinpointHQ listing URL/,
  );
  const timeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 75_000);
      return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    };
    await assert.rejects(
      fetchPinpointhqListing(url, {
        fetch: async (_url, options) => options.signal.throwIfAborted(),
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    AbortSignal.timeout = timeout;
  }
  await assert.rejects(
    fetchPinpointhqListing(url, {
      signal: AbortSignal.abort(new Error('Cancelled')),
      fetch: async (_url, options) => options.signal.throwIfAborted(),
    }),
    /Cancelled/,
  );
  await assert.rejects(
    fetchPinpointhqListing(url, {
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    /Offline/,
  );
});

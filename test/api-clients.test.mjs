import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValiError } from 'valibot';
import { fetchBoard } from '../dist/review/extraction/ashby.js';
import { scrapePage } from '../dist/review/extraction/firecrawl.js';
import { fetchJob } from '../dist/review/extraction/greenhouse.js';
import { fetchPosting } from '../dist/review/extraction/lever.js';

const leverId = '12345678-abcd-abcd-abcd-123456789abc';

test('Lever client encodes the site, selects its region and preserves metadata', async () => {
  const posting = {
    id: leverId,
    descriptionPlain: '',
    lists: [],
    extra: { nested: [null, true] },
  };
  for (const region of ['global', 'eu']) {
    assert.deepEqual(
      await fetchPosting('Example Board', leverId, region, {
        fetch: async (endpoint, init) => {
          assert.equal(
            endpoint,
            `https://api${region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/Example%20Board/${leverId}`,
          );
          assert.equal(init.redirect, 'error');
          return Response.json(posting);
        },
      }),
      posting,
    );
  }
  for (const id of ['', '../123', `${leverId}?mode=html`, null, 123])
    await assert.rejects(
      fetchPosting('example', id, 'global', {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      ValiError,
    );
  await assert.rejects(
    fetchPosting('example', leverId, 'invalid', {
      fetch: async () => assert.fail('unexpected fetch'),
    }),
    ValiError,
  );
});

test('Greenhouse client encodes the board and preserves opaque metadata', async () => {
  const posting = {
    id: 123,
    content: '&lt;p&gt;Build services&lt;/p&gt;',
    title: 'Engineer',
    location: { name: 'Remote' },
    metadata: null,
    pay_input_ranges: [{ min_cents: 5000000, currency_type: 'USD' }],
    extra: { nested: [null, true] },
  };
  assert.deepEqual(
    await fetchJob('Example Board', '123', {
      fetch: async (endpoint, init) => {
        assert.equal(
          endpoint,
          'https://boards-api.greenhouse.io/v1/boards/Example%20Board/jobs/123?pay_transparency=true',
        );
        assert.equal(init.redirect, 'error');
        return Response.json(posting);
      },
    }),
    posting,
  );
  for (const id of ['', '../123', '123?questions=true', '1.5', null, 123])
    await assert.rejects(
      fetchJob('example', id, {
        fetch: async () => assert.fail('unexpected fetch'),
      }),
      ValiError,
    );
});

test('Ashby client encodes the board and preserves opaque posting metadata', async () => {
  const posting = {
    jobUrl:
      'https://jobs.ashbyhq.com/Example%20Board/12345678-abcd-abcd-abcd-123456789abc',
    descriptionPlain: 'Build services',
    title: 'Engineer',
    descriptionHtml: '<p>Build services</p>',
    location: null,
    newProviderField: { nested: [true, null, 42] },
    compensation: {
      compensationTierSummary: null,
      scrapeableCompensationSalarySummary: null,
      compensationTiers: [],
      summaryComponents: [],
    },
  };
  const board = await fetchBoard('Example Board', {
    fetch: async (endpoint, init) => {
      assert.equal(
        endpoint,
        'https://api.ashbyhq.com/posting-api/job-board/Example%20Board?includeCompensation=true',
      );
      assert.equal(init.redirect, 'error');
      return Response.json({
        jobs: [posting],
        unrelated: 'omit',
      });
    },
  });
  assert.deepEqual(board, { jobs: [posting] });
  assert.deepEqual(
    await fetchBoard('example', {
      fetch: async () => Response.json({ jobs: [] }),
    }),
    { jobs: [] },
  );
});

test('Firecrawl client accepts HTTP and HTTPS page URLs unchanged', async () => {
  for (const url of [
    'http://example.test/Job?Token=AbC',
    'https://example.test/Job?Token=AbC',
  ]) {
    await scrapePage(url, {
      fetch: async (_endpoint, init) => {
        assert.equal(JSON.parse(init.body).url, url);
        return Response.json({ success: true, data: { markdown: 'Listing' } });
      },
    });
  }
});

test('Firecrawl client sends Markdown options and returns data without extraction policy', async (t) => {
  const original = process.env.FIRECRAWL_URL;
  process.env.FIRECRAWL_URL = 'http://localhost:3333/';
  t.after(() => {
    if (original === undefined) delete process.env.FIRECRAWL_URL;
    else process.env.FIRECRAWL_URL = original;
  });
  const result = {
    success: false,
    data: { metadata: { statusCode: 404, error: 'Not Found' } },
  };
  assert.deepEqual(
    await scrapePage('https://example.test/job', {
      fetch: async (endpoint, init) => {
        assert.equal(endpoint, 'http://localhost:3333/v2/scrape');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(init.body), {
          url: 'https://example.test/job',
          formats: ['markdown'],
          timeout: 60_000,
        });
        return Response.json({ ...result, unrelated: 'omit' });
      },
    }),
    result,
  );
  assert.deepEqual(
    await scrapePage('https://example.test/job', {
      fetch: async () =>
        Response.json({
          success: true,
          data: {
            markdown: '',
            metadata: { statusCode: 200, unrelated: 'omit' },
            unrelated: 'omit',
          },
        }),
    }),
    { success: true, data: { markdown: '', metadata: { statusCode: 200 } } },
  );
});

for (const { name, call, input, body, invalidInputs, invalidBodies } of [
  {
    name: 'Lever',
    call: (site, options) => fetchPosting(site, leverId, 'global', options),
    input: 'example',
    body: { id: leverId, descriptionPlain: '', lists: [] },
    invalidInputs: [],
    invalidBodies: [
      null,
      {},
      { id: 'invalid', descriptionPlain: '', lists: [] },
      { id: leverId, descriptionPlain: null, lists: [] },
      { id: leverId, descriptionPlain: '' },
      { id: leverId, descriptionPlain: '', lists: null },
      {
        id: leverId,
        descriptionPlain: '',
        lists: [{ text: 'Requirements', content: 42 }],
      },
      {
        id: leverId,
        descriptionPlain: '',
        lists: [{ text: null, content: '' }],
      },
      { id: leverId, descriptionPlain: '', lists: [], additionalPlain: null },
      {
        id: leverId,
        descriptionPlain: '',
        lists: [],
        salaryDescriptionPlain: 42,
      },
    ],
  },
  {
    name: 'Greenhouse',
    call: (board, options) => fetchJob(board, '123', options),
    input: 'example',
    body: { id: 123, content: '' },
    invalidInputs: [],
    invalidBodies: [
      null,
      {},
      { id: '123', content: 'Listing' },
      { id: 1.5, content: 'Listing' },
      { id: 0, content: 'Listing' },
      { id: 123, content: null },
      { id: 123, content: 42 },
      { id: 123 },
    ],
  },
  {
    name: 'Ashby',
    call: fetchBoard,
    input: 'example',
    body: { jobs: [] },
    invalidInputs: [],
    invalidBodies: [
      null,
      {},
      { jobs: null },
      { jobs: {} },
      { jobs: [null] },
      { jobs: [{}] },
      { jobs: [{ jobUrl: 'not a URL' }] },
      { jobs: [{ jobUrl: 'https://example.test/job', descriptionPlain: 42 }] },
      { jobs: [{ jobUrl: 'https://example.test/job', title: 42 }] },
    ],
  },
  {
    name: 'Firecrawl',
    call: scrapePage,
    input: 'https://example.test',
    body: { success: true, data: { markdown: '' } },
    invalidInputs: [
      '',
      'not a URL',
      'https://',
      'file:///etc/passwd',
      'ftp://example.test/job',
      null,
      42,
    ],
    invalidBodies: [
      null,
      {},
      { success: 'true' },
      { success: true, data: null },
      { success: true, data: { markdown: 42 } },
      { success: true, data: { metadata: { statusCode: '404' } } },
    ],
  },
]) {
  test(`${name} client enforces its boundary contract`, async (t) => {
    for (const input of invalidInputs) {
      await t.test(`invalid request ${JSON.stringify(input)}`, async () => {
        await assert.rejects(
          call(input, {
            fetch: async () => assert.fail('unexpected fetch'),
          }),
          ValiError,
        );
      });
    }
    for (const body of invalidBodies) {
      await t.test(`invalid response ${JSON.stringify(body)}`, async () => {
        await assert.rejects(
          call(input, {
            fetch: async () => Response.json(body),
          }),
          (error) => error instanceof ValiError && error.message.includes(name),
        );
      });
    }
  });

  test(`${name} client preserves HTTP, network and JSON failures`, async () => {
    for (const status of [400, 401, 403, 404, 408, 410, 425, 429, 500, 503]) {
      await assert.rejects(
        call(input, {
          fetch: async () => new Response('private error', { status }),
        }),
        {
          message: `${name}${name !== 'Firecrawl' ? ' API' : ''} HTTP ${status}`,
        },
      );
    }
    const failure = new Error('network unavailable');
    await assert.rejects(
      call(input, {
        fetch: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    await assert.rejects(
      call(input, { fetch: async () => new Response('not JSON') }),
      SyntaxError,
    );
  });

  test(`${name} client combines the request deadline with caller cancellation`, async (t) => {
    for (const withCaller of [false, true]) {
      for (const abort of withCaller ? ['timeout', 'caller'] : ['timeout']) {
        const deadline = new AbortController();
        const caller = new AbortController();
        const failure = new Error(abort);
        const mock = t.mock.method(AbortSignal, 'timeout', (duration) => {
          assert.equal(duration, 75_000);
          return deadline.signal;
        });
        try {
          await assert.rejects(
            call(input, {
              signal: withCaller ? caller.signal : undefined,
              fetch: async (_endpoint, init) => {
                assert.equal(init.signal.aborted, false);
                (abort === 'caller' ? caller : deadline).abort(failure);
                init.signal.throwIfAborted();
                return Response.json(body);
              },
            }),
            (error) => error === failure,
          );
          assert.equal(mock.mock.callCount(), 1);
        } finally {
          mock.mock.restore();
        }
      }
    }
  });
}

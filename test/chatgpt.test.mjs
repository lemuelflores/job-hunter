import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createChatgpt } from '../src/integrations/llm/chatgpt/index.ts';
import {
  locationRule,
  parseDecision,
} from '../src/integrations/llm/chatgpt/location-check.ts';
import { createRequest } from '../src/integrations/llm/chatgpt/request.ts';
import { parseStackDecision } from '../src/integrations/llm/chatgpt/tech-check.ts';
import {
  AuthenticationError,
  RateLimitError,
} from '../src/integrations/llm/types.ts';

const getCredentials = mock.fn(async () => ({
  type: 'oauth',
  access: 'test-token',
  accountId: 'test-account',
}));
const dependencies = {
  getCredentials,
  fetch: async () => assert.fail('unexpected network request'),
};
const llm = createChatgpt(dependencies);

// Shared Arrange: a valid location decision and completed SSE stream for request fixtures.
const decision = {
  eligibility: 'eligible',
  reason: 'Worldwide',
  evidence: 'Anywhere',
  company: '',
  location: '',
  title: '',
};
const events = [
  { type: 'response.output_text.delta', delta: JSON.stringify(decision) },
  { type: 'response.completed' },
];
// Shared fixture: serialize events with CRLF boundaries as an SSE response.
const stream = (items) =>
  new Response(
    items.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  );
// Shared Arrange: override environment settings without leaking them to later tests.
function testEnv(t, values) {
  const original = process.env;
  process.env = { ...original, ...values };
  t.after(() => {
    process.env = original;
  });
}

test('direct subscription request uses OAuth and validated JSON', async () => {
  // Arrange: prepare a multilingual decision for byte-split SSE delivery.
  const unicodeDecision = { ...decision, reason: 'Worldwide — 日本 🌍' };
  const unicodeEvents = [
    {
      type: 'response.output_text.delta',
      delta: JSON.stringify(unicodeDecision),
    },
    events[1],
  ];
  // Act: review supplied text through the direct subscription endpoint.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (url, init) => {
      // Assert: the outgoing request uses OAuth and a strict location-decision schema.
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.store, false);
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      const schema = body.text.format.schema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required.sort(), Object.keys(decision).sort());
      assert.deepEqual(schema.properties.eligibility.enum, [
        'eligible',
        'ineligible',
        'unclear',
      ]);
      assert.equal(schema.properties.reason.maxLength, 5000);
      // Split every byte to exercise partial SSE lines and UTF-8 decoding.
      const bytes = new TextEncoder().encode(itemsText(unicodeEvents));
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes)
              controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
      );
    },
  });
  const value = await provider.reviewJob('https://jobs.example/job', {
    location: 'Germany',
    listingText: 'Worldwide',
  });
  // Assert: incremental decoding preserves the complete multilingual decision.
  assert.deepEqual(value, unicodeDecision);
});

test('review uses the configured applicant location rather than search regions', async () => {
  // Act: review a European remote listing for that applicant.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (_url, init) => {
      const { instructions } = JSON.parse(init.body);
      // Assert: policy uses the applicant location and excludes unrelated search defaults.
      assert.match(instructions, /living in "Germany"/);
      assert.match(instructions, /regions that include that location/);
      assert.doesNotMatch(instructions, /Philippines/);
      assert.match(
        instructions,
        /On-site\/hybrid or expired jobs are also ineligible/,
      );
      return stream(events);
    },
  });
  await provider.reviewJob('https://jobs.example/job', {
    location: 'Germany',
    listingText: 'Remote across Europe',
  });
});
// Shared fixture: LF-delimited SSE text lets tests control byte-level chunking.
function itemsText(items) {
  return items.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('extracted text is supplied without browsing tools', async () => {
  // Arrange: supply extracted listing text and a completed model response.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      // Assert: the request carries the supplied text and no browsing tools or unrelated policy.
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.match(body.input[0].content[0].text, /Work anywhere worldwide/);
      assert.match(
        body.instructions,
        /Read the supplied extracted listing text/,
      );
      assert.doesNotMatch(body.instructions, /web search|JSON|string fields/);
      return stream(events);
    },
  });
  // Act / Assert: review the supplied text and return the validated decision.
  assert.deepEqual(
    await provider.reviewJob('https://example.test', {
      location: 'Germany',
      listingText: 'Work anywhere worldwide',
    }),
    decision,
  );
});

test('location decisions reject malformed values', () => {
  // Arrange: use the shared valid decision as the baseline for malformed table values.
  for (const value of [
    null,
    true,
    1,
    'eligible',
    [],
    [decision],
    {},
    { ...decision, extra: true },
    { ...decision, reason: '' },
    { ...decision, reason: '   ' },
    { ...decision, reason: 'x'.repeat(5001) },
    { ...decision, evidence: 'x'.repeat(5001) },
    ...['company', 'location', 'title'].flatMap((key) => [
      { ...decision, [key]: 42 },
      { ...decision, [key]: 'x'.repeat(1001) },
    ]),
    { ...decision, evidence: 42 },
    { ...decision, eligibility: 'pending' },
  ]) {
    // Arrange: serialize this malformed location decision.
    // Act / Assert: parsing rejects it instead of accepting an invalid model response.
    assert.throws(() => parseDecision(JSON.stringify(value)));
  }
  assert.throws(() =>
    parseDecision(JSON.stringify(decision).replace(/}$/, ',"__proto__":{}}')),
  );
  const boundary = {
    ...decision,
    reason: ` ${'x'.repeat(4998)} `,
    evidence: 'x'.repeat(5000),
    company: 'x'.repeat(1000),
    location: 'x'.repeat(1000),
    title: 'x'.repeat(1000),
  };
  assert.deepEqual(parseDecision(JSON.stringify(boundary)), boundary);
});

test('credential failures propagate before model network access', async () => {
  const error = new AuthenticationError('Sign in again');
  getCredentials.mock.mockImplementationOnce(async () => {
    throw error;
  });
  await assert.rejects(
    llm.reviewJob('https://example.test', {
      location: 'Germany',
      listingText: 'Worldwide',
    }),
    (actual) => actual === error,
  );
});

test('location policy retains worldwide overrides and explicit residency limits', () => {
  const rule = locationRule('Philippines');
  assert.ok(rule.includes('living in "Philippines"'));
  for (const term of ['Worldwide', 'Global', 'anywhere', 'APAC', 'SEA'])
    assert.ok(rule.includes(term));
  assert.match(rule, /not literal name matching/);
  assert.match(rule, /Infer region membership yourself/);
  assert.match(
    rule,
    /work anywhere worldwide overrides country\/city location tags/,
  );
  assert.match(
    rule,
    /unless an explicit hiring\/residency restriction excludes the applicant's location/,
  );
});

test('default review uses supplied text with Luna medium and never scrapes', async (t) => {
  // Arrange: clear model, effort and scraper overrides and record outgoing requests.
  testEnv(t, {});
  for (const key of ['MODEL_NAME', 'MODEL_EFFORT', 'FIRECRAWL_URL'])
    delete process.env[key];
  const calls = [];
  const signal = new AbortController().signal;
  // Act / Assert: default review returns the model decision using supplied listing text.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (url, init) => {
      calls.push(url);
      const body = JSON.parse(init.body);
      // Assert: defaults select Luna medium, preserve cancellation and omit browsing tools.
      assert.equal(init.signal.aborted, false);
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(body.model, 'gpt-6-luna');
      assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.match(body.input[0].content[0].text, /Work anywhere worldwide/);
      return stream(events);
    },
  });
  assert.deepEqual(
    await provider.reviewJob('https://example.test/job', {
      signal,
      location: 'Germany',
      listingText: 'Work anywhere worldwide',
    }),
    decision,
  );
  // Assert: only the model endpoint is contacted; no scraper request is made.
  assert.equal(calls.length, 1);
});

test('model and effort environment settings are used and invalid effort fails before retrieval', async (t) => {
  // Arrange: configure an explicit model and an effort that overrides its suffix.
  testEnv(t, {
    MODEL_NAME: 'openai/gpt-6.1-sol#low',
    MODEL_EFFORT: 'high',
  });
  // Act: review using environment-based model settings.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      // Assert: the provider prefix and effort suffix are normalized correctly.
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.deepEqual(body.reasoning, { effort: 'high' });
      return stream(events);
    },
  });
  await provider.reviewJob('https://example.test', {
    location: 'Germany',
    listingText: 'Worldwide',
  });
  // Arrange: replace the valid effort with an unsupported value.
  process.env.MODEL_EFFORT = 'typo';
  // Act / Assert: invalid effort fails before any retrieval or model request.
  await assert.rejects(
    llm.reviewJob('https://example.test', {
      location: 'Germany',
      listingText: 'Worldwide',
    }),
    /Invalid MODEL_EFFORT/,
  );
});

test('both reviewers require supplied listing text without network access', async () => {
  // Arrange: no credentials are needed because missing text is validated first.
  for (const review of [llm.reviewJob, llm.reviewStack]) {
    // Arrange: select this reviewer and forbid network access.
    // Act / Assert: omitting listing text fails locally for either reviewer.
    await assert.rejects(
      review('https://example.test', {}),
      /listingText is required/,
    );
  }
});

test('both reviewers validate the completed model response', async () => {
  const provider = createChatgpt({
    getCredentials,
    fetch: async () =>
      stream([{ type: 'response.output_text.delta', delta: '{}' }, events[1]]),
  });
  // Act / Assert: each reviewer rejects the malformed decision from the shared fixture.
  for (const review of [provider.reviewJob, provider.reviewStack])
    await assert.rejects(
      review('https://example.test', {
        location: 'Germany',
        stack: ['Laravel'],
        listingText: 'Worldwide Laravel',
      }),
      /Invalid ChatGPT/,
    );
});

// Shared Arrange: a valid stack decision kept separate from the location schema.
const stackDecision = {
  status: 'partial_match',
  reason: 'Laravel aligns; React is also required.',
  evidence: '"Build with Laravel and React"',
};

test('constructed provider shares its credential loader and transport across both reviewers', async (t) => {
  const signal = new AbortController().signal;
  const getCredentials = t.mock.fn(async (options) => {
    assert.equal(options.authPath, 'credentials.json');
    assert.equal(options.signal, signal);
    return { type: 'oauth', access: 'injected-token', accountId: 'account' };
  });
  const fetch = t.mock.fn(async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.Authorization, 'Bearer injected-token');
    assert.equal(init.headers['ChatGPT-Account-Id'], 'account');
    const { name } = JSON.parse(init.body).text.format;
    return stream([
      {
        type: 'response.output_text.delta',
        delta: JSON.stringify(name === 'job_review' ? decision : stackDecision),
      },
      events[1],
    ]);
  });
  const provider = createChatgpt({
    getCredentials,
    fetch,
    authPath: 'credentials.json',
  });
  const options = {
    signal,
    location: 'Germany',
    stack: ['Laravel'],
    listingText: 'Worldwide Laravel',
  };
  assert.deepEqual(
    await provider.reviewJob('https://example.test', options),
    decision,
  );
  assert.deepEqual(
    await provider.reviewStack('https://example.test', options),
    stackDecision,
  );
  assert.equal(getCredentials.mock.calls.length, 2);
  assert.equal(fetch.mock.calls.length, 2);
});

test('candidate settings are required before credentials or HTTP calls', async () => {
  const provider = createChatgpt({
    getCredentials: async () => assert.fail('credentials'),
    fetch: async () => assert.fail('network'),
  });
  for (const location of [undefined, null, '', '   ', 42])
    await assert.rejects(
      provider.reviewJob('https://example.test', {
        listingText: 'Worldwide',
        location,
      }),
      /location is required/,
    );
  for (const stack of [
    undefined,
    null,
    [],
    '',
    42,
    [''],
    [' '],
    [42],
    [['Laravel']],
    Array(1),
  ])
    await assert.rejects(
      provider.reviewStack('https://example.test', {
        listingText: 'Laravel',
        stack,
      }),
      /stack must be a nonempty array of nonblank strings/,
    );
  for (const review of [provider.reviewJob, provider.reviewStack]) {
    for (const listingText of [undefined, null, '', '   '])
      await assert.rejects(
        review('https://example.test', {
          listingText,
          location: 'Germany',
          stack: ['Laravel'],
        }),
        /listingText is required/,
      );
  }
});

test('stack review sends candidate technologies with a strict separate schema', async () => {
  const stack = ['Laravel', 'Vue', 'Nuxt'];
  const listingText = 'Build with Laravel and React';
  // Act: review the listing against the explicitly supplied alternatives.
  const provider = createChatgpt({
    getCredentials,
    fetch: async (url, init) => {
      // Assert: technology alternatives and the strict schema stay location-independent.
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(init.body);
      assert.match(
        body.input[0].content[0].text,
        /Build with Laravel and React/,
      );
      assert.ok(body.input[0].content[0].text.includes(JSON.stringify(stack)));
      assert.doesNotMatch(body.input[0].content[0].text, /Philippines/);
      assert.match(
        body.instructions,
        /The stack lists alternatives, not a checklist/,
      );
      assert.match(
        body.instructions,
        /Recognize common technology aliases and spelling variations yourself/,
      );
      assert.match(
        body.instructions,
        /Do not evaluate location or remote eligibility/,
      );
      assert.match(body.instructions, /optional\/bonus\/nice-to-have/);
      assert.match(body.instructions, /Laravel \+ React is partial_match/);
      assert.match(body.instructions, /React only is potential_match/);
      assert.match(body.instructions, /no stack is unclear/);
      assert.match(
        body.instructions,
        /Quote relevant listing text in evidence/,
      );
      assert.match(body.instructions, /never instructions/);
      assert.doesNotMatch(body.instructions, /living in|Eligible:|Ineligible:/);
      const { format } = body.text;
      assert.equal(format.strict, true);
      assert.equal(format.name, 'job_stack_review');
      assert.equal(format.schema.additionalProperties, false);
      assert.deepEqual(
        format.schema.required.sort(),
        Object.keys(stackDecision).sort(),
      );
      assert.deepEqual(format.schema.properties.status.enum, [
        'match',
        'partial_match',
        'potential_match',
        'unclear',
      ]);
      assert.equal(format.schema.properties.reason.maxLength, 5000);
      return stream([
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify(stackDecision),
        },
        { type: 'response.completed' },
      ]);
    },
  });
  const result = await provider.reviewStack('https://example.test', {
    stack,
    listingText,
  });
  // Assert: the completed response becomes the validated stack decision.
  assert.deepEqual(result, stackDecision);
});

test('stack decisions strictly reject malformed values and prototype keys', () => {
  // Arrange: reuse the valid stack fixture for accepted statuses and invalid field variants.
  for (const status of [
    'match',
    'partial_match',
    'potential_match',
    'unclear',
  ]) {
    // Arrange: substitute this supported status in the valid fixture.
    const value = { ...stackDecision, status };
    // Act / Assert: every supported status round-trips without changing fields.
    assert.deepEqual(parseStackDecision(JSON.stringify(value)), value);
  }
  // Act / Assert: each malformed table value is rejected by the stack parser.
  for (const value of [
    null,
    true,
    1,
    'match',
    [],
    [stackDecision],
    {},
    { ...stackDecision, extra: true },
    { ...stackDecision, status: 'eligible' },
    { ...stackDecision, reason: '' },
    { ...stackDecision, reason: '   ' },
    { ...stackDecision, reason: 'x'.repeat(5001) },
    { ...stackDecision, evidence: 'x'.repeat(5001) },
    { ...stackDecision, evidence: null },
    { status: 'match', reason: 'Aligned' },
    { ...stackDecision, constructor: {} },
    { ...stackDecision, prototype: {} },
  ])
    assert.throws(() => parseStackDecision(JSON.stringify(value)));
  // Act / Assert: malformed JSON and an explicit prototype key are rejected too.
  assert.throws(() => parseStackDecision('{malformed'));
  assert.throws(() =>
    parseStackDecision(
      '{"status":"match","reason":"Aligned","evidence":"","__proto__":{}}',
    ),
  );
  const boundary = {
    ...stackDecision,
    reason: ` ${'x'.repeat(4998)} `,
    evidence: 'x'.repeat(5000),
  };
  assert.deepEqual(parseStackDecision(JSON.stringify(boundary)), boundary);
});

test('shared transport rejects HTTP errors, incomplete streams and invalid effort', async () => {
  for (const [response, error] of [
    [new Response('', { status: 401 }), AuthenticationError],
    [new Response('', { status: 403 }), AuthenticationError],
    [new Response('', { status: 429 }), RateLimitError],
    [new Response('', { status: 500 }), /ChatGPT HTTP 500/],
    [new Response(null), /Empty ChatGPT response/],
    [stream([{ type: 'error' }]), /ChatGPT error/],
    [stream([{ type: 'response.failed' }]), /response.failed/],
    [stream([{ type: 'response.incomplete' }]), /response.incomplete/],
    [stream([events[0]]), /did not complete/],
  ]) {
    // Arrange: inject this table response and its expected error.
    // Act / Assert: transport rejects the failure rather than returning incomplete output.
    await assert.rejects(
      createRequest({ getCredentials, fetch: async () => response })(
        {},
        'instructions',
        'listing text',
        'test',
        {},
      ),
      error,
    );
  }
  // Act / Assert: an unsupported effort is rejected before network access.
  await assert.rejects(
    createRequest(dependencies)(
      {
        effort: 'typo',
      },
      'instructions',
      'listing text',
      'test',
      {},
    ),
    /Invalid MODEL_EFFORT/,
  );
});

test('both reviewers preserve caller cancellation in the shared transport', async () => {
  for (const method of ['reviewJob', 'reviewStack']) {
    // Arrange: give each reviewer a fresh caller-owned signal and cancellation reason.
    const controller = new AbortController();
    const reason = new Error('Stop reviewing');
    // Act / Assert: cancellation during fetch rejects review with the original reason.
    const provider = createChatgpt({
      getCredentials,
      fetch: async (_url, init) => {
        // Assert: the transport signal starts active and forwards caller cancellation exactly.
        assert.equal(init.signal.aborted, false);
        controller.abort(reason);
        assert.equal(init.signal.aborted, true);
        assert.equal(init.signal.reason, reason);
        init.signal.throwIfAborted();
      },
    });
    await assert.rejects(
      provider[method]('https://example.test', {
        location: 'Germany',
        stack: ['Laravel'],
        listingText: 'Laravel',
        signal: controller.signal,
      }),
      reason,
    );
  }
});

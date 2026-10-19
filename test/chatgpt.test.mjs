import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProfile } from '../dist/profile.js';
import {
  locationRule,
  parseDecision,
  reviewJob,
} from '../dist/review/llm/chatgpt/location-check.js';
import { request } from '../dist/review/llm/chatgpt/request.js';
import { parseStackDecision } from '../dist/review/llm/chatgpt/tech-check.js';
import {
  AuthenticationError,
  createLlm,
  RateLimitError,
} from '../dist/review/llm/index.js';

const llm = createLlm();

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
// Shared Arrange: create isolated, unexpired OAuth credentials and clean up after each test.
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authPath = join(root, 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'test-token',
        accountId: 'test-account',
        expires: Date.now() + 60000,
      },
    }),
  );
  return authPath;
}
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

test('provider factory defaults to ChatGPT and rejects unsupported providers', (t) => {
  // Arrange: remove the provider override while preserving the original environment.
  testEnv(t, {});
  delete process.env.MODEL_PROVIDER;
  // Act / Assert: an absent provider selects the default ChatGPT interface.
  assert.deepEqual(createLlm(), llm);
  // Arrange: explicitly select the supported provider.
  process.env.MODEL_PROVIDER = 'chatgpt';
  // Act / Assert: explicit ChatGPT selection returns the same interface.
  assert.deepEqual(createLlm(), llm);
  for (const provider of ['openai', 'ChatGPT', '']) {
    // Arrange: set this unsupported provider spelling.
    process.env.MODEL_PROVIDER = provider;
    // Act / Assert: reject it with the provider name in the error.
    assert.throws(() => createLlm(), {
      message: `Model provider "${provider}" is not implemented`,
    });
  }
});

test('direct subscription request uses OAuth and validated JSON', async (t) => {
  // Arrange: prepare credentials and a multilingual decision for byte-split SSE delivery.
  const authPath = await setup(t);
  const unicodeDecision = { ...decision, reason: 'Worldwide — 日本 🌍' };
  const unicodeEvents = [
    {
      type: 'response.output_text.delta',
      delta: JSON.stringify(unicodeDecision),
    },
    events[1],
  ];
  // Act: review supplied text through the direct subscription endpoint.
  const value = await reviewJob('https://jobs.example/job', {
    authPath,
    listingText: 'Worldwide',
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
  // Assert: incremental decoding preserves the complete multilingual decision.
  assert.deepEqual(value, unicodeDecision);
});

test('review uses the configured applicant location rather than search regions', async (t) => {
  // Arrange: use valid saved credentials with Germany as the applicant location.
  const authPath = await setup(t);
  // Act: review a European remote listing for that applicant.
  await reviewJob('https://jobs.example/job', {
    authPath,
    location: 'Germany',
    listingText: 'Remote across Europe',
    fetch: async (_url, init) => {
      const { instructions } = JSON.parse(init.body);
      // Assert: policy uses the applicant location and excludes unrelated search defaults.
      assert.match(instructions, /living in "Germany"/);
      assert.match(instructions, /regions that include that location/);
      assert.doesNotMatch(instructions, /Philippines|APAC|Asia/);
      assert.match(
        instructions,
        /On-site\/hybrid or expired jobs are also ineligible/,
      );
      return stream(events);
    },
  });
});
// Shared fixture: LF-delimited SSE text lets tests control byte-level chunking.
function itemsText(items) {
  return items.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('extracted text is supplied without browsing tools', async (t) => {
  // Arrange: supply extracted listing text and a completed model response.
  const authPath = await setup(t);
  const options = {
    authPath,
    listingText: 'Work anywhere worldwide',
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
      assert.doesNotMatch(
        body.instructions,
        /web search|skills|seniority|salary|JSON|string fields/,
      );
      return stream(events);
    },
  };
  // Act / Assert: review the supplied text and return the validated decision.
  assert.deepEqual(await reviewJob('https://example.test', options), decision);
});

test('location decisions reject malformed values', () => {
  // Arrange: use the shared valid decision as the baseline for malformed table values.
  for (const value of [
    null,
    {},
    { ...decision, extra: true },
    { ...decision, reason: '' },
    { ...decision, evidence: 42 },
    { ...decision, eligibility: 'pending' },
  ]) {
    // Arrange: serialize this malformed location decision.
    // Act / Assert: parsing rejects it instead of accepting an invalid model response.
    assert.throws(() => parseDecision(JSON.stringify(value)));
  }
});

test('expired credentials fail before network access; location policy remains intact', async (t) => {
  // Arrange: replace saved credentials with expired tokens that cannot refresh.
  const authPath = await setup(t);
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: 'oauth', access: 'test', expires: 1 } }),
  );
  // Act / Assert: review fails locally before the injected network guard can run.
  await assert.rejects(
    reviewJob('https://example.test', {
      authPath,
      listingText: 'Worldwide',
      fetch: async () => {
        assert.fail('network');
      },
    }),
    /expired/,
  );
  // Act / Assert: location policy retains worldwide overrides and explicit residency limits.
  assert.match(
    locationRule('Philippines'),
    /work anywhere worldwide overrides country\/city location tags/,
  );
  assert.match(
    locationRule('Philippines'),
    /unless an explicit hiring\/residency restriction excludes the applicant's location/,
  );
});

test('review refreshes expiring credentials and sends the new access token to ChatGPT', async (t) => {
  // Arrange: save expired but refreshable credentials and record endpoint calls.
  const authPath = await setup(t);
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 },
    }),
  );
  const calls = [];
  // Act / Assert: refresh then review successfully using the newly issued access token.
  assert.deepEqual(
    await reviewJob('https://example.test', {
      authPath,
      listingText: 'Worldwide',
      fetch: async (url, init) => {
        calls.push(url);
        if (calls.length === 1) {
          assert.equal(url, 'https://auth.openai.com/oauth/token');
          return Response.json({
            access_token: 'new',
            refresh_token: 'rotated',
            expires_in: 3600,
          });
        }
        assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
        assert.equal(init.headers.Authorization, 'Bearer new');
        return stream(events);
      },
    }),
    decision,
  );
  // Assert: the flow requires exactly one refresh and one review request.
  assert.equal(calls.length, 2);
});

test('review reports missing credentials as an authentication error', async (t) => {
  // Arrange: derive a nonexistent credential path from the isolated fixture.
  const authPath = await setup(t);
  // Act / Assert: review classifies missing credentials as an authentication error.
  await assert.rejects(
    reviewJob('https://example.test', {
      authPath: join(authPath, 'missing'),
      listingText: 'Worldwide',
    }),
    AuthenticationError,
  );
});

test('default review uses supplied text with Luna medium and never scrapes', async (t) => {
  // Arrange: clear model, effort and scraper overrides and record outgoing requests.
  const authPath = await setup(t);
  testEnv(t, {});
  for (const key of ['MODEL_NAME', 'MODEL_EFFORT', 'FIRECRAWL_URL'])
    delete process.env[key];
  const calls = [];
  const signal = new AbortController().signal;
  // Act / Assert: default review returns the model decision using supplied listing text.
  assert.deepEqual(
    await reviewJob('https://example.test/job', {
      authPath,
      signal,
      listingText: 'Work anywhere worldwide',
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
    }),
    decision,
  );
  // Assert: only the model endpoint is contacted; no scraper request is made.
  assert.equal(calls.length, 1);
});

test('model and effort environment settings are used and invalid effort fails before retrieval', async (t) => {
  // Arrange: configure an explicit model and an effort that overrides its suffix.
  const authPath = await setup(t);
  testEnv(t, {
    MODEL_NAME: 'openai/gpt-6.1-sol#low',
    MODEL_EFFORT: 'high',
  });
  // Act: review using environment-based model settings.
  await reviewJob('https://example.test', {
    authPath,
    listingText: 'Worldwide',
    fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      // Assert: the provider prefix and effort suffix are normalized correctly.
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.deepEqual(body.reasoning, { effort: 'high' });
      return stream(events);
    },
  });
  // Arrange: replace the valid effort with an unsupported value.
  process.env.MODEL_EFFORT = 'typo';
  // Act / Assert: invalid effort fails before any retrieval or model request.
  await assert.rejects(
    reviewJob('https://example.test', {
      authPath,
      listingText: 'Worldwide',
      fetch: async () => assert.fail('network'),
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
      review('https://example.test', {
        fetch: async () => assert.fail('network'),
      }),
      /listingText is required/,
    );
  }
});

test('both reviewers validate the completed model response', async (t) => {
  // Arrange: provide valid credentials but return an empty completed model decision.
  const authPath = await setup(t);
  // Act / Assert: each reviewer rejects the malformed decision from the shared fixture.
  for (const review of [llm.reviewJob, llm.reviewStack])
    await assert.rejects(
      review('https://example.test', {
        authPath,
        location: 'Germany',
        skills: [{ Laravel: [] }],
        listingText: 'Worldwide Laravel',
        fetch: async () =>
          stream([
            { type: 'response.output_text.delta', delta: '{}' },
            events[1],
          ]),
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

test('stack review falls back to the full profile skills', async (t) => {
  // Arrange: load the expected default skills and valid saved credentials.
  const authPath = await setup(t);
  const profile = await loadProfile();
  // Act / Assert: omit skills and obtain the validated stack decision using profile defaults.
  assert.deepEqual(
    await llm.reviewStack('https://example.test', {
      authPath,
      listingText: 'Laravel and React',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        // Assert: the prompt contains the complete default skill expression.
        assert.ok(
          body.input[0].content[0].text.includes(
            JSON.stringify(profile.skills),
          ),
        );
        return stream([
          {
            type: 'response.output_text.delta',
            delta: JSON.stringify(stackDecision),
          },
          { type: 'response.completed' },
        ]);
      },
    }),
    stackDecision,
  );
});

test('stack review sends full canonical groups with a strict separate schema', async (t) => {
  // Arrange: include required skill groups, canonical alternatives and aliases.
  const authPath = await setup(t);
  const skills = [
    { Laravel: [] },
    { Vue: ['Vue.js', 'VueJS'], Nuxt: ['Nuxt.js'] },
  ];
  const listingText = 'Build with Laravel and React';
  // Act: review the listing against the explicitly supplied skill expression.
  const result = await llm.reviewStack('https://example.test', {
    authPath,
    skills,
    listingText,
    fetch: async (url, init) => {
      // Assert: stack instructions, canonical groups and strict schema stay location-independent.
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(init.body);
      assert.match(
        body.input[0].content[0].text,
        /Build with Laravel and React/,
      );
      assert.ok(body.input[0].content[0].text.includes(JSON.stringify(skills)));
      assert.doesNotMatch(body.input[0].content[0].text, /Philippines/);
      assert.match(body.instructions, /array is AND/);
      assert.match(body.instructions, /keys within a group are OR/);
      assert.match(body.instructions, /include the key itself/);
      assert.match(body.instructions, /Aliases count as one concept/);
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
});

test('shared transport rejects HTTP errors, incomplete streams and invalid effort', async (t) => {
  // Arrange: use valid credentials with the table's failing HTTP or SSE responses.
  const authPath = await setup(t);
  const options = {
    authPath,
  };
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
      request(
        {
          ...options,
          fetch: async () => response,
        },
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
    request(
      {
        ...options,
        effort: 'typo',
        fetch: async () => assert.fail('network'),
      },
      'instructions',
      'listing text',
      'test',
      {},
    ),
    /Invalid MODEL_EFFORT/,
  );
});

test('both reviewers preserve caller cancellation in the shared transport', async (t) => {
  // Arrange: share valid credentials across the two reviewer cases.
  const authPath = await setup(t);
  for (const review of [llm.reviewJob, llm.reviewStack]) {
    // Arrange: give each reviewer a fresh caller-owned signal and cancellation reason.
    const controller = new AbortController();
    const reason = new Error('Stop reviewing');
    // Act / Assert: cancellation during fetch rejects review with the original reason.
    await assert.rejects(
      review('https://example.test', {
        authPath,
        location: 'Germany',
        skills: [{ Laravel: [] }],
        listingText: 'Laravel',
        signal: controller.signal,
        fetch: async (_url, init) => {
          // Assert: the transport signal starts active and forwards caller cancellation exactly.
          assert.equal(init.signal.aborted, false);
          controller.abort(reason);
          assert.equal(init.signal.aborted, true);
          assert.equal(init.signal.reason, reason);
          init.signal.throwIfAborted();
        },
      }),
      reason,
    );
  }
});

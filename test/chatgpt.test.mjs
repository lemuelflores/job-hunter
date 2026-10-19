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
const stream = (items) =>
  new Response(
    items.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  );
function testEnv(t, values) {
  const original = process.env;
  process.env = { ...original, ...values };
  t.after(() => {
    process.env = original;
  });
}

test('provider factory defaults to ChatGPT and rejects unsupported providers', (t) => {
  testEnv(t, {});
  delete process.env.MODEL_PROVIDER;
  assert.deepEqual(createLlm(), llm);
  process.env.MODEL_PROVIDER = 'chatgpt';
  assert.deepEqual(createLlm(), llm);
  for (const provider of ['openai', 'ChatGPT', '']) {
    process.env.MODEL_PROVIDER = provider;
    assert.throws(() => createLlm(), {
      message: `Model provider "${provider}" is not implemented`,
    });
  }
});

test('direct subscription request uses OAuth and validated JSON', async (t) => {
  const authPath = await setup(t);
  const unicodeDecision = { ...decision, reason: 'Worldwide — 日本 🌍' };
  const unicodeEvents = [
    {
      type: 'response.output_text.delta',
      delta: JSON.stringify(unicodeDecision),
    },
    events[1],
  ];
  const value = await reviewJob('https://jobs.example/job', {
    authPath,
    listingText: 'Worldwide',
    fetch: async (url, init) => {
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
  assert.deepEqual(value, unicodeDecision);
});

test('review uses the configured applicant location rather than search regions', async (t) => {
  const authPath = await setup(t);
  await reviewJob('https://jobs.example/job', {
    authPath,
    location: 'Germany',
    listingText: 'Remote across Europe',
    fetch: async (_url, init) => {
      const { instructions } = JSON.parse(init.body);
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
function itemsText(items) {
  return items.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('extracted text is supplied without browsing tools', async (t) => {
  const authPath = await setup(t);
  const options = {
    authPath,
    listingText: 'Work anywhere worldwide',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
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
  assert.deepEqual(await reviewJob('https://example.test', options), decision);
});

test('location decisions reject malformed values', () => {
  for (const value of [
    null,
    {},
    { ...decision, extra: true },
    { ...decision, reason: '' },
    { ...decision, evidence: 42 },
    { ...decision, eligibility: 'pending' },
  ]) {
    assert.throws(() => parseDecision(JSON.stringify(value)));
  }
});

test('expired credentials fail before network access; location policy remains intact', async (t) => {
  const authPath = await setup(t);
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: 'oauth', access: 'test', expires: 1 } }),
  );
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
  const authPath = await setup(t);
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 },
    }),
  );
  const calls = [];
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
  assert.equal(calls.length, 2);
});

test('review reports missing credentials as an authentication error', async (t) => {
  const authPath = await setup(t);
  await assert.rejects(
    reviewJob('https://example.test', {
      authPath: join(authPath, 'missing'),
      listingText: 'Worldwide',
    }),
    AuthenticationError,
  );
});

test('default review uses supplied text with Luna medium and never scrapes', async (t) => {
  const authPath = await setup(t);
  testEnv(t, {});
  for (const key of ['MODEL_NAME', 'MODEL_EFFORT', 'FIRECRAWL_URL'])
    delete process.env[key];
  const calls = [];
  const signal = new AbortController().signal;
  assert.deepEqual(
    await reviewJob('https://example.test/job', {
      authPath,
      signal,
      listingText: 'Work anywhere worldwide',
      fetch: async (url, init) => {
        calls.push(url);
        const body = JSON.parse(init.body);
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
  assert.equal(calls.length, 1);
});

test('model and effort environment settings are used and invalid effort fails before retrieval', async (t) => {
  const authPath = await setup(t);
  testEnv(t, {
    MODEL_NAME: 'openai/gpt-6.1-sol#low',
    MODEL_EFFORT: 'high',
  });
  await reviewJob('https://example.test', {
    authPath,
    listingText: 'Worldwide',
    fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.deepEqual(body.reasoning, { effort: 'high' });
      return stream(events);
    },
  });
  process.env.MODEL_EFFORT = 'typo';
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
  for (const review of [llm.reviewJob, llm.reviewStack]) {
    await assert.rejects(
      review('https://example.test', {
        fetch: async () => assert.fail('network'),
      }),
      /listingText is required/,
    );
  }
});

test('both reviewers validate the completed model response', async (t) => {
  const authPath = await setup(t);
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

const stackDecision = {
  status: 'partial_match',
  reason: 'Laravel aligns; React is also required.',
  evidence: '"Build with Laravel and React"',
};

test('stack review falls back to the full profile skills', async (t) => {
  const authPath = await setup(t);
  const profile = await loadProfile();
  assert.deepEqual(
    await llm.reviewStack('https://example.test', {
      authPath,
      listingText: 'Laravel and React',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
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
  const authPath = await setup(t);
  const skills = [
    { Laravel: [] },
    { Vue: ['Vue.js', 'VueJS'], Nuxt: ['Nuxt.js'] },
  ];
  const listingText = 'Build with Laravel and React';
  const result = await llm.reviewStack('https://example.test', {
    authPath,
    skills,
    listingText,
    fetch: async (url, init) => {
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
  assert.deepEqual(result, stackDecision);
});

test('stack decisions strictly reject malformed values and prototype keys', () => {
  for (const status of [
    'match',
    'partial_match',
    'potential_match',
    'unclear',
  ]) {
    const value = { ...stackDecision, status };
    assert.deepEqual(parseStackDecision(JSON.stringify(value)), value);
  }
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
  assert.throws(() => parseStackDecision('{malformed'));
  assert.throws(() =>
    parseStackDecision(
      '{"status":"match","reason":"Aligned","evidence":"","__proto__":{}}',
    ),
  );
});

test('shared transport rejects HTTP errors, incomplete streams and invalid effort', async (t) => {
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
  const authPath = await setup(t);
  for (const review of [llm.reviewJob, llm.reviewStack]) {
    const controller = new AbortController();
    const reason = new Error('Stop reviewing');
    await assert.rejects(
      review('https://example.test', {
        authPath,
        location: 'Germany',
        skills: [{ Laravel: [] }],
        listingText: 'Laravel',
        signal: controller.signal,
        fetch: async (_url, init) => {
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

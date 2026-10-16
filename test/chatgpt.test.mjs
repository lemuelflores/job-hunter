import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  locationRule,
  parseDecision,
  reviewJob,
} from '../dist/llm/chatgpt/review.js';
import { AuthenticationError, RateLimitError } from '../dist/llm/index.js';

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

test('direct subscription request uses OAuth and validated JSON', async (t) => {
  const authPath = await setup(t);
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
      const bytes = new TextEncoder().encode(itemsText(events));
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
  assert.deepEqual(value, decision);
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

test('extracted text is treated as untrusted input and requires completion', async (t) => {
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
  await assert.rejects(
    reviewJob('https://example.test', {
      ...options,
      fetch: async () => stream([events[0]]),
    }),
  );
});

test('rejects HTTP errors, failed/incomplete streams, and malformed decisions', async (t) => {
  const authPath = await setup(t);
  for (const response of [
    new Response('secret upstream details', { status: 429 }),
    stream(events.slice(0, 1)),
    stream([{ type: 'response.failed' }]),
    stream([{ type: 'response.incomplete' }]),
    stream([{ type: 'response.output_text.delta', delta: '{}' }, events[1]]),
  ]) {
    await assert.rejects(
      reviewJob('https://example.test', {
        authPath,
        listingText: 'Worldwide',
        fetch: async () => response,
      }),
    );
  }
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

test('worker can distinguish credential and rate-limit failures from per-listing errors', async (t) => {
  const authPath = await setup(t);
  for (const [status, type] of [
    [401, AuthenticationError],
    [403, AuthenticationError],
    [429, RateLimitError],
    [500, Error],
  ]) {
    await assert.rejects(
      reviewJob('https://example.test', {
        authPath,
        listingText: 'Worldwide',
        fetch: async () => new Response('', { status }),
      }),
      type,
    );
  }
  await assert.rejects(
    reviewJob('https://example.test', { authPath: join(authPath, 'missing') }),
    AuthenticationError,
  );
});

test('default review scrapes with Firecrawl before Luna medium analysis without search tools', async (t) => {
  const authPath = await setup(t);
  testEnv(t, {});
  for (const key of ['JOB_HUNTER_MODEL', 'JOB_HUNTER_EFFORT', 'FIRECRAWL_URL'])
    delete process.env[key];
  const calls = [];
  const signal = new AbortController().signal;
  assert.deepEqual(
    await reviewJob('https://example.test/job', {
      authPath,
      signal,
      fetch: async (url, init) => {
        calls.push(url);
        const body = JSON.parse(init.body);
        assert.equal(init.signal.aborted, false);
        if (calls.length === 1) {
          assert.equal(url, 'http://127.0.0.1:3002/v2/scrape');
          assert.deepEqual(body, {
            url: 'https://example.test/job',
            formats: ['markdown'],
            timeout: 60000,
          });
          return Response.json({
            success: true,
            data: { markdown: 'Work anywhere worldwide' },
          });
        }
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
  assert.equal(calls.length, 2);
});

test('model and effort environment settings are used and invalid effort fails before retrieval', async (t) => {
  const authPath = await setup(t);
  testEnv(t, {
    JOB_HUNTER_MODEL: 'openai/gpt-6.1-sol#low',
    JOB_HUNTER_EFFORT: 'high',
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
  process.env.JOB_HUNTER_EFFORT = 'typo';
  await assert.rejects(
    reviewJob('https://example.test', {
      authPath,
      fetch: async () => assert.fail('network'),
    }),
    /Invalid JOB_HUNTER_EFFORT/,
  );
});

test('failed extraction does not call ChatGPT', async (t) => {
  const authPath = await setup(t);
  for (const data of [
    { markdown: '' },
    {
      markdown: 'The job board you were viewing is no longer active.',
      metadata: { statusCode: 404 },
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      reviewJob('https://example.test', {
        authPath,
        fetch: async () => {
          assert.equal(++calls, 1);
          return Response.json({ success: true, data });
        },
      }),
      /Firecrawl extraction failed|Page returned 404 status/,
    );
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatgpt } from '../src/integrations/llm/chatgpt/index.ts';
import { createRequest } from '../src/integrations/llm/chatgpt/request.ts';
import {
  AuthenticationError,
  RateLimitError,
} from '../src/integrations/llm/types.ts';
import { assessment, stream } from './fixtures/workflow.mjs';

const input = { listingText: 'Worldwide', cv: 'CV', profile: 'Profile' };
const credentials = async () => ({
  access: 'test-token',
  accountId: 'test-account',
});

test('assessment uses injected credentials and decodes byte-split multilingual responses', async () => {
  const result = { ...assessment, summary: 'Worldwide — 日本 🌍' };
  const signal = new AbortController().signal;
  const provider = createChatgpt({
    authPath: 'credentials.json',
    getCredentials: async (options) => {
      assert.equal(options.authPath, 'credentials.json');
      assert.equal(options.signal, signal);
      return credentials();
    },
    fetch: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'test-account');
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.text.format.strict, true);
      const events = [
        { type: 'response.output_text.delta', delta: JSON.stringify(result) },
        { type: 'response.completed' },
      ];
      const bytes = new TextEncoder().encode(
        events
          .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
          .join(''),
      );
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
  assert.deepEqual(await provider.assess({ ...input, signal }), result);
});

test('credential failure prevents a model request', async () => {
  const error = new AuthenticationError('Sign in again');
  const provider = createChatgpt({
    getCredentials: async () => {
      throw error;
    },
    fetch: async () => assert.fail('unexpected network request'),
  });
  await assert.rejects(provider.assess(input), (actual) => actual === error);
});

test('assessment uses the default model and effort without browsing or scraping', async (t) => {
  const original = process.env;
  process.env = { ...original };
  delete process.env.MODEL_NAME;
  delete process.env.MODEL_EFFORT;
  t.after(() => {
    process.env = original;
  });
  const provider = createChatgpt({
    getCredentials: credentials,
    fetch: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.equal(
        JSON.parse(body.input[0].content[0].text).job_description,
        input.listingText,
      );
      return stream(assessment);
    },
  });
  assert.deepEqual(await provider.assess(input), assessment);
});

test('model environment settings are normalized and invalid effort fails before credentials', async (t) => {
  const original = process.env;
  process.env = {
    ...original,
    MODEL_NAME: 'openai/gpt-6.1-sol#low',
    MODEL_EFFORT: 'high',
  };
  t.after(() => {
    process.env = original;
  });
  const provider = createChatgpt({
    getCredentials: credentials,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.deepEqual(body.reasoning, { effort: 'high' });
      return stream(assessment);
    },
  });
  await provider.assess(input);
  process.env.MODEL_EFFORT = 'typo';
  await assert.rejects(provider.assess(input), /Invalid MODEL_EFFORT/);
});

test('assessment preserves caller cancellation in the transport', async () => {
  const controller = new AbortController();
  const reason = new Error('Stop assessing');
  const provider = createChatgpt({
    getCredentials: credentials,
    fetch: async (_url, init) => {
      assert.equal(init.signal.aborted, false);
      controller.abort(reason);
      assert.equal(init.signal.reason, reason);
      init.signal.throwIfAborted();
    },
  });
  await assert.rejects(
    provider.assess({ ...input, signal: controller.signal }),
    reason,
  );
});

test('transport rejects HTTP errors and incomplete or failed streams', async () => {
  const events = (items) =>
    new Response(
      items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''),
    );
  for (const [response, error] of [
    [new Response('', { status: 401 }), AuthenticationError],
    [new Response('', { status: 403 }), AuthenticationError],
    [new Response('', { status: 429 }), RateLimitError],
    [new Response('', { status: 500 }), /ChatGPT HTTP 500/],
    [new Response(null), /Empty ChatGPT response/],
    [events([{ type: 'error' }]), /ChatGPT error/],
    [events([{ type: 'response.failed' }]), /response.failed/],
    [events([{ type: 'response.incomplete' }]), /response.incomplete/],
    [
      events([{ type: 'response.output_text.delta', delta: '{}' }]),
      /did not complete/,
    ],
  ]) {
    await assert.rejects(
      createRequest({
        getCredentials: credentials,
        fetch: async () => response,
      })({}, 'instructions', 'listing text', 'test', {}),
      error,
    );
  }
});

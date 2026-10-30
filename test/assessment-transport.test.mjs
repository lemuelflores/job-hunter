import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatgpt } from '../src/integrations/llm/chatgpt/index.ts';
import { createRequest } from '../src/integrations/llm/chatgpt/request.ts';
import { createGemini } from '../src/integrations/llm/gemini/index.ts';
import { createRequest as createGeminiRequest } from '../src/integrations/llm/gemini/request.ts';
import { createGroq } from '../src/integrations/llm/groq/index.ts';
import { createRequest as createGroqRequest } from '../src/integrations/llm/groq/request.ts';
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

function geminiResponse(decision, extraParts = []) {
  return Response.json({
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [...extraParts, { text: JSON.stringify(decision) }],
        },
      },
    ],
  });
}

test('gemini authenticate verifies GEMINI_API_KEY and rejects missing or blank keys', async (t) => {
  const original = process.env;
  process.env = { ...original };
  t.after(() => {
    process.env = original;
  });
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(
    createGemini().authenticate(),
    (error) =>
      error instanceof AuthenticationError &&
      /GEMINI_API_KEY/.test(error.message),
  );
  process.env.GEMINI_API_KEY = '   ';
  await assert.rejects(createGemini().authenticate(), AuthenticationError);
  process.env.GEMINI_API_KEY = 'env-gemini-key';
  await createGemini().authenticate();
  delete process.env.GEMINI_API_KEY;
  await createGemini({ apiKey: 'injected-key' }).authenticate();
});

test('gemini assessment uses default model and effort, filters thought parts, and sends structured JSON config', async (t) => {
  const original = process.env;
  process.env = { ...original, GEMINI_API_KEY: '  env-gemini-key  ' };
  delete process.env.MODEL_NAME;
  delete process.env.MODEL_EFFORT;
  t.after(() => {
    process.env = original;
  });
  const result = { ...assessment, summary: 'Worldwide — 日本 🌍' };
  const provider = createGemini({
    fetch: async (url, init) => {
      assert.equal(
        url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      );
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-goog-api-key'], 'env-gemini-key');
      assert.equal(init.headers['Content-Type'], 'application/json');
      const body = JSON.parse(init.body);
      assert.equal(
        JSON.parse(body.contents[0].parts[0].text).job_description,
        input.listingText,
      );
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.thinkingConfig, {
        thinkingLevel: 'medium',
      });
      assert.equal(body.tools, undefined);
      return geminiResponse(result, [
        { thought: true, text: '{"verdict":"Apply"}' },
      ]);
    },
  });
  assert.deepEqual(await provider.assess(input), result);
});

test('gemini normalizes model prefixes and variants and validates MODEL_EFFORT before credentials', async (t) => {
  const original = process.env;
  process.env = { ...original };
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    process.env = original;
  });
  for (const [rawModel, expectedModel, effort] of [
    ['google/gemini-3.8-flash#high', 'gemini-3.8-flash', 'minimal'],
    ['gemini/gemini-3.8-pro#low', 'gemini-3.8-pro', 'low'],
    ['gemini-3.8-flash', 'gemini-3.8-flash', 'high'],
  ]) {
    process.env.MODEL_NAME = rawModel;
    process.env.MODEL_EFFORT = effort;
    const provider = createGemini({
      apiKey: 'test-key',
      fetch: async (url, init) => {
        assert.equal(
          url,
          `https://generativelanguage.googleapis.com/v1beta/models/${expectedModel}:generateContent`,
        );
        const body = JSON.parse(init.body);
        assert.deepEqual(body.generationConfig.thinkingConfig, {
          thinkingLevel: effort,
        });
        return geminiResponse(assessment);
      },
    });
    await provider.assess(input);
  }
  process.env.MODEL_EFFORT = 'none';
  const unauthenticated = createGemini({
    fetch: async () => assert.fail('unexpected network request'),
  });
  await assert.rejects(unauthenticated.assess(input), /Invalid MODEL_EFFORT/);
});

test('gemini assessment preserves caller cancellation in the transport', async () => {
  const controller = new AbortController();
  const reason = new Error('Stop assessing');
  const provider = createGemini({
    apiKey: 'test-key',
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

test('gemini transport rejects missing API key, HTTP errors, blocked prompts, and incomplete or malformed responses', async (t) => {
  const original = process.env;
  process.env = { ...original };
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    process.env = original;
  });
  await assert.rejects(
    createGeminiRequest({
      fetch: async () => assert.fail('unexpected network request'),
    })({}, 'instructions', 'listing text', 'test', {}),
    AuthenticationError,
  );
  for (const [response, error] of [
    [new Response('', { status: 401 }), AuthenticationError],
    [new Response('', { status: 403 }), AuthenticationError],
    [new Response('', { status: 429 }), RateLimitError],
    [new Response('', { status: 500 }), /Gemini HTTP 500/],
    [new Response('not-json'), /Invalid Gemini response/],
    [Response.json({ candidates: 'bad' }), /Invalid Gemini response/],
    [
      Response.json({ promptFeedback: { blockReason: 'SAFETY' } }),
      /Gemini blocked prompt: SAFETY/,
    ],
    [Response.json({ candidates: [] }), /Empty Gemini response/],
    [
      Response.json({
        candidates: [
          {
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: '{}' }] },
          },
        ],
      }),
      /Gemini finishReason: MAX_TOKENS/,
    ],
    [
      Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ thought: true, text: 'thinking only' }] },
          },
        ],
      }),
      /Empty Gemini response/,
    ],
  ]) {
    await assert.rejects(
      createGeminiRequest({
        apiKey: 'test-key',
        fetch: async () => response,
      })({}, 'instructions', 'listing text', 'test', {}),
      error,
    );
  }
});

function groqResponse(decision, extraMessage = {}) {
  return Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify(decision),
          ...extraMessage,
        },
      },
    ],
  });
}

test('groq authenticate verifies GROQ_API_KEY and rejects missing or blank keys', async (t) => {
  const original = process.env;
  process.env = { ...original };
  t.after(() => {
    process.env = original;
  });
  delete process.env.GROQ_API_KEY;
  await assert.rejects(
    createGroq().authenticate(),
    (error) =>
      error instanceof AuthenticationError &&
      /GROQ_API_KEY/.test(error.message),
  );
  process.env.GROQ_API_KEY = '   ';
  await assert.rejects(createGroq().authenticate(), AuthenticationError);
  process.env.GROQ_API_KEY = 'env-groq-key';
  await createGroq().authenticate();
  delete process.env.GROQ_API_KEY;
  await createGroq({ apiKey: 'injected-key' }).authenticate();
});

test('groq assessment uses default model and effort, ignores reasoning fields, and sends structured JSON config', async (t) => {
  const original = process.env;
  process.env = { ...original, GROQ_API_KEY: '  env-groq-key  ' };
  delete process.env.MODEL_NAME;
  delete process.env.MODEL_EFFORT;
  t.after(() => {
    process.env = original;
  });
  const result = { ...assessment, summary: 'Worldwide — 日本 🌍' };
  const provider = createGroq({
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer env-groq-key');
      assert.equal(init.headers['Content-Type'], 'application/json');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'openai/gpt-oss-120b');
      assert.equal(body.reasoning_effort, 'medium');
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'user');
      assert.equal(
        JSON.parse(body.messages[1].content).job_description,
        input.listingText,
      );
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.name, 'job_assessment_v1');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.tools, undefined);
      return groqResponse(result, {
        reasoning: 'Step-by-step reasoning before structured output',
      });
    },
  });
  assert.deepEqual(await provider.assess(input), result);
});

test('groq normalizes model prefixes and variants while preserving vendor slashes and validates MODEL_EFFORT before credentials', async (t) => {
  const original = process.env;
  process.env = { ...original };
  delete process.env.GROQ_API_KEY;
  t.after(() => {
    process.env = original;
  });
  for (const [rawModel, expectedModel, effort] of [
    ['groq/openai/gpt-oss-120b#high', 'openai/gpt-oss-120b', 'high'],
    ['groq/qwen/qwen3.8-27b#low', 'qwen/qwen3.8-27b', 'low'],
    ['openai/gpt-oss-20b#medium', 'openai/gpt-oss-20b', 'none'],
  ]) {
    process.env.MODEL_NAME = rawModel;
    process.env.MODEL_EFFORT = effort;
    const provider = createGroq({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.model, expectedModel);
        assert.equal(body.reasoning_effort, effort);
        return groqResponse(assessment);
      },
    });
    await provider.assess(input);
  }
  process.env.MODEL_EFFORT = 'typo';
  const unauthenticated = createGroq({
    fetch: async () => assert.fail('unexpected network request'),
  });
  await assert.rejects(unauthenticated.assess(input), /Invalid MODEL_EFFORT/);
});

test('groq assessment preserves caller cancellation in the transport', async () => {
  const controller = new AbortController();
  const reason = new Error('Stop assessing');
  const provider = createGroq({
    apiKey: 'test-key',
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

test('groq transport rejects missing API key, HTTP errors, refusals, and incomplete or malformed responses', async (t) => {
  const original = process.env;
  process.env = { ...original };
  delete process.env.GROQ_API_KEY;
  t.after(() => {
    process.env = original;
  });
  await assert.rejects(
    createGroqRequest({
      fetch: async () => assert.fail('unexpected network request'),
    })({}, 'instructions', 'listing text', 'test', {}),
    AuthenticationError,
  );
  for (const [response, error] of [
    [new Response('', { status: 401 }), AuthenticationError],
    [new Response('', { status: 403 }), AuthenticationError],
    [new Response('', { status: 429 }), RateLimitError],
    [new Response('', { status: 500 }), /Groq HTTP 500/],
    [new Response('not-json'), /Invalid Groq response/],
    [Response.json({ choices: 'bad' }), /Invalid Groq response/],
    [Response.json({ choices: [] }), /Empty Groq response/],
    [
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { refusal: 'Policy violation', content: null },
          },
        ],
      }),
      /Groq refused prompt: Policy violation/,
    ],
    [
      Response.json({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '{}' },
          },
        ],
      }),
      /Groq finish_reason: length/,
    ],
    [
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '   ' },
          },
        ],
      }),
      /Empty Groq response/,
    ],
  ]) {
    await assert.rejects(
      createGroqRequest({
        apiKey: 'test-key',
        fetch: async () => response,
      })({}, 'instructions', 'listing text', 'test', {}),
      error,
    );
  }
});

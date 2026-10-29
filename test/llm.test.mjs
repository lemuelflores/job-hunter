import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm } from '../src/entrypoints/compose.ts';

test('provider selection defaults to ChatGPT, supports Gemini, and rejects unsupported providers', (t) => {
  // Arrange: isolate provider configuration from the environment.
  const original = process.env;
  process.env = { ...original };
  t.after(() => {
    process.env = original;
  });
  delete process.env.MODEL_PROVIDER;
  const chatgpt = createLlm('chatgpt');
  const gemini = createLlm('gemini');
  // Act / Assert: default and explicit environment selection memoize each supported provider.
  assert.notEqual(chatgpt, gemini);
  assert.deepEqual(createLlm(), chatgpt);
  process.env.MODEL_PROVIDER = 'chatgpt';
  assert.deepEqual(createLlm(), chatgpt);
  process.env.MODEL_PROVIDER = 'gemini';
  assert.deepEqual(createLlm(), gemini);
  for (const provider of ['openai', 'ChatGPT', 'Gemini', 'google', '']) {
    // Arrange: set this unsupported provider spelling.
    process.env.MODEL_PROVIDER = provider;
    // Act / Assert: reject it with the provider name in the error.
    assert.throws(() => createLlm(), {
      message: `Model provider "${provider}" is not implemented`,
    });
  }
});

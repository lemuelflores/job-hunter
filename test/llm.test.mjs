import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm } from '../dist/review/llm/index.js';

test('provider selection defaults to ChatGPT and rejects unsupported providers', (t) => {
  // Arrange: isolate provider configuration from the environment.
  const original = process.env;
  process.env = { ...original };
  t.after(() => {
    process.env = original;
  });
  delete process.env.MODEL_PROVIDER;
  const chatgpt = createLlm('chatgpt');
  // Act / Assert: default and explicit environment selection use ChatGPT.
  assert.deepEqual(createLlm(), chatgpt);
  process.env.MODEL_PROVIDER = 'chatgpt';
  assert.deepEqual(createLlm(), chatgpt);
  for (const provider of ['openai', 'ChatGPT', '']) {
    // Arrange: set this unsupported provider spelling.
    process.env.MODEL_PROVIDER = provider;
    // Act / Assert: reject it with the provider name in the error.
    assert.throws(() => createLlm(), {
      message: `Model provider "${provider}" is not implemented`,
    });
  }
});

import { createLlm } from './llm/index.js';
import type { LlmProvider } from './llm/types.js';

export async function authenticate(llm: LlmProvider = createLlm()) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Authentication interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await llm.authenticate({ signal: controller.signal });
    console.log('Signed in with ChatGPT.');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

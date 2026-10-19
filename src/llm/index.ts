import { authenticate } from './chatgpt/auth.js';
import { reviewJob } from './chatgpt/review.js';
import { reviewStack } from './chatgpt/stack.js';
import type { LlmProvider } from './types.js';

const chatgpt: LlmProvider = { authenticate, reviewJob, reviewStack };

export function createLlm(
  provider = process.env.MODEL_PROVIDER ?? 'chatgpt',
): LlmProvider {
  switch (provider) {
    case 'chatgpt':
      return chatgpt;
    default:
      throw new Error(`Model provider "${provider}" is not implemented`);
  }
}
export { AuthenticationError, RateLimitError } from './types.js';

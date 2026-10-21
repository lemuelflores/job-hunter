import { authenticate } from './chatgpt/auth.js';
import { reviewJob } from './chatgpt/location-check.js';
import { createRequest, type RequestDependencies } from './chatgpt/request.js';
import { reviewStack } from './chatgpt/tech-check.js';
import type { LlmProvider } from './types.js';

export function createChatgpt(dependencies?: RequestDependencies): LlmProvider {
  const request = createRequest(dependencies);
  return {
    authenticate: (options) =>
      authenticate({
        ...options,
        fetch: dependencies?.fetch,
        authPath: dependencies?.authPath,
      }),
    reviewJob: (url, options) => reviewJob(url, options, request),
    reviewStack: (url, options) => reviewStack(url, options, request),
  };
}

const chatgpt = createChatgpt();

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

import type { LlmProvider } from '../types.js';
import { authenticate } from './auth.js';
import { reviewJob } from './location-check.js';
import { createRequest, type RequestDependencies } from './request.js';
import { reviewStack } from './tech-check.js';

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

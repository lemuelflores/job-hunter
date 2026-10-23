import type { LlmProvider } from '../types.ts';
import { authenticate } from './auth.ts';
import { reviewJob } from './location-check.ts';
import { createRequest, type RequestDependencies } from './request.ts';
import { reviewStack } from './tech-check.ts';

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

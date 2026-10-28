import type { LlmProvider } from '../types.ts';
import { assessListing } from './assessment.ts';
import { authenticate } from './auth.ts';
import { createRequest, type RequestDependencies } from './request.ts';

export function createChatgpt(dependencies?: RequestDependencies): LlmProvider {
  const request = createRequest(dependencies);
  return {
    authenticate: (options) =>
      authenticate({
        ...options,
        fetch: dependencies?.fetch,
        authPath: dependencies?.authPath,
      }),
    assess: (input) => assessListing(input, request),
  };
}

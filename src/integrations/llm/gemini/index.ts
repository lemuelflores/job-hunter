import { assessListing } from '../assessment.ts';
import type { LlmProvider } from '../types.ts';
import {
  createRequest,
  type GeminiRequestDependencies,
  resolveApiKey,
} from './request.ts';

export function createGemini(
  dependencies?: GeminiRequestDependencies,
): LlmProvider {
  const request = createRequest(dependencies);
  return {
    authenticate: async (options) => {
      options?.signal?.throwIfAborted();
      resolveApiKey(dependencies?.apiKey);
    },
    assess: (input) => assessListing(input, request),
  };
}

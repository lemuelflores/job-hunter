import { authenticate } from './chatgpt/auth.js';
import { reviewJob } from './chatgpt/review.js';
import { reviewStack } from './chatgpt/stack.js';
import type { LlmProvider } from './types.js';

export const llm: LlmProvider = { authenticate, reviewJob, reviewStack };
export { AuthenticationError, RateLimitError } from './types.js';

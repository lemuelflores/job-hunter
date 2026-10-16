export interface Decision {
  eligibility: string;
  reason: string;
  evidence: string;
  company: string;
  location: string;
  title: string;
}

export interface ReviewOptions {
  location?: string;
  fetch?: typeof fetch;
  authPath?: string;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  listingText?: string;
}

export interface AuthOptions {
  fetch?: typeof fetch;
  authPath?: string;
  signal?: AbortSignal;
  onAuthorize?: (url: string) => void;
}

export interface LlmProvider {
  authenticate(options?: AuthOptions): Promise<void>;
  reviewJob(url: string, options?: ReviewOptions): Promise<Decision>;
}

export class AuthenticationError extends Error {}
export class RateLimitError extends Error {}

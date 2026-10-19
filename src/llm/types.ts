import type { SearchTerms } from '../profile.js';

export interface Decision {
  eligibility: 'eligible' | 'ineligible' | 'unclear';
  reason: string;
  evidence: string;
  company: string;
  location: string;
  title: string;
}

export interface ReviewOptions {
  location?: string;
  skills?: SearchTerms;
  fetch?: typeof fetch;
  authPath?: string;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  listingText?: string;
}

export interface StackDecision {
  status: 'match' | 'partial_match' | 'potential_match' | 'unclear';
  reason: string;
  evidence: string;
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
  reviewStack(url: string, options?: ReviewOptions): Promise<StackDecision>;
}

export class AuthenticationError extends Error {}
export class RateLimitError extends Error {}

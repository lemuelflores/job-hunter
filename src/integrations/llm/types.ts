import type { Assessment } from '../../core/assessment.ts';

export interface ModelOptions {
  model?: string;
  effort?: string;
  signal?: AbortSignal;
}

export interface CandidateDocuments {
  cv: string;
  profile: string;
}

export interface AssessmentInput extends ModelOptions, CandidateDocuments {
  listingText: string;
}

export type AssessmentReviewer = (
  input: AssessmentInput,
) => Promise<Assessment>;

export interface AuthOptions {
  signal?: AbortSignal;
  onAuthorize?: (url: string) => void;
}

export interface LlmProvider {
  authenticate(options?: AuthOptions): Promise<void>;
  assess: AssessmentReviewer;
}

export class AuthenticationError extends Error {}
export class RateLimitError extends Error {}

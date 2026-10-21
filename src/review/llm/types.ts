export interface Decision {
  eligibility: 'eligible' | 'ineligible' | 'unclear';
  reason: string;
  evidence: string;
  company: string;
  location: string;
  title: string;
}

export interface ModelOptions {
  model?: string;
  effort?: string;
  signal?: AbortSignal;
}

export interface SavedListingInput extends ModelOptions {
  listingText: string;
}

export interface LocationAssessmentInput extends SavedListingInput {
  location: string;
}

export interface StackAssessmentInput extends SavedListingInput {
  stack: string[];
}

export interface StackDecision {
  status: 'match' | 'partial_match' | 'potential_match' | 'unclear';
  reason: string;
  evidence: string;
}

export interface AuthOptions {
  signal?: AbortSignal;
  onAuthorize?: (url: string) => void;
}

export type LocationReviewer = (
  url: string,
  input: SavedListingInput,
) => Promise<Decision>;

export type StackReviewer = (
  url: string,
  input: SavedListingInput,
) => Promise<StackDecision>;

export interface LlmProvider {
  authenticate(options?: AuthOptions): Promise<void>;
  reviewJob(url: string, input: LocationAssessmentInput): Promise<Decision>;
  reviewStack(url: string, input: StackAssessmentInput): Promise<StackDecision>;
}

export class AuthenticationError extends Error {}
export class RateLimitError extends Error {}

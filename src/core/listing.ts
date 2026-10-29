export const REVIEW_STATUSES = [
  'active',
  'hidden',
  'rejected',
  'stale',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ListingSource = 'google' | 'freehire' | 'user';

export interface Decision {
  eligibility: 'eligible' | 'ineligible' | 'unclear';
  reason: string;
  evidence: string;
  company: string;
  location: string;
  title: string;
}

export interface StackDecision {
  status: 'match' | 'partial_match' | 'potential_match' | 'unclear';
  reason: string;
  evidence: string;
}

export interface DiscoveredListing {
  source: ListingSource;
  url: string;
  title: string;
  snippet?: string;
  query: string;
  listingText?: string;
  postedAt?: string | null;
}

export interface Listing {
  id: number;
  source: ListingSource;
  query: string;
  url: string;
  title: string;
  snippet: string;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  eligibility: 'pending' | Decision['eligibility'] | 'error';
  reason: string;
  evidence: string;
  location: string;
  company: string;
  status: ReviewStatus;
  batch: string | null;
  attempts: number;
  next_retry_at: number;
  last_error: string;
  listing_text: string | null;
  stack_status: 'not_checked' | 'pending' | StackDecision['status'] | 'error';
  stack_reason: string;
  stack_evidence: string;
}

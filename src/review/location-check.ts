import type { Listing, SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export async function checkLocation(
  store: SqliteStore,
  job: Listing,
  review: LlmProvider['reviewJob'],
  signal?: AbortSignal,
) {
  if (!store.needsStage(job.id, 'location') || job.listing_text === null)
    return;
  const decision = await review(job.url, {
    signal,
    listingText: job.listing_text,
  });
  signal?.throwIfAborted();
  store.review(
    job.id,
    decision.eligibility,
    decision.reason,
    decision.evidence,
    decision.company,
    decision.location,
    decision.title,
  );
}

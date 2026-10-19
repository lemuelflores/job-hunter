import type { Listing, SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export async function checkTech(
  store: SqliteStore,
  job: Listing,
  review: LlmProvider['reviewStack'],
  signal?: AbortSignal,
) {
  if (!store.needsStage(job.id, 'stack') || job.listing_text === null) return;
  const decision = await review(job.url, {
    signal,
    listingText: job.listing_text,
  });
  signal?.throwIfAborted();
  store.reviewStack(job.id, decision);
}

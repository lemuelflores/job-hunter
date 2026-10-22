import type { SqliteStore } from '../infra/sqlite.js';
import type { StackReviewer } from '../integrations/llm/types.js';

export async function checkTech(
  store: SqliteStore,
  id: number,
  reviewStack: StackReviewer,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!store.needsStage(id, 'stack')) return;
  const job = store.getJob(id);
  if (job?.status !== 'active' || job.listing_text === null) return;
  const decision = await reviewStack(job.url, {
    signal,
    listingText: job.listing_text,
  });
  signal?.throwIfAborted();
  store.reviewStack(id, decision);
}

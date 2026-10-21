import type { ReviewQueues } from '../bullmq.js';
import type { SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export async function checkLocation(
  store: SqliteStore,
  id: number,
  reviewLocation: LlmProvider['reviewJob'],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!store.needsStage(id, 'location')) return;
  const job = store.getJob(id);
  if (job?.status !== 'active' || job.listing_text === null) return;
  const decision = await reviewLocation(job.url, {
    signal,
    listingText: job.listing_text,
  });
  signal?.throwIfAborted();
  store.review(
    id,
    decision.eligibility,
    decision.reason,
    decision.evidence,
    decision.company,
    decision.location,
    decision.title,
  );
}

export function startLocationWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewLocation: LlmProvider['reviewJob'],
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'location',
    (id) => checkLocation(store, id, reviewLocation, signal),
    signal,
  );
}

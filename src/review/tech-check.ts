import type { ReviewQueues } from '../bullmq.js';
import type { SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export async function checkTech(
  store: SqliteStore,
  id: number,
  reviewStack: LlmProvider['reviewStack'],
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

export function startTechWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewStack: LlmProvider['reviewStack'],
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'stack',
    (id) => checkTech(store, id, reviewStack, signal),
    signal,
  );
}

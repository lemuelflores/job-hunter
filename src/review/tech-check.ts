import type { ReviewQueues } from '../bullmq.js';
import type { SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export function startTechWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewStack: LlmProvider['reviewStack'],
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'stack',
    async (job) => {
      if (!store.needsStage(job.id, 'stack') || job.listing_text === null)
        return;
      const decision = await reviewStack(job.url, {
        signal,
        listingText: job.listing_text,
      });
      signal?.throwIfAborted();
      store.reviewStack(job.id, decision);
    },
    signal,
  );
}

import type { ReviewQueues } from '../bullmq.js';
import type { SqliteStore } from '../sqlite.js';
import type { LlmProvider } from './llm/types.js';

export function startLocationWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewLocation: LlmProvider['reviewJob'],
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'location',
    async (job) => {
      if (!store.needsStage(job.id, 'location') || job.listing_text === null)
        return;
      const decision = await reviewLocation(job.url, {
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
    },
    signal,
  );
}

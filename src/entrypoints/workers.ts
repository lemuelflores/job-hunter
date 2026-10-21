import type { FetchQueue, ReviewQueues } from '../bullmq.js';
import { discoverJobs } from '../discovery/discover.js';
import type { Profile } from '../profile.js';
import { crawlJob } from '../review/crawl.js';
import type { ListingExtractor } from '../review/extraction/types.js';
import type { LocationReviewer, StackReviewer } from '../review/llm/types.js';
import { checkLocation } from '../review/location-check.js';
import { checkTech } from '../review/tech-check.js';
import type { SqliteStore } from '../sqlite.js';

export function startFetchWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  queue: FetchQueue,
  profile: Profile,
) {
  return queue.startWorker(async () => {
    const { ids, ...outcome } = await discoverJobs(store, profile);
    for (const id of ids) await queues.scheduleListing(store, id);
    outcome.pending = store.pendingCount();
    console.log(JSON.stringify(outcome));
    if (outcome.failures.length) throw new Error(outcome.failures.join('; '));
  });
}

export function startCrawlWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  scrape?: ListingExtractor,
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'crawl',
    async (id) => {
      await crawlJob(store, id, scrape, signal);
      // Redelivery repairs a save/enqueue interruption without extracting again.
      for (const evaluation of ['location', 'stack'] as const)
        if (store.needsStage(id, evaluation))
          await queues.enqueue(evaluation, id);
    },
    signal,
  );
}

export function startLocationWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewLocation: LocationReviewer,
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'location',
    (id) => checkLocation(store, id, reviewLocation, signal),
    signal,
  );
}

export function startTechWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  reviewStack: StackReviewer,
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'stack',
    (id) => checkTech(store, id, reviewStack, signal),
    signal,
  );
}

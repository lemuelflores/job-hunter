import type { DiscoveryQueue, ReviewQueues } from '../infra/bullmq.js';
import type { Profile } from '../infra/config.js';
import type { SqliteStore } from '../infra/sqlite.js';
import type { ListingExtractor } from '../integrations/extraction.js';
import type {
  LocationReviewer,
  StackReviewer,
} from '../integrations/llm/types.js';
import type { FreehireConfig } from '../integrations/search/freehire.js';
import { crawlJob } from '../workflow/crawl.js';
import {
  type DiscoveryResult,
  discoverFreehireJobs,
  discoverGoogleJobs,
} from '../workflow/discover.js';
import { checkLocation } from '../workflow/location-check.js';
import { checkTech } from '../workflow/tech-check.js';
import {
  createCrawlExtractors,
  createFreehireSearch,
  createGoogleSearch,
  type GoogleAts,
} from './compose.js';

function startDiscoveryWorker(
  queue: DiscoveryQueue,
  discover: () => Promise<DiscoveryResult>,
) {
  return queue.startWorker(async () => {
    const outcome = await discover();
    return {
      added: outcome.added,
      pending: outcome.pending,
      failure_count: outcome.failures.length,
    };
  });
}

export function startGoogleWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  queue: DiscoveryQueue,
  profile: Profile,
  ats: GoogleAts,
) {
  return startDiscoveryWorker(queue, () =>
    discoverGoogleJobs(
      store,
      createGoogleSearch(profile.google, ats),
      async (stage, id) => {
        await queues.enqueue(stage, id);
      },
      (id) => queues.syncFailures(store, id),
    ),
  );
}

export function startFreehireWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  queue: DiscoveryQueue,
  config: FreehireConfig,
) {
  return startDiscoveryWorker(queue, () =>
    discoverFreehireJobs(
      store,
      createFreehireSearch(config),
      async (stage, id) => {
        await queues.enqueue(stage, id);
      },
      (id) => queues.syncFailures(store, id),
    ),
  );
}

export function startCrawlWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  scrape?: ListingExtractor,
  signal?: AbortSignal,
) {
  const extractors = scrape
    ? { ats: [], fallback: scrape }
    : createCrawlExtractors();
  return queues.startWorker(
    store,
    'crawl',
    (id) =>
      crawlJob(
        store,
        id,
        extractors,
        async (stage, id) => {
          await queues.enqueue(stage, id);
        },
        signal,
      ),
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

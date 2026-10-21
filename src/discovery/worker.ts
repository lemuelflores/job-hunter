import type { FetchQueue, ReviewQueues } from '../bullmq.js';
import type { Profile } from '../profile.js';
import type { SqliteStore } from '../sqlite.js';
import {
  buildQueryMatrix,
  runParallelGoogleSearchesDetailed,
} from './google.js';
import { normalizeJobUrl } from './job-url.js';

export function startFetchWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  queue: FetchQueue,
  profile: Profile,
) {
  return queue.startWorker(async () => {
    const searched = await runParallelGoogleSearchesDetailed(
      buildQueryMatrix(profile).map((spec) => spec.query),
      { concurrency: 5, num: 100 },
    );
    const results = searched.results.flatMap((result) => {
      const url = normalizeJobUrl(result.url);
      return url ? [{ ...result, url }] : [];
    });
    const added = store.saveResults(results);
    const urls = new Set(results.map((result) => result.url));
    for (const job of store.unfinished()) {
      if (urls.has(job.url)) await queues.scheduleListing(store, job.id);
    }
    const outcome = {
      added,
      pending: store.pendingCount(),
      failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
    };
    console.log(JSON.stringify(outcome));
    if (outcome.failures.length) throw new Error(outcome.failures.join('; '));
  });
}

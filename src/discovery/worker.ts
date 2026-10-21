import type { FetchQueue, JobQueues } from '../bullmq.js';
import type { Profile } from '../profile.js';
import type { SqliteStore } from '../sqlite.js';
import { fetchJobs } from './discover-jobs.js';

export function startFetchWorker(
  store: SqliteStore,
  queues: JobQueues,
  queue: FetchQueue,
  profile: Profile,
) {
  return queue.startWorker(async () => {
    const outcome = await fetchJobs(store, undefined, profile, async (ids) => {
      for (const id of ids) await queues.scheduleListing(store, id);
    });
    console.log(JSON.stringify(outcome));
    if (outcome.failures.length) throw new Error(outcome.failures.join('; '));
  });
}

import { JobQueues } from '../bullmq.js';
import { loadProfile, type Profile } from '../profile.js';
import type { SqliteStore } from '../sqlite.js';
import {
  buildQueryMatrix,
  runParallelGoogleSearchesDetailed,
} from './google.js';
import { normalizeJobUrl } from './job-url.js';

export async function fetchJobs(
  store: SqliteStore,
  search = runParallelGoogleSearchesDetailed,
  profile?: Profile,
  schedule = async (ids: number[]) => {
    const queues = new JobQueues();
    try {
      for (const id of ids) await queues.scheduleListing(store, id);
    } finally {
      await queues.close();
    }
  },
) {
  const searched = await search(
    buildQueryMatrix(profile ?? (await loadProfile())).map(
      (spec) => spec.query,
    ),
    { concurrency: 5, num: 100 },
  );
  const results = searched.results.flatMap((result) => {
    const url = normalizeJobUrl(result.url);
    return url ? [{ ...result, url }] : [];
  });
  const added = store.saveResults(results);
  const urls = new Set(results.map((result) => result.url));
  await schedule(
    store
      .unfinished()
      .filter((job) => urls.has(job.url))
      .map((job) => job.id),
  );
  return {
    added,
    pending: store.pendingCount(),
    failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
  };
}

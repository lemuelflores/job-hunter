import { JobQueues } from '../bullmq.js';
import { loadProfile, type Profile } from '../profile.js';
import { jobUrl, type SqliteStore } from '../sqlite.js';
import {
  buildQueryMatrix,
  runParallelGoogleSearchesDetailed,
} from './google.js';

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
  const added = store.saveResults(searched.results);
  const urls = new Set(searched.results.map((result) => jobUrl(result.url)));
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

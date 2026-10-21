import type { Profile } from '../profile.js';
import type { SqliteStore } from '../sqlite.js';
import {
  buildQueryMatrix,
  runParallelGoogleSearchesDetailed,
} from './google.js';
import { normalizeJobUrl } from './job-url.js';

export interface DiscoveryResult {
  ids: number[];
  added: number;
  pending: number;
  failures: string[];
}

export async function discoverJobs(
  store: SqliteStore,
  profile: Profile,
): Promise<DiscoveryResult> {
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
  return {
    ids: store
      .unfinished()
      .filter((job) => urls.has(job.url))
      .map((job) => job.id),
    added,
    pending: store.pendingCount(),
    failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
  };
}

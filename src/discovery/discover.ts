import type { Profile } from '../profile.js';
import type { DiscoveredListing, SqliteStore } from '../sqlite.js';
import {
  type FreehireConfig,
  type FreehireSearchOptions,
  searchFreehire,
} from './freehire.js';
import {
  normalizeGoogleQuery,
  runParallelGoogleSearchesDetailed,
} from './google.js';
import { normalizeFreehireUrl, normalizeJobUrl } from './job-url.js';

export interface DiscoveryResult {
  ids: number[];
  added: number;
  pending: number;
  failures: string[];
}

export async function discoverGoogleJobs(
  store: SqliteStore,
  profile: Profile,
): Promise<DiscoveryResult> {
  const searched = await runParallelGoogleSearchesDetailed(
    [normalizeGoogleQuery(profile.google.query)],
    { concurrency: 5, num: 100 },
  );
  const results = searched.results.flatMap<DiscoveredListing>((result) => {
    const url = normalizeJobUrl(result.url);
    return url ? [{ ...result, url, source: 'google' }] : [];
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

export async function discoverFreehireJobs(
  store: SqliteStore,
  config: FreehireConfig,
  options: FreehireSearchOptions = {},
): Promise<DiscoveryResult> {
  const query = JSON.stringify(config);
  const searched = await searchFreehire(config, options);
  const results = searched.jobs.flatMap<DiscoveredListing>((job) => {
    const url = normalizeFreehireUrl(job.url);
    const { url: _originalUrl, description, ...metadata } = job;
    return url
      ? [
          {
            url,
            title: job.title,
            source: 'freehire',
            query,
            postedAt: job.posted_at,
            listingText: `Freehire listing metadata:\n${JSON.stringify(metadata)}\n\n${description}`,
          },
        ]
      : [];
  });
  const added = store.saveResults(results);
  const urls = new Set(results.map((job) => job.url));
  return {
    ids: store
      .unfinished()
      .filter((job) => urls.has(job.url))
      .map((job) => job.id),
    added,
    pending: store.pendingCount(),
    failures: searched.failures,
  };
}

import type { Availability } from '../core/stale-check.ts';
import type { SqliteStore } from '../infra/sqlite.ts';
import { matchesAtsHost } from '../integrations/ats/url.ts';
import {
  type ListingExtractor,
  PageError,
} from '../integrations/extraction.ts';
import type { CrawlExtractors } from './crawl.ts';

export { rateLimitDelay } from '../core/stale-check.ts';

export interface StaleCheckDependencies {
  store: SqliteStore;
  extractors: CrawlExtractors;
  now: () => number;
  token: string;
  fetchPage?: typeof fetch;
  signal?: AbortSignal;
}

export async function runStaleCheck(
  deps: StaleCheckDependencies,
): Promise<Availability | null> {
  const { store, extractors } = deps;
  deps.signal?.throwIfAborted();
  store.startStaleSweep(deps.now());
  const definition = (url: string) => {
    const host = new URL(url).hostname;
    return extractors.ats.find((ats) => matchesAtsHost(host, ats.hosts));
  };
  const claim = store.claimStaleCheck(
    deps.now(),
    deps.token,
    (url) => definition(url)?.selector ?? 'firecrawl',
  );
  if (!claim) return null;
  const timeout = AbortSignal.timeout(90_000);
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, timeout])
    : timeout;
  const result = await checkAvailability(
    claim.url,
    definition(claim.url)?.extract ?? extractors.fallback,
    deps.fetchPage,
    signal,
  );
  store.completeStaleCheck(claim, result, deps.now());
  return result;
}

export async function checkAvailability(
  url: string,
  extract: ListingExtractor,
  fetchPage: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Availability> {
  let limited = false;
  let retryAfter: string | null = null;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetchPage(input, init);
    if (response.status === 429) {
      limited = true;
      retryAfter = response.headers.get('retry-after');
    }
    return response;
  };
  try {
    await extract(url, { fetch: observedFetch, signal });
    if (limited) return { kind: 'rate-limited', retryAfter };
    return { kind: 'available' };
  } catch (error) {
    signal?.throwIfAborted();
    if (limited || (error instanceof PageError && error.status === 429))
      return { kind: 'rate-limited', retryAfter };
    if (error instanceof PageError && [404, 410].includes(error.status))
      return { kind: 'missing' };
    return {
      kind: 'inconclusive',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

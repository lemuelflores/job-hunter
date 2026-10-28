import type { SqliteStore } from '../infra/sqlite.ts';
import type { AtsDefinition } from '../integrations/ats/types.ts';
import { matchesAtsHost } from '../integrations/ats/url.ts';
import {
  type ExtractedListing,
  type ListingExtractor,
  PageError,
} from '../integrations/extraction.ts';
import { type EnqueueStage, enqueueMissingStages } from './enqueue.ts';

export interface CrawlExtractors {
  ats: readonly AtsDefinition[];
  fallback: ListingExtractor;
}

export function extractListing(
  url: string,
  extractors: CrawlExtractors,
  signal?: AbortSignal,
): Promise<ExtractedListing> {
  const hostname = new URL(url).hostname;
  const ats = extractors.ats.find((definition) =>
    matchesAtsHost(hostname, definition.hosts),
  );
  return (ats?.extract ?? extractors.fallback)(url, { signal });
}

export async function crawlJob(
  store: SqliteStore,
  id: number,
  extractors: CrawlExtractors,
  enqueue: EnqueueStage,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!store.needsStage(id, 'crawl')) {
    await enqueueMissingStages(store, id, enqueue);
    return;
  }
  const job = store.getJob(id);
  if (job?.status !== 'active' || job.listing_text !== null) return;
  let listing: ExtractedListing;
  try {
    listing = await extractListing(job.url, extractors, signal);
  } catch (error) {
    signal?.throwIfAborted();
    // Another caller can complete this crawl while the request is in flight.
    if (!store.needsStage(id, 'crawl')) {
      await enqueueMissingStages(store, id, enqueue);
      return;
    }
    if (!(error instanceof PageError) || error.retryable) throw error;
    store.terminalCrawl(id, error.message);
    return;
  }
  signal?.throwIfAborted();
  // Keep an existing checkpoint instead of saving a second extraction.
  if (store.needsStage(id, 'crawl'))
    store.saveListingText(id, listing.text, listing.postedAt);
  await enqueueMissingStages(store, id, enqueue);
}

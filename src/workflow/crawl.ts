import type { SqliteStore } from '../infra/sqlite.js';
import type { AtsDefinition } from '../integrations/ats/types.js';
import {
  type ExtractedListing,
  type ListingExtractor,
  PageError,
} from '../integrations/extraction.js';
import { type EnqueueStage, enqueueMissingStages } from './enqueue.js';

export interface CrawlExtractors {
  ats: readonly AtsDefinition[];
  fallback: ListingExtractor;
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
    const hostname = new URL(job.url).hostname;
    const ats = extractors.ats.find((ats) => ats.hosts.includes(hostname));
    const extract = ats?.extract ?? extractors.fallback;
    listing = await extract(job.url, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    // Freehire can complete this crawl while the extraction request is in flight.
    if (!store.needsStage(id, 'crawl')) {
      await enqueueMissingStages(store, id, enqueue);
      return;
    }
    if (!(error instanceof PageError) || error.retryable) throw error;
    store.terminalCrawl(id, error.message);
    return;
  }
  signal?.throwIfAborted();
  // Keep Freehire's checkpoint instead of trying to save a second extraction.
  if (store.needsStage(id, 'crawl'))
    store.saveListingText(id, listing.text, listing.postedAt);
  await enqueueMissingStages(store, id, enqueue);
}

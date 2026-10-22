import type { SqliteStore } from '../sqlite.js';
import { fetchAshbyListing } from './extraction/ashby.js';
import { scrapeListing as firecrawlListing } from './extraction/firecrawl.js';
import { fetchGreenhouseListing } from './extraction/greenhouse.js';
import { fetchLeverListing } from './extraction/lever.js';
import {
  type ExtractedListing,
  type ListingExtractor,
  PageError,
} from './extraction/types.js';
import { fetchWorkableListing } from './extraction/workable.js';

export async function crawlJob(
  store: SqliteStore,
  id: number,
  scrape?: ListingExtractor,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!store.needsStage(id, 'crawl')) return;
  const job = store.getJob(id);
  if (job?.status !== 'active' || job.listing_text !== null) return;
  let listing: ExtractedListing;
  try {
    if (scrape) {
      listing = await scrape(job.url, { signal });
    } else {
      switch (new URL(job.url).hostname) {
        case 'jobs.ashbyhq.com':
          listing = await fetchAshbyListing(job.url, { signal });
          break;
        case 'job-boards.greenhouse.io':
        case 'boards.greenhouse.io':
          listing = await fetchGreenhouseListing(job.url, { signal });
          break;
        case 'jobs.lever.co':
        case 'jobs.eu.lever.co':
          listing = await fetchLeverListing(job.url, { signal });
          break;
        case 'apply.workable.com':
          listing = await fetchWorkableListing(job.url, { signal });
          break;
        default:
          listing = await firecrawlListing(job.url, { signal });
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    // Freehire can complete this crawl while the extraction request is in flight.
    if (!store.needsStage(id, 'crawl')) return;
    if (!(error instanceof PageError) || error.retryable) throw error;
    store.terminalCrawl(id, error.message);
    return;
  }
  signal?.throwIfAborted();
  // Keep Freehire's checkpoint instead of trying to save a second extraction.
  if (!store.needsStage(id, 'crawl')) return;
  store.saveListingText(id, listing.text, listing.postedAt);
}

import type { SqliteStore } from '../sqlite.js';
import { fetchAshbyListing } from './extraction/ashby.js';
import { scrapeListing as firecrawlListing } from './extraction/firecrawl.js';
import { fetchGreenhouseListing } from './extraction/greenhouse.js';
import { fetchLeverListing } from './extraction/lever.js';
import { type ListingExtractor, PageError } from './extraction/types.js';

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
  let text: string;
  try {
    if (scrape) {
      text = await scrape(job.url, { signal });
    } else if (new URL(job.url).hostname === 'jobs.ashbyhq.com') {
      text = await fetchAshbyListing(job.url, { signal });
    } else if (
      ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(
        new URL(job.url).hostname,
      )
    ) {
      text = await fetchGreenhouseListing(job.url, { signal });
    } else if (
      ['jobs.lever.co', 'jobs.eu.lever.co'].includes(new URL(job.url).hostname)
    ) {
      text = await fetchLeverListing(job.url, { signal });
    } else {
      text = await firecrawlListing(job.url, { signal });
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
  store.saveListingText(id, text);
}

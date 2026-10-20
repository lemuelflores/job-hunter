import type { Listing, SqliteStore, Stage } from '../sqlite.js';
import { fetchAshbyListing } from './ashby.js';
import { type ListingExtractor, PageError } from './extraction.js';
import { scrapeListing as firecrawlListing } from './firecrawl.js';

export async function crawlJob(
  store: SqliteStore,
  job: Listing,
  enqueue: (stage: Stage, id: number) => Promise<unknown>,
  scrape?: ListingExtractor,
  signal?: AbortSignal,
) {
  const id = job.id;
  if (store.needsStage(id, 'crawl') && job.listing_text === null) {
    let text: string;
    try {
      if (scrape) {
        text = await scrape(job.url, { signal });
      } else if (new URL(job.url).hostname === 'jobs.ashbyhq.com') {
        text = await fetchAshbyListing(job.url, { signal });
      } else {
        text = await firecrawlListing(job.url, { signal });
      }
    } catch (error) {
      if (!(error instanceof PageError) || error.retryable) throw error;
      signal?.throwIfAborted();
      store.terminalCrawl(id, error.message);
      return;
    }
    signal?.throwIfAborted();
    store.saveListingText(id, text);
  }
  // Redelivery also repairs a save/enqueue interruption without scraping again.
  for (const evaluation of ['location', 'stack'] as const)
    if (store.needsStage(id, evaluation)) await enqueue(evaluation, id);
}

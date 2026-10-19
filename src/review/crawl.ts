import type { Listing, SqliteStore, Stage } from '../sqlite.js';
import { PageError, scrapeListing } from './firecrawl.js';

export async function crawlJob(
  store: SqliteStore,
  job: Listing,
  enqueue: (stage: Stage, id: number) => Promise<unknown>,
  scrape = scrapeListing,
  signal?: AbortSignal,
) {
  const id = job.id;
  if (store.needsStage(id, 'crawl') && job.listing_text === null) {
    let text: string;
    try {
      text = await scrape(job.url, { signal });
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

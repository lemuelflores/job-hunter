import type { ReviewQueues } from '../bullmq.js';
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
    if (!(error instanceof PageError) || error.retryable) throw error;
    signal?.throwIfAborted();
    store.terminalCrawl(id, error.message);
    return;
  }
  signal?.throwIfAborted();
  store.saveListingText(id, text);
}

export function startCrawlWorker(
  store: SqliteStore,
  queues: ReviewQueues,
  scrape?: ListingExtractor,
  signal?: AbortSignal,
) {
  return queues.startWorker(
    store,
    'crawl',
    async (id) => {
      await crawlJob(store, id, scrape, signal);
      // Redelivery repairs a save/enqueue interruption without extracting again.
      for (const evaluation of ['location', 'stack'] as const)
        if (store.needsStage(id, evaluation))
          await queues.enqueue(evaluation, id);
    },
    signal,
  );
}

import { resolve } from 'node:path';
import { loadProfile, ROOT } from '../infra/config.js';
import { ashby } from '../integrations/ats/ashby.js';
import { breezyhr } from '../integrations/ats/breezyhr.js';
import { greenhouse } from '../integrations/ats/greenhouse.js';
import { lever } from '../integrations/ats/lever.js';
import { polymer } from '../integrations/ats/polymer.js';
import { rippling } from '../integrations/ats/rippling.js';
import { smartrecruiters } from '../integrations/ats/smartrecruiters.js';
import { workable } from '../integrations/ats/workable.js';
import { scrapeListing } from '../integrations/firecrawl.js';
import { createChatgpt } from '../integrations/llm/chatgpt/index.js';
import type { LlmProvider } from '../integrations/llm/types.js';
import {
  type FreehireConfig,
  type FreehireSearchOptions,
  searchFreehireListings,
} from '../integrations/search/freehire.js';
import {
  type GoogleConfig,
  searchGoogleListings,
} from '../integrations/search/google.js';
import type { SearchListings } from '../integrations/search/types.js';
import type { CrawlExtractors } from '../workflow/crawl.js';
import type { CliDependencies } from './cli.js';

export const cliDependencies: CliDependencies = {
  loadProfile,
  createLlm,
  createStore: async () => {
    const { SqliteStore } = await import('../infra/sqlite.js');
    return new SqliteStore(resolve(ROOT, 'jobs.sqlite'));
  },
  createReviewQueues: async () => {
    const { ReviewQueues } = await import('../infra/bullmq.js');
    return new ReviewQueues();
  },
  createDiscoveryQueue: async (target) => {
    const { DiscoveryQueue } = await import('../infra/bullmq.js');
    return new DiscoveryQueue(target);
  },
  startDiscoveryScheduler: async (options) => {
    const { startDiscoveryScheduler } = await import('./scheduler.js');
    return startDiscoveryScheduler(options);
  },
  startGoogleWorker: async (store, queues, queue, profile, ats) => {
    const { startGoogleWorker } = await import('./workers.js');
    return startGoogleWorker(store, queues, queue, profile, ats);
  },
  startFreehireWorker: async (store, queues, queue, config) => {
    const { startFreehireWorker } = await import('./workers.js');
    return startFreehireWorker(store, queues, queue, config);
  },
  startCrawlWorker: async (store, queues) => {
    const { startCrawlWorker } = await import('./workers.js');
    return startCrawlWorker(store, queues);
  },
  startLocationWorker: async (store, queues, reviewLocation) => {
    const { startLocationWorker } = await import('./workers.js');
    return startLocationWorker(store, queues, reviewLocation);
  },
  startTechWorker: async (store, queues, reviewStack) => {
    const { startTechWorker } = await import('./workers.js');
    return startTechWorker(store, queues, reviewStack);
  },
};

export function createCrawlExtractors(): CrawlExtractors {
  return { ats: ATS_DEFINITIONS, fallback: scrapeListing };
}

export function createGoogleSearch(
  config: GoogleConfig,
  selector: GoogleAts,
): SearchListings {
  const ats = ATS_DEFINITIONS.find((ats) => ats.selector === selector);
  if (!ats) throw new Error(`Unknown ATS: ${selector}`);
  return () => searchGoogleListings(config, ats);
}

export function createFreehireSearch(
  config: FreehireConfig,
  options?: FreehireSearchOptions,
): SearchListings {
  return () => searchFreehireListings(config, normalizeFreehireUrl, options);
}

export const ATS_DEFINITIONS = [
  ashby,
  greenhouse,
  lever,
  workable,
  smartrecruiters,
  rippling,
  polymer,
  breezyhr,
] as const;
export type GoogleAts = (typeof ATS_DEFINITIONS)[number]['selector'];
export const GOOGLE_ATS: readonly GoogleAts[] = ATS_DEFINITIONS.map(
  (ats) => ats.selector,
);

export function normalizeJobUrl(raw: string): string | null {
  for (const ats of ATS_DEFINITIONS) {
    const normalized = ats.normalizeUrl(raw);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeFreehireUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;
  return normalizeJobUrl(raw) ?? raw;
}

let chatgpt: LlmProvider | undefined;

export function createLlm(
  provider = process.env.MODEL_PROVIDER ?? 'chatgpt',
): LlmProvider {
  if (provider !== 'chatgpt')
    throw new Error(`Model provider "${provider}" is not implemented`);
  chatgpt ??= createChatgpt();
  return chatgpt;
}

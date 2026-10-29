import { resolve } from 'node:path';
import { loadProfile, ROOT } from '../infra/config.ts';
import { ashby } from '../integrations/ats/ashby.ts';
import { bamboohr } from '../integrations/ats/bamboohr.ts';
import { breezyhr } from '../integrations/ats/breezyhr.ts';
import { freshteam } from '../integrations/ats/freshteam.ts';
import { greenhouse } from '../integrations/ats/greenhouse.ts';
import { himalayas } from '../integrations/ats/himalayas.ts';
import { lever } from '../integrations/ats/lever.ts';
import { pinpointhq } from '../integrations/ats/pinpointhq.ts';
import { polymer } from '../integrations/ats/polymer.ts';
import { rippling } from '../integrations/ats/rippling.ts';
import { smartrecruiters } from '../integrations/ats/smartrecruiters.ts';
import { workable } from '../integrations/ats/workable.ts';
import { scrapeListing } from '../integrations/firecrawl.ts';
import { createChatgpt } from '../integrations/llm/chatgpt/index.ts';
import type { LlmProvider } from '../integrations/llm/types.ts';
import {
  type FreehireConfig,
  type FreehireSearchOptions,
  searchFreehireListings,
} from '../integrations/search/freehire.ts';
import {
  type GoogleConfig,
  searchGoogleListings,
} from '../integrations/search/google.ts';
import type { SearchListings } from '../integrations/search/types.ts';
import type { CrawlExtractors } from '../workflow/crawl.ts';
import type { CliDependencies } from './cli.ts';

export const cliDependencies: CliDependencies = {
  loadProfile,
  createLlm,
  createCrawlExtractors,
  createStore: async () => {
    const { SqliteStore } = await import('../infra/sqlite.ts');
    return new SqliteStore(resolve(ROOT, 'jobs.sqlite'));
  },
  createReviewQueues: async () => {
    const { ReviewQueues } = await import('../infra/bullmq.ts');
    return new ReviewQueues();
  },
  createDiscoveryQueue: async (target) => {
    const { DiscoveryQueue } = await import('../infra/bullmq.ts');
    return new DiscoveryQueue(target);
  },
  startDiscoveryScheduler: async (options) => {
    const { startDiscoveryScheduler } = await import('./scheduler.ts');
    return startDiscoveryScheduler(options);
  },
  startGoogleWorker: async (store, queues, queue, profile, ats) => {
    const { startGoogleWorker } = await import('./workers.ts');
    return startGoogleWorker(store, queues, queue, profile, ats);
  },
  startFreehireWorker: async (store, queues, queue, config) => {
    const { startFreehireWorker } = await import('./workers.ts');
    return startFreehireWorker(store, queues, queue, config);
  },
  startCrawlWorker: async (store, queues) => {
    const { startCrawlWorker } = await import('./workers.ts');
    return startCrawlWorker(store, queues);
  },
  startAssessmentWorker: async (
    store,
    queues,
    loadDocuments,
    assess,
    signal,
  ) => {
    const { startAssessmentWorker } = await import('./workers.ts');
    return startAssessmentWorker(store, queues, loadDocuments, assess, signal);
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
  bamboohr,
  pinpointhq,
  freshteam,
  himalayas,
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

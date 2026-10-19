import timers from 'node:timers/promises';
import { runParallelGoogleSearchesDetailed } from './discovery/google.js';
import { buildQueryMatrix } from './discovery/queries.js';
import { PageError, scrapeListing } from './firecrawl.js';
import { llm } from './llm/index.js';
import type { LlmProvider } from './llm/types.js';
import {
  jobUrl,
  type Listing,
  type SqliteStore,
  STAGES,
  type Stage,
} from './persistence.js';
import { loadProfile, type Profile } from './profile.js';
import { JobQueues } from './queues.js';

export interface ReviewServices {
  reviewJob: LlmProvider['reviewJob'];
  reviewStack: LlmProvider['reviewStack'];
  scrapeListing: typeof scrapeListing;
}

export async function fetchJobs(
  store: SqliteStore,
  search = runParallelGoogleSearchesDetailed,
  profile?: Profile,
  schedule = async (ids: number[]) => {
    const queues = new JobQueues();
    try {
      for (const id of ids) await queues.scheduleListing(store, id);
    } finally {
      await queues.close();
    }
  },
) {
  const searched = await search(
    buildQueryMatrix(profile ?? (await loadProfile())).map(
      (spec) => spec.query,
    ),
    { concurrency: 5, num: 100 },
  );
  const added = store.saveResults(searched.results);
  const urls = new Set(searched.results.map((result) => jobUrl(result.url)));
  await schedule(
    store
      .unfinished()
      .filter((job) => urls.has(job.url))
      .map((job) => job.id),
  );
  return {
    added,
    pending: store.pendingCount(),
    failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
  };
}

async function crawlJob(
  store: SqliteStore,
  job: Listing,
  enqueue: (stage: Stage, id: number) => Promise<unknown>,
  services: ReviewServices,
  signal?: AbortSignal,
) {
  const id = job.id;
  if (store.needsStage(id, 'crawl') && job.listing_text === null) {
    let text: string;
    try {
      text = await services.scrapeListing(job.url, { signal });
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

export async function processStage(
  store: SqliteStore,
  stage: Stage,
  id: number,
  enqueue: (stage: Stage, id: number) => Promise<unknown>,
  services: ReviewServices = { ...llm, scrapeListing },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const job = store.getJob(id);
  if (job?.status !== 'active') return;
  if (stage === 'crawl') {
    return crawlJob(store, job, enqueue, services, signal);
  }
  if (!store.needsStage(id, stage) || job.listing_text === null) return;
  const options = { signal, listingText: job.listing_text };
  if (stage === 'location') {
    const decision = await services.reviewJob(job.url, options);
    signal?.throwIfAborted();
    store.review(
      id,
      decision.eligibility,
      decision.reason,
      decision.evidence,
      decision.company,
      decision.location,
      decision.title,
    );
  } else {
    const decision = await services.reviewStack(job.url, options);
    signal?.throwIfAborted();
    store.reviewStack(id, decision);
  }
}

async function reviewOutcome(
  store: SqliteStore,
  queues: JobQueues,
  id: number,
) {
  if (store.getJob(id)?.status !== 'active')
    return [`Job ${id}: no longer active`];
  await queues.syncFailures(store, id);
  const states = store.stages(id);
  const crawlFailed =
    store.getJob(id)?.listing_text === null &&
    states.some((s) => s.stage === 'crawl' && s.state === 'failed');
  if (states.some((s) => s.state === 'pending') && !crawlFailed) return null;
  return states
    .filter((s) => ['failed', 'terminal'].includes(s.state))
    .map((s) => `Job ${id} ${s.stage}: ${s.error}`);
}

export async function reviewJobs(
  store: SqliteStore,
  queues: JobQueues,
  limit?: number,
  signal?: AbortSignal,
) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('Invalid review limit');
  const jobs = store.unfinished(limit);
  for (const job of jobs) await queues.scheduleListing(store, job.id);
  const failures: string[] = [];
  let reviewed = 0;
  const waiting = new Set(jobs.map((job) => job.id));
  while (waiting.size) {
    signal?.throwIfAborted();
    for (const id of waiting) {
      const errors = await reviewOutcome(store, queues, id);
      if (errors === null) continue;
      failures.push(...errors);
      if (!errors.length) reviewed++;
      waiting.delete(id);
    }
    if (waiting.size) await timers.setTimeout(250, undefined, { signal });
  }
  return { reviewed, pending: store.pendingCount(), failures };
}

export async function workJobs(
  store: SqliteStore,
  queues: JobQueues,
  services: ReviewServices,
  signal: AbortSignal,
) {
  const workers = await queues.startWorkers(store, services);
  try {
    console.info(`[worker] Started ${STAGES.join(', ')} consumers`);
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    console.info('[worker] Stopped');
  }
}

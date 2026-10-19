import { Worker } from 'bullmq';
import type { JobQueues } from '../bullmq.js';
import { type SqliteStore, STAGES, type Stage } from '../sqlite.js';
import { crawlJob } from './crawl.js';
import { scrapeListing } from './firecrawl.js';
import { createLlm } from './llm/index.js';
import type { LlmProvider } from './llm/types.js';
import { checkLocation } from './location-check.js';
import { checkTech } from './tech-check.js';

export interface ReviewServices {
  reviewJob: LlmProvider['reviewJob'];
  reviewStack: LlmProvider['reviewStack'];
  scrapeListing: typeof scrapeListing;
}

export async function processStage(
  store: SqliteStore,
  stage: Stage,
  id: number,
  enqueue: (stage: Stage, id: number) => Promise<unknown>,
  services: ReviewServices = { ...createLlm(), scrapeListing },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const job = store.getJob(id);
  if (job?.status !== 'active') return;
  if (stage === 'crawl') {
    return crawlJob(store, job, enqueue, services.scrapeListing, signal);
  }
  if (stage === 'location') {
    return checkLocation(store, job, services.reviewJob, signal);
  }
  return checkTech(store, job, services.reviewStack, signal);
}

export async function startWorkers(
  store: SqliteStore,
  queues: JobQueues,
  services: ReviewServices,
  signal?: AbortSignal,
) {
  const workers: Worker[] = [];
  try {
    for (const stage of STAGES) {
      const queue = queues.queues[stage];
      await queue.setGlobalConcurrency(1);
      const worker = new Worker(
        stage,
        async (task) => {
          const id = task.data.id;
          if (!Number.isSafeInteger(id) || id < 1)
            throw new Error('Invalid listing ID');
          try {
            await processStage(
              store,
              stage,
              id,
              (s, key) => queues.enqueue(s, key),
              services,
              signal,
            );
          } catch (error) {
            store.failStage(
              id,
              stage,
              error instanceof Error ? error.message : String(error),
              task.attemptsMade + 1 >= (task.opts.attempts ?? 3),
            );
            throw error;
          }
        },
        {
          prefix: queues.prefix,
          connection: { url: queues.url },
          concurrency: 1,
        },
      );
      worker.on('error', (error) =>
        console.error(`[worker] ${stage}: ${error.message}`),
      );
      worker.on('failed', (task, error) => {
        console.error(
          `[worker] ${stage} listing ${task?.data.id}: ${error.message}`,
        );
        if (task)
          void queues
            .syncFailures(store, task.data.id)
            .catch((failure) =>
              console.error(
                `[worker] Cannot save queue failure: ${failure instanceof Error ? failure.message : String(failure)}`,
              ),
            );
      });
      workers.push(worker);
    }
    return workers;
  } catch (error) {
    await Promise.all(workers.map((worker) => worker.close()));
    throw error;
  }
}

export async function workJobs(
  store: SqliteStore,
  queues: JobQueues,
  services: ReviewServices,
  signal: AbortSignal,
) {
  const workers = await startWorkers(store, queues, services);
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

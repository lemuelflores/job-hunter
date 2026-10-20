import { Worker } from 'bullmq';
import type { JobQueues } from '../bullmq.js';
import {
  type Listing,
  type SqliteStore,
  STAGES,
  type Stage,
} from '../sqlite.js';
import { crawlJob } from './crawl.js';
import type { ListingExtractor } from './extraction.js';
import type { LlmProvider } from './llm/types.js';
import { checkLocation } from './location-check.js';
import { checkTech } from './tech-check.js';

export async function startWorkers(
  store: SqliteStore,
  queues: JobQueues,
  llm: Pick<LlmProvider, 'reviewJob' | 'reviewStack'>,
  scrapeListing?: ListingExtractor,
  signal?: AbortSignal,
) {
  const processors: Record<Stage, (job: Listing) => Promise<void>> = {
    crawl: (job) =>
      crawlJob(
        store,
        job,
        (stage, id) => queues.enqueue(stage, id),
        scrapeListing,
        signal,
      ),
    location: (job) => checkLocation(store, job, llm.reviewJob, signal),
    stack: (job) => checkTech(store, job, llm.reviewStack, signal),
  };
  const workers: Worker[] = [];
  try {
    for (const stage of STAGES) {
      const process = processors[stage];
      const queue = queues.queues[stage];
      await queue.setGlobalConcurrency(1);
      const worker = new Worker(
        stage,
        async (task) => {
          const id = task.data.id;
          if (!Number.isSafeInteger(id) || id < 1)
            throw new Error('Invalid listing ID');
          try {
            signal?.throwIfAborted();
            const job = store.getJob(id);
            if (job?.status !== 'active') return;
            await process(job);
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
  llm: Pick<LlmProvider, 'reviewJob' | 'reviewStack'>,
  signal: AbortSignal,
  scrapeListing?: ListingExtractor,
) {
  const workers = await startWorkers(store, queues, llm, scrapeListing);
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

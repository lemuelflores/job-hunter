import timers from 'node:timers/promises';
import type { JobQueues } from '../bullmq.js';
import type { SqliteStore } from '../sqlite.js';

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

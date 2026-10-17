import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import timers from 'node:timers/promises';
import { runParallelGoogleSearchesDetailed } from './discovery/google.js';
import { buildQueryMatrix } from './discovery/queries.js';
import { PageError } from './firecrawl.js';
import { AuthenticationError, llm, RateLimitError } from './llm/index.js';
import type { LlmProvider } from './llm/types.js';
import type { Listing, SqliteStore } from './persistence.js';
import { loadProfile, type Profile } from './profile.js';

export async function fetchJobs(
  store: SqliteStore,
  search = runParallelGoogleSearchesDetailed,
  profile?: Profile,
) {
  const searched = await search(
    buildQueryMatrix(profile ?? (await loadProfile())).map(
      (spec) => spec.query,
    ),
    { concurrency: 5, num: 100 },
  );
  return {
    added: store.saveResults(searched.results),
    pending: store.pendingCount(),
    failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
  };
}

function acquireReviewLock(root: string) {
  if (existsSync(join(root, '.run-lock')))
    throw new Error(
      'Another run may hold legacy .run-lock; verify it stopped before removing the directory',
    );
  // A separate database holds only the lock, so fetching and UI writes remain independent.
  const lock = new DatabaseSync(join(root, '.review-lock.sqlite'), {
    timeout: 0,
  });
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5)
      throw new Error(
        'Another run holds the review lock; stop it before starting review or worker',
      );
    throw error;
  }
  return lock;
}

function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Review interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    close() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

async function reviewListing(
  store: SqliteStore,
  job: Listing,
  batch: string,
  signal: AbortSignal,
  review: LlmProvider['reviewJob'],
) {
  signal.throwIfAborted();
  let decision: Awaited<ReturnType<LlmProvider['reviewJob']>>;
  try {
    decision = await review(job.url, { signal });
  } catch (error) {
    if (!(error instanceof PageError) || (error.retryable && job.attempts < 4))
      throw error;
    signal.throwIfAborted();
    store.review(job.id, batch, 'error', error.message);
    return;
  }
  signal.throwIfAborted();
  store.review(
    job.id,
    batch,
    decision.eligibility,
    decision.reason,
    decision.evidence,
    decision.company,
    decision.location,
    decision.title,
  );
}

export async function reviewJobs(
  root: string,
  store: SqliteStore,
  options: { limit?: number } = {},
  review = llm.reviewJob,
) {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1)
  )
    throw new Error('Invalid batch limit');
  const lock = acquireReviewLock(root);
  const shutdown = shutdownSignal();
  const batch = randomBytes(16).toString('hex');
  try {
    const jobs = store.claimBatch(batch, options.limit);
    const failures: string[] = [];
    for (const [index, job] of jobs.entries()) {
      console.error(`[review] ${index + 1} of ${jobs.length}: ${job.url}`);
      try {
        await reviewListing(store, job, batch, shutdown.signal, review);
      } catch (error) {
        failures.push(
          `Job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    const remaining = store.pendingCount(batch);
    if (remaining)
      failures.push(
        `${remaining} assigned job(s) remain pending; retry next run`,
      );
    return {
      reviewed: jobs.length - remaining,
      pending: store.pendingCount(),
      failures,
    };
  } finally {
    shutdown.close();
    try {
      store.finishBatch(batch);
    } finally {
      lock.close();
    }
  }
}

export async function workJobs(
  root: string,
  store: SqliteStore,
  review = llm.reviewJob,
) {
  const lock = acquireReviewLock(root);
  const shutdown = shutdownSignal();
  const batch = randomBytes(16).toString('hex');
  const wait = async (ms: number) => {
    try {
      await timers.setTimeout(ms, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!shutdown.signal.aborted) throw error;
    }
  };
  try {
    console.error('[worker] Started; polling every 30 seconds');
    while (!shutdown.signal.aborted) {
      const [job] = store.claimBatch(batch, 1, true);
      if (!job) {
        await wait(30_000);
        continue;
      }
      let cooldown = false;
      try {
        console.error(`[worker] Reviewing job ${job.id}: ${job.url}`);
        await reviewListing(store, job, batch, shutdown.signal, review);
        console.error(`[worker] Saved job ${job.id}`);
      } catch (error) {
        if (shutdown.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof AuthenticationError) {
          cooldown = true;
          console.error(
            `[worker] Authentication paused: ${message}; checking again in 60 seconds`,
          );
        } else {
          store.failReview(job.id, batch, message);
          cooldown = error instanceof RateLimitError;
          console.error(
            `[worker] Job ${job.id} failed (${job.attempts + 1}/5): ${message}`,
          );
        }
      } finally {
        store.finishBatch(batch);
      }
      if (cooldown) await wait(60_000);
    }
  } finally {
    shutdown.close();
    try {
      store.finishBatch(batch);
    } finally {
      lock.close();
    }
    console.error('[worker] Stopped');
  }
}

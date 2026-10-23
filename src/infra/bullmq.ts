import { createNodeRedisClient, Queue, RedisConnection, Worker } from 'bullmq';
import { createClient } from 'redis';
import { STAGES, type Stage } from '../core/stages.ts';
import type { GoogleAts } from '../entrypoints/compose.ts';
import {
  type DiscoveryDeliveryResult,
  DiscoveryPartialFailure,
} from '../workflow/discover.ts';
import { enqueueMissingStages } from '../workflow/enqueue.ts';
import type { SqliteStore } from './sqlite.ts';
import {
  deliveryEvent,
  diagnosticError,
  safeUrl,
} from './worker-diagnostics.ts';

RedisConnection.clientFactory = (options) => {
  const producer = options.enableOfflineQueue === false;
  let connected = false;
  const client = createClient({
    url: options.url,
    disableOfflineQueue: producer,
    socket: {
      connectTimeout: 5000,
    },
  });
  client.on('ready', () => {
    connected = true;
  });
  const connection = createNodeRedisClient(client);
  if (producer)
    client.once('error', () => {
      // End failed startup so BullMQ's readiness wait rejects instead of hanging.
      if (!connected) connection.disconnect();
    });
  return connection;
};

export type DiscoverySource = 'google' | 'freehire';
export type DiscoveryTarget = GoogleAts | 'freehire';

function stageState(store: SqliteStore, id: number, stage: Stage) {
  if (!Number.isSafeInteger(id) || id < 1) return 'missing';
  return store.stages(id).find((s) => s.stage === stage)?.state ?? 'missing';
}

function reviewOutcome(before: string, after: string) {
  if (after === before) return 'skipped';
  if (after === 'terminal') return 'terminal_crawl';
  if (after === 'complete') return 'checkpoint_saved';
  return 'skipped';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listingIdentity(store: SqliteStore, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) return {};
  const listing = store.deliveryListing(id);
  return { listing_id: id, ...(listing ? { url: safeUrl(listing.url) } : {}) };
}

export class DiscoveryQueue {
  readonly queue: Queue;
  readonly source: DiscoverySource;
  readonly name: string;
  readonly target: DiscoveryTarget;
  readonly url: string;
  readonly prefix: string;

  constructor(
    target: DiscoveryTarget,
    url = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    prefix = 'job-hunter',
  ) {
    this.target = target;
    this.url = url;
    this.prefix = prefix;
    this.source = target === 'freehire' ? 'freehire' : 'google';
    this.name = target;
    this.queue = new Queue(this.name, {
      prefix,
      connection: { url, enableOfflineQueue: false },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 20,
      },
    });
    this.queue.on('error', (error) =>
      console.error(`[queue] ${this.name}: ${error.message}`),
    );
  }

  async enqueue() {
    return this.queue.add(this.name, {}, { deduplication: { id: this.name } });
  }

  async startWorker(
    discover: (() => Promise<void>) | (() => Promise<DiscoveryDeliveryResult>),
  ) {
    await this.queue.setGlobalConcurrency(1);
    const worker = new Worker(
      this.name,
      async (task) => {
        const identity = {
          source: this.source,
          worker: this.name,
          ...(this.source === 'google' ? { ats: this.target } : {}),
          delivery_id: task.id,
          attempt: task.attemptsMade + 1,
          attempt_limit: task.opts.attempts ?? 1,
        };
        const started = performance.now();
        deliveryEvent({ event: 'delivery_started', ...identity });
        try {
          const result = await discover();
          deliveryEvent({
            event: 'delivery_finished',
            ...identity,
            elapsed_ms: Math.round(performance.now() - started),
            outcome: 'discovery_complete',
            ...result,
          });
        } catch (error) {
          deliveryEvent({
            event: 'delivery_finished',
            ...identity,
            elapsed_ms: Math.round(performance.now() - started),
            outcome:
              error instanceof DiscoveryPartialFailure
                ? 'discovery_partial_failure'
                : 'discovery_failed',
            delivery_outcome:
              identity.attempt < identity.attempt_limit
                ? 'retrying'
                : 'exhausted',
            ...(error instanceof DiscoveryPartialFailure ? error.result : {}),
            error: diagnosticError(error),
          });
          throw error;
        }
      },
      {
        prefix: this.prefix,
        connection: { url: this.url },
        concurrency: 1,
        name: this.name,
      },
    );
    worker.on('error', (error) =>
      console.error(`[worker] ${this.name}: ${error.message}`),
    );
    return worker;
  }

  async close() {
    await this.queue.close();
  }
}

export class ReviewQueues {
  readonly queues: Record<Stage, Queue>;
  readonly url: string;
  readonly prefix: string;

  constructor(
    url = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    prefix = 'job-hunter',
  ) {
    this.url = url;
    this.prefix = prefix;
    this.queues = Object.fromEntries(
      STAGES.map((stage) => {
        const queue = new Queue(stage, {
          prefix,
          connection: { url, enableOfflineQueue: false },
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        });
        queue.on('error', (error) =>
          console.error(`[queue] ${stage}: ${error.message}`),
        );
        return [stage, queue];
      }),
    ) as Record<Stage, Queue>;
  }

  async startWorker(
    store: SqliteStore,
    stage: Stage,
    process: (id: number) => Promise<void>,
    signal?: AbortSignal,
  ) {
    await this.queues[stage].setGlobalConcurrency(1);
    const worker = new Worker(
      stage,
      async (task) => {
        const id = task.data.id;
        const valid = Number.isSafeInteger(id) && id > 0;
        const before = stageState(store, id, stage);
        const identity = {
          stage,
          delivery_id: task.id,
          attempt: task.attemptsMade + 1,
          attempt_limit: task.opts.attempts ?? 3,
          ...listingIdentity(store, id),
        };
        const started = performance.now();
        deliveryEvent({ event: 'delivery_started', ...identity });
        try {
          if (!valid) throw new Error('Invalid listing ID');
          signal?.throwIfAborted();
          await process(id);
          const after = stageState(store, id, stage);
          deliveryEvent({
            event: 'delivery_finished',
            ...identity,
            elapsed_ms: Math.round(performance.now() - started),
            outcome: reviewOutcome(before, after),
            stage_state: after,
          });
        } catch (error) {
          if (valid)
            store.failStage(
              id,
              stage,
              errorMessage(error),
              task.attemptsMade + 1 >= (task.opts.attempts ?? 3),
            );
          deliveryEvent({
            event: 'delivery_finished',
            ...identity,
            elapsed_ms: Math.round(performance.now() - started),
            outcome:
              identity.attempt < identity.attempt_limit
                ? 'retrying'
                : 'exhausted',
            stage_state: stageState(store, id, stage),
            error: diagnosticError(error),
          });
          throw error;
        }
      },
      {
        prefix: this.prefix,
        connection: { url: this.url },
        concurrency: 1,
      },
    );
    worker.on('error', (error) =>
      console.error(`[worker] ${stage}: ${error.message}`),
    );
    worker.on('failed', (task) => {
      if (task)
        void this.syncFailures(store, task.data.id).catch((failure) =>
          console.error(
            `[worker] Cannot save queue failure: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
        );
    });
    return worker;
  }

  async enqueue(stage: Stage, id: number) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error('Invalid listing ID');
    return this.queues[stage].add(stage, { id }, { jobId: `listing-${id}` });
  }

  async syncFailures(store: SqliteStore, id: number) {
    for (const { stage, generation } of store.stages(id)) {
      const task = await this.queues[stage].getJob(`listing-${id}`);
      if (task && (await task.getState()) === 'failed')
        store.failStage(
          id,
          stage,
          task.failedReason || 'Queue task failed',
          true,
          generation,
        );
    }
  }

  async scheduleListing(store: SqliteStore, id: number, only?: Stage) {
    await this.syncFailures(store, id);
    await enqueueMissingStages(
      store,
      id,
      async (stage, id) => {
        await this.enqueue(stage, id);
      },
      only,
    );
  }

  async repair(store: SqliteStore, only?: Stage) {
    const jobs = store.unfinished();
    for (const job of jobs) await this.scheduleListing(store, job.id, only);
    return jobs.length;
  }

  async retry(store: SqliteStore, stage: Stage, id: number) {
    await this.syncFailures(store, id);
    const job = store.getJob(id);
    if (job?.status !== 'active') throw new Error('Listing is not active');
    if (
      !store.stages(id).some((s) => s.stage === stage && s.state === 'failed')
    )
      throw new Error('Stage is not failed');
    const task = await this.queues[stage].getJob(`listing-${id}`);
    if (task && (await task.getState()) !== 'failed')
      throw new Error('Task is still queued or active');
    // Remove old delivery before reset; generation guards in-flight failure reads.
    if (task) await task.remove();
    store.resetStage(id, stage);
    // A failed enqueue leaves pending work that explicit repair can restore.
    await this.enqueue(stage, id);
  }

  async close() {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}

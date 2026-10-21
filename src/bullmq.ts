import { createNodeRedisClient, Queue, RedisConnection, Worker } from 'bullmq';
import { createClient } from 'redis';
import {
  type Listing,
  type SqliteStore,
  STAGES,
  type Stage,
} from './sqlite.js';

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

export class FetchQueue {
  readonly queue: Queue;

  constructor(
    readonly url = process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    readonly prefix = 'job-hunter',
  ) {
    this.queue = new Queue('fetch', {
      prefix,
      connection: { url, enableOfflineQueue: false },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 20,
      },
    });
    this.queue.on('error', (error) =>
      console.error(`[queue] fetch: ${error.message}`),
    );
  }

  async enqueue() {
    return this.queue.add('fetch', {}, { deduplication: { id: 'fetch' } });
  }

  async startWorker(fetch: () => Promise<void>) {
    await this.queue.setGlobalConcurrency(1);
    const worker = new Worker('fetch', fetch, {
      prefix: this.prefix,
      connection: { url: this.url },
      concurrency: 1,
    });
    worker.on('error', (error) =>
      console.error(`[worker] fetch: ${error.message}`),
    );
    worker.on('failed', (_task, error) =>
      console.error(`[worker] Fetch failed: ${error.message}`),
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
    process: (job: Listing) => Promise<void>,
    signal?: AbortSignal,
  ) {
    await this.queues[stage].setGlobalConcurrency(1);
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
        prefix: this.prefix,
        connection: { url: this.url },
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
    for (const stage of only ? [only] : STAGES)
      if (store.needsStage(id, stage)) await this.enqueue(stage, id);
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

import { createNodeRedisClient, Queue, RedisConnection, Worker } from 'bullmq';
import { createClient } from 'redis';
import { type SqliteStore, STAGES, type Stage } from './persistence.js';
import { processStage, type ReviewServices } from './runner.js';

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

export class JobQueues {
  readonly queues: Record<Stage, Queue>;
  private readonly url: string;
  private readonly prefix: string;

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

  async enqueue(stage: Stage, id: number) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error('Invalid listing ID');
    return this.queues[stage].add(stage, { id }, { jobId: `listing-${id}` });
  }

  async syncFailures(store: SqliteStore, id: number) {
    for (const stage of STAGES) {
      const task = await this.queues[stage].getJob(`listing-${id}`);
      if (task && (await task.getState()) === 'failed')
        store.failStage(
          id,
          stage,
          task.failedReason || 'Queue task failed',
          true,
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
    // Reset first: if enqueue fails, explicit repair can restore the missing task.
    store.resetStage(id, stage);
    if (task) {
      try {
        await task.retry('failed', {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
      } catch (error) {
        store.failStage(
          id,
          stage,
          error instanceof Error ? error.message : String(error),
          true,
        );
        throw error;
      }
    } else await this.enqueue(stage, id);
  }

  async startWorkers(
    store: SqliteStore,
    services: ReviewServices,
    signal?: AbortSignal,
  ) {
    const workers: Worker[] = [];
    try {
      for (const stage of STAGES) {
        await this.queues[stage].setGlobalConcurrency(1);
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
                (s, key) => this.enqueue(s, key),
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
        workers.push(worker);
      }
      return workers;
    } catch (error) {
      await Promise.all(workers.map((worker) => worker.close()));
      throw error;
    }
  }

  async close() {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}

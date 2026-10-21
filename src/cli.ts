#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Worker } from 'bullmq';
import {
  type ArgsDef,
  defineCommand,
  type EnumArgDef,
  renderUsage,
  runCommand,
} from 'citty';
import type { FetchQueue, ReviewQueues } from './bullmq.js';
import { loadProfile, type Profile } from './profile.js';
import { authenticate } from './review/auth.js';
import { createLlm } from './review/llm/index.js';
import type { LlmProvider } from './review/llm/types.js';
import { reviewJobs } from './review/review-jobs.js';
import { STAGES } from './review/stages.js';
import type { SqliteStore } from './sqlite.js';
import { serveReviewServer } from './web/server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const stageArg = {
  type: 'enum',
  options: [...STAGES],
  description: 'Processing stage',
} satisfies EnumArgDef;

function integer(value: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error(`Expected an integer between 1 and ${max}`);
  return n;
}

function validateArguments(argv: string[], args: ArgsDef = {}) {
  // Citty permits unknown flags and surplus positionals; keep CLI input strict.
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries(
      Object.entries(args).map(([name, arg]) => [
        name,
        { type: arg.type === 'boolean' ? 'boolean' : 'string' },
      ]),
    ),
    strict: true,
    allowPositionals: false,
  });
  for (const [name, arg] of Object.entries(args))
    if (arg.required && values[name] === undefined)
      throw new Error(`Missing required argument: --${name}`);
}

function loadEnvironment() {
  try {
    loadEnvFile(resolve(ROOT, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface CliDependencies {
  loadProfile(): Promise<Profile>;
  createLlm(): LlmProvider;
  createStore(): Promise<SqliteStore>;
  createReviewQueues(): Promise<ReviewQueues>;
  createFetchQueue(): Promise<FetchQueue>;
  startFetchScheduler(queue: FetchQueue): Promise<void>;
  startFetchWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    queue: FetchQueue,
    profile: Profile,
  ): Promise<Worker>;
  startCrawlWorker(store: SqliteStore, queues: ReviewQueues): Promise<Worker>;
  startLocationWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    reviewLocation: LlmProvider['reviewJob'],
  ): Promise<Worker>;
  startTechWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    reviewStack: LlmProvider['reviewStack'],
  ): Promise<Worker>;
}

const defaults: CliDependencies = {
  loadProfile,
  createLlm,
  createStore: async () => {
    const { SqliteStore } = await import('./sqlite.js');
    return new SqliteStore(resolve(ROOT, 'jobs.sqlite'));
  },
  createReviewQueues: async () => {
    const { ReviewQueues } = await import('./bullmq.js');
    return new ReviewQueues();
  },
  createFetchQueue: async () => {
    const { FetchQueue } = await import('./bullmq.js');
    return new FetchQueue();
  },
  startFetchScheduler: async (queue) => {
    const { startFetchScheduler } = await import('./discovery/scheduler.js');
    return startFetchScheduler(queue);
  },
  startFetchWorker: async (store, queues, queue, profile) => {
    const { startFetchWorker } = await import('./discovery/worker.js');
    return startFetchWorker(store, queues, queue, profile);
  },
  startCrawlWorker: async (store, queues) => {
    const { startCrawlWorker } = await import('./review/crawl.js');
    return startCrawlWorker(store, queues);
  },
  startLocationWorker: async (store, queues, reviewLocation) => {
    const { startLocationWorker } = await import('./review/location-check.js');
    return startLocationWorker(store, queues, reviewLocation);
  },
  startTechWorker: async (store, queues, reviewStack) => {
    const { startTechWorker } = await import('./review/tech-check.js');
    return startTechWorker(store, queues, reviewStack);
  },
};

export async function main(
  argv = process.argv.slice(2),
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...defaults, ...dependencies };
  let store: SqliteStore | undefined;
  let queues: ReviewQueues | undefined;
  let fetchQueue: FetchQueue | undefined;
  let exitCode = 0;
  const database = async () => {
    if (!store) {
      store = await deps.createStore();
    }
    return store;
  };
  const reviewQueues = async () => {
    if (!queues) {
      queues = await deps.createReviewQueues();
    }
    return queues;
  };
  const controller = new AbortController();
  const discoveryQueue = async () => {
    if (!fetchQueue) {
      fetchQueue = await deps.createFetchQueue();
    }
    return fetchQueue;
  };
  const stop = () => controller.abort(new Error('Processing interrupted'));
  const processingSignal = () => {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return controller.signal;
  };
  const report = (outcome: { failures: string[] }) => {
    console.log(JSON.stringify(outcome));
    exitCode = outcome.failures.length ? 1 : 0;
  };
  const subCommands = {
    auth: defineCommand({
      meta: { description: 'Sign in with your ChatGPT subscription' },
      run: () => authenticate(deps.createLlm()),
    }),
    jobs: defineCommand({
      meta: { description: 'Print saved active jobs as JSON' },
      run: async () =>
        console.log(
          JSON.stringify((await database()).listReviewJobs('active'), null, 2),
        ),
    }),
    fetch: defineCommand({
      meta: {
        description: 'Queue a discovery run (requires workers)',
      },
      run: async () => {
        const task = await (await discoveryQueue()).enqueue();
        console.log(JSON.stringify({ queued: task.id }));
      },
    }),
    scheduler: defineCommand({
      meta: { description: 'Queue fetching with FETCH_CRON (hourly, UTC)' },
      run: async () => {
        await deps.startFetchScheduler(await discoveryQueue());
      },
    }),
    review: defineCommand({
      meta: {
        description: 'Enqueue unfinished listings and wait (requires workers)',
      },
      args: {
        limit: { type: 'string', description: 'Maximum listings to review' },
      },
      run: async ({ args }) => {
        const limit =
          args.limit === undefined ? undefined : integer(args.limit);
        report(
          await reviewJobs(
            await database(),
            await reviewQueues(),
            limit,
            processingSignal(),
          ),
        );
      },
    }),
    workers: defineCommand({
      meta: { description: 'Run fetch, crawl, location and stack consumers' },
      run: async () => {
        const profile = await deps.loadProfile();
        const llm = deps.createLlm();
        const store = await database();
        const queues = await reviewQueues();
        const queue = await discoveryQueue();
        const signal = processingSignal();
        const workers: Worker[] = [];
        try {
          workers.push(
            await deps.startFetchWorker(store, queues, queue, profile),
          );
          workers.push(await deps.startCrawlWorker(store, queues));
          workers.push(
            await deps.startLocationWorker(store, queues, (url, options) =>
              llm.reviewJob(url, { ...options, location: profile.location }),
            ),
          );
          workers.push(
            await deps.startTechWorker(store, queues, (url, options) =>
              llm.reviewStack(url, { ...options, skills: profile.skills }),
            ),
          );
          console.info(
            `[workers] Started fetch, ${STAGES.join(', ')} consumers`,
          );
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
        } finally {
          await Promise.all(workers.map((worker) => worker.close()));
          console.info('[workers] Stopped');
        }
      },
    }),
    repair: defineCommand({
      meta: { description: 'Restore missing unfinished queue tasks' },
      args: { stage: stageArg },
      run: async ({ args }) => {
        const queues = await reviewQueues();
        console.log(
          JSON.stringify({
            listings: await queues.repair(await database(), args.stage),
          }),
        );
      },
    }),
    retry: defineCommand({
      meta: { description: 'Retry an exhausted stage' },
      args: {
        stage: { ...stageArg, required: true },
        id: { type: 'string', required: true, description: 'Listing ID' },
      },
      run: async ({ args }) => {
        const id = integer(args.id);
        const queues = await reviewQueues();
        await queues.retry(await database(), args.stage, id);
        console.log(JSON.stringify({ retried: id, stage: args.stage }));
      },
    }),
    'stack-backfill': defineCommand({
      meta: {
        description:
          'Queue missing historical stack checks, preserving location decisions',
      },
      run: async () => {
        const store = await database();
        const queued = store.queueStackBackfill();
        const queues = await reviewQueues();
        await queues.repair(store);
        console.log(JSON.stringify({ queued }));
      },
    }),
    serve: defineCommand({
      meta: { description: 'Open the local review UI (127.0.0.1 only)' },
      args: {
        port: { type: 'string', default: '3000', description: 'HTTP port' },
      },
      run: async ({ args }) => {
        const port = integer(args.port, 65535);
        return serveReviewServer(await database(), port);
      },
    }),
  };
  const command = defineCommand({
    meta: {
      name: 'job-hunter',
      description: 'Discover and review job listings',
    },
    subCommands,
  });
  try {
    const selected = Object.hasOwn(subCommands, argv[0] ?? '')
      ? subCommands[argv[0] as keyof typeof subCommands]
      : undefined;
    if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
      console.log(
        selected
          ? await renderUsage(
              {
                meta: { ...selected.meta, name: argv[0] },
                args: selected.args as ArgsDef,
              },
              command,
            )
          : await renderUsage(command),
      );
      return 0;
    }
    if (!selected) throw new Error(`Unknown command: ${argv[0]}`);
    validateArguments(argv.slice(1), selected.args as ArgsDef);
    loadEnvironment();
    await runCommand(command, { rawArgs: argv });
    return exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      await Promise.all([queues?.close(), fetchQueue?.close()]);
    } finally {
      store?.close();
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

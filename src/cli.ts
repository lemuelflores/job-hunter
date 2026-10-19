#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import timers from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JobQueues } from './bullmq.js';
import { fetchJobs } from './discovery/discover-jobs.js';
import { loadProfile } from './profile.js';
import { scrapeListing } from './review/firecrawl.js';
import type { ReviewServices } from './review/worker.js';
import { SqliteStore, STAGES, type Stage } from './sqlite.js';
import { listenReviewServer } from './web/server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Usage: node dist/cli.js <command>

fetch             Search Google and save new job URLs (no analysis)
auth              Sign in with your ChatGPT subscription in a browser
review [--limit N] Enqueue unfinished listings and wait (requires Redis and worker)
worker            Run independent crawl, location and stack consumers
repair [--stage crawl|location|stack] Restore missing unfinished queue tasks
retry --stage crawl|location|stack --id N  Retry an exhausted stage
stack-backfill    Queue stack checks for active, previously reviewed jobs (preserves location decisions)
fetch-worker      Schedule fetching with FETCH_CRON (default: hourly, UTC)
serve [--port 3000]  Open the local review UI (127.0.0.1 only)
jobs              Print saved active jobs as JSON

Database, .env and profile.ts resolve from the application directory, not the shell's cwd.
Google needs AUTOM_API_KEY. Processing needs Redis, Firecrawl and a saved ChatGPT OAuth login.
`;

function integer(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error(`Expected an integer between 1 and ${max}`);
  return n;
}

function parseCommand(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      limit: { type: 'string' },
      port: { type: 'string' },
      stage: { type: 'string' },
      id: { type: 'string' },
    },
  });
  const command = parsed.positionals[0];
  const v = parsed.values;
  if (v.help || !command) {
    console.log(HELP);
    return { exitCode: v.help ? 0 : 1 } as const;
  }
  if (
    parsed.positionals.length !== 1 ||
    ![
      'auth',
      'fetch',
      'fetch-worker',
      'serve',
      'jobs',
      'review',
      'worker',
      'stack-backfill',
      'repair',
      'retry',
    ].includes(command)
  )
    throw new Error(HELP);
  const allowed =
    (
      {
        review: ['limit'],
        serve: ['port'],
        repair: ['stage'],
        retry: ['stage', 'id'],
      } as Record<string, string[]>
    )[command] ?? [];
  if (Object.keys(v).some((key) => !allowed.includes(key)))
    throw new Error('Unexpected option for command');
  const limit =
    v.limit === undefined
      ? undefined
      : integer(v.limit, 0, Number.MAX_SAFE_INTEGER);
  if (v.stage !== undefined && !STAGES.includes(v.stage as Stage))
    throw new Error('Invalid stage');
  if (command === 'retry' && (!v.stage || !v.id))
    throw new Error('retry requires --stage and --id');
  const id = v.id === undefined ? 0 : integer(v.id, 0, Number.MAX_SAFE_INTEGER);
  return { command, v, limit, id };
}

async function authenticate() {
  const { createLlm } = await import('./review/llm/index.js');
  const llm = createLlm();
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Authentication interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await llm.authenticate({ signal: controller.signal });
    console.log('Signed in with ChatGPT.');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function loadEnvironment() {
  try {
    loadEnvFile(resolve(ROOT, '.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let store: SqliteStore | undefined;
  let queues: JobQueues | undefined;
  const jobQueues = () => (queues ??= new JobQueues());
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Processing interrupted'));
  try {
    const parsed = parseCommand(argv);
    if (parsed.exitCode !== undefined) return parsed.exitCode;
    const { command, v, limit, id } = parsed;
    loadEnvironment();
    if (command === 'auth') {
      await authenticate();
      return 0;
    }
    const profile = ['fetch', 'fetch-worker', 'worker'].includes(command)
      ? await loadProfile()
      : undefined;
    const { createLlm } = await import('./review/llm/index.js');
    const llm = createLlm();
    const review: ReviewServices = {
      scrapeListing,
      reviewJob: (url, options) =>
        llm.reviewJob(url, { ...options, location: profile?.location }),
      reviewStack: (url, options) =>
        llm.reviewStack(url, { ...options, skills: profile?.skills }),
    };
    store = new SqliteStore(resolve(ROOT, 'jobs.sqlite'));
    if (['review', 'worker'].includes(command)) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    switch (command) {
      case 'jobs':
        console.log(JSON.stringify(store.listReviewJobs('active'), null, 2));
        break;
      case 'stack-backfill': {
        const queued = store.queueStackBackfill();
        await jobQueues().repair(store);
        console.log(JSON.stringify({ queued }));
        break;
      }
      case 'repair': {
        console.log(
          JSON.stringify({
            listings: await jobQueues().repair(
              store,
              v.stage as Stage | undefined,
            ),
          }),
        );
        break;
      }
      case 'retry': {
        await jobQueues().retry(store, v.stage as Stage, id);
        console.log(JSON.stringify({ retried: id, stage: v.stage }));
        break;
      }
      case 'fetch-worker': {
        const { workFetch } = await import('./discovery/worker.js');
        const fetchStore = store;
        await workFetch(async () => {
          const outcome = await fetchJobs(fetchStore, undefined, profile);
          console.log(JSON.stringify(outcome));
          if (outcome.failures.length)
            throw new Error(outcome.failures.join('; '));
        });
        break;
      }
      case 'worker': {
        const { workJobs } = await import('./review/worker.js');
        await workJobs(store, jobQueues(), review, controller.signal);
        break;
      }
      case 'fetch':
      case 'review': {
        const outcome =
          command === 'fetch'
            ? await fetchJobs(store, undefined, profile)
            : await reviewJobs(store, jobQueues(), limit, controller.signal);
        console.log(JSON.stringify(outcome));
        return outcome.failures.length ? 1 : 0;
      }
      default: {
        const server = await listenReviewServer(
          store,
          integer(v.port, 3000, 65535),
          process.env.JOB_HUNTER_HOST || '127.0.0.1',
        );
        console.log(
          `Review UI: http://127.0.0.1:${(server.address() as { port: number }).port}`,
        );
        await new Promise<void>((done) => {
          let closing = false;
          const stop = () => {
            if (closing) return;
            closing = true;
            server.close(() => {
              process.off('SIGINT', stop);
              process.off('SIGTERM', stop);
              done();
            });
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await queues?.close();
    store?.close();
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

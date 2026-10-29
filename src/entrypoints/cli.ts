#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Worker } from 'bullmq';
import {
  type ArgsDef,
  type CommandDef,
  defineCommand,
  type EnumArgDef,
  renderUsage,
  runCommand,
} from 'citty';
import { STAGES } from '../core/stages.ts';
import type {
  DiscoveryQueue,
  DiscoveryTarget,
  ReviewQueues,
} from '../infra/bullmq.ts';
import { loadCandidateDocuments } from '../infra/candidate-documents.ts';
import { loadEnvironment, type Profile } from '../infra/config.ts';
import type { SqliteStore } from '../infra/sqlite.ts';
import { PageError } from '../integrations/extraction.ts';
import type {
  AssessmentReviewer,
  CandidateDocuments,
  LlmProvider,
} from '../integrations/llm/types.ts';
import type { FreehireConfig } from '../integrations/search/freehire.ts';
import { backfillAssessments } from '../workflow/backfill-assessments.ts';
import { type CrawlExtractors, extractListing } from '../workflow/crawl.ts';
import { reviewJobs } from '../workflow/review-jobs.ts';
import { cliDependencies, GOOGLE_ATS, type GoogleAts } from './compose.ts';
import type { DiscoverySchedules } from './scheduler.ts';

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
  const positionalArgs = Object.entries(args).filter(
    ([, arg]) => arg.type === 'positional',
  );
  const { values, positionals } = parseArgs({
    args: argv,
    options: Object.fromEntries(
      Object.entries(args)
        .filter(([, arg]) => arg.type !== 'positional')
        .map(([name, arg]) => [
          name,
          { type: arg.type === 'boolean' ? 'boolean' : 'string' },
        ]),
    ),
    strict: true,
    allowPositionals: positionalArgs.length > 0,
  });
  if (positionals.length > positionalArgs.length)
    throw new Error(
      `Unexpected argument: ${positionals[positionalArgs.length]}`,
    );
  for (const [index, [name, arg]] of positionalArgs.entries())
    if (arg.required && positionals[index] === undefined)
      throw new Error(`Missing required argument: ${name}`);
  for (const [name, arg] of Object.entries(args))
    if (arg.type !== 'positional' && arg.required && values[name] === undefined)
      throw new Error(`Missing required argument: --${name}`);
}

async function authenticate(llm: LlmProvider) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Authentication interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await llm.authenticate({
      signal: controller.signal,
      onAuthorize: (url) =>
        console.log(`Open this URL in your browser to sign in:\n${url}`),
    });
    console.log('Signed in with ChatGPT.');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

type CommandUsage = Pick<CommandDef, 'meta' | 'args' | 'subCommands'>;

function selectInvocation(
  argv: string[],
  commands: Record<string, CommandUsage>,
  sources: Record<string, CommandUsage>,
) {
  if (argv[0] !== 'fetch' || !argv[1] || argv[1].startsWith('-'))
    return {
      selected: Object.hasOwn(commands, argv[0] ?? '')
        ? commands[argv[0]]
        : undefined,
      offset: 1,
      name: argv[0],
    };
  if (!Object.hasOwn(sources, argv[1]))
    throw new Error(`Unknown discovery source: ${argv[1]}`);
  return { selected: sources[argv[1]], offset: 2, name: `fetch ${argv[1]}` };
}

export interface CliDependencies {
  loadProfile(): Promise<Profile>;
  createLlm(): LlmProvider;
  createCrawlExtractors(): CrawlExtractors;
  createStore(): Promise<SqliteStore>;
  createReviewQueues(): Promise<ReviewQueues>;
  createDiscoveryQueue(target: DiscoveryTarget): Promise<DiscoveryQueue>;
  startDiscoveryScheduler(options: DiscoverySchedules): Promise<void>;
  startGoogleWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    queue: DiscoveryQueue,
    profile: Profile,
    ats: GoogleAts,
  ): Promise<Worker>;
  startFreehireWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    queue: DiscoveryQueue,
    config: FreehireConfig,
  ): Promise<Worker>;
  startCrawlWorker(store: SqliteStore, queues: ReviewQueues): Promise<Worker>;
  startAssessmentWorker(
    store: SqliteStore,
    queues: ReviewQueues,
    loadDocuments: () => Promise<CandidateDocuments>,
    assess: AssessmentReviewer,
    signal?: AbortSignal,
  ): Promise<Worker>;
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...cliDependencies, ...dependencies };
  let store: SqliteStore | undefined;
  let queues: ReviewQueues | undefined;
  const discoveryQueues: Partial<Record<DiscoveryTarget, DiscoveryQueue>> = {};
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
  const discoveryQueue = async (source: DiscoveryTarget) => {
    const existing = discoveryQueues[source];
    if (existing) return existing;
    const queue = await deps.createDiscoveryQueue(source);
    discoveryQueues[source] = queue;
    return queue;
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
  const sourceCommands = {
    google: defineCommand({
      meta: {
        description:
          'Queue independent Google ATS searches (up to 100 results each)',
      },
      args: {
        ats: {
          type: 'enum',
          options: [...GOOGLE_ATS],
          description: 'ATS to search (default: all)',
        },
      },
      run: async ({ args }) => {
        const profile = await deps.loadProfile();
        if (!profile.google.enabled)
          throw new Error('google discovery is disabled in discovery.ts');
        const targets = args.ats ? [args.ats] : GOOGLE_ATS;
        const results = await Promise.allSettled(
          targets.map(async (ats) => {
            const task = await (await discoveryQueue(ats)).enqueue();
            console.log(
              JSON.stringify({ source: 'google', ats, queued: task.id }),
            );
          }),
        );
        const failures = results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [
                new Error(`${targets[index]} enqueue failed`, {
                  cause: result.reason,
                }),
              ]
            : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            failures
              .map((error) => `${error.message}: ${String(error.cause)}`)
              .join('; '),
          );
      },
    }),
    freehire: defineCommand({
      meta: { description: 'Queue freehire discovery (requires workers)' },
      run: async () => {
        const profile = await deps.loadProfile();
        if (!profile.freehire.enabled)
          throw new Error('freehire discovery is disabled in discovery.ts');
        const task = await (await discoveryQueue('freehire')).enqueue();
        console.log(JSON.stringify({ source: 'freehire', queued: task.id }));
      },
    }),
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
    'check-url': defineCommand({
      meta: {
        description: 'Check one saved listing URL and hide it if missing',
      },
      args: {
        url: {
          type: 'positional',
          required: true,
          description: 'Exact saved listing URL',
        },
      },
      run: async ({ args }) => {
        let url: URL;
        try {
          url = new URL(args.url);
        } catch {
          throw new Error('Invalid listing URL');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error(
            'Listing URL must be HTTP or HTTPS without credentials',
          );
        const store = await database();
        if (!store.hasListingUrl(args.url))
          throw new Error('Listing URL not found');
        let status = 200;
        try {
          await extractListing(args.url, deps.createCrawlExtractors());
        } catch (error) {
          if (
            !(error instanceof PageError) ||
            ![404, 410].includes(error.status)
          )
            throw error;
          status = error.status;
        }
        console.log(
          JSON.stringify({
            url: args.url,
            status,
            stale: status !== 200 && store.staleActiveListingUrl(args.url),
          }),
        );
      },
    }),
    fetch: defineCommand({
      meta: { description: 'Queue source-specific discovery' },
      subCommands: sourceCommands,
    }),
    scheduler: defineCommand({
      meta: {
        description: 'Schedule enabled Google and Freehire discovery (UTC)',
      },
      run: async () => {
        const profile = await deps.loadProfile();
        const google: DiscoveryQueue[] = [];
        if (profile.google.enabled)
          for (const ats of GOOGLE_ATS) google.push(await discoveryQueue(ats));
        await deps.startDiscoveryScheduler({
          google: profile.google.enabled ? google : undefined,
          freehire: profile.freehire.enabled
            ? await discoveryQueue('freehire')
            : undefined,
        });
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
        const store = await database();
        const queues = await reviewQueues();
        report(
          await reviewJobs(
            store,
            async (stage, id) => {
              await queues.enqueue(stage, id);
            },
            (id) => queues.syncFailures(store, id),
            limit,
            processingSignal(),
          ),
        );
      },
    }),
    workers: defineCommand({
      meta: {
        description:
          'Run discovery, crawl, assessment and stale-check consumers',
      },
      run: async () => {
        const profile = await deps.loadProfile();
        const llm = deps.createLlm();
        const store = await database();
        const queues = await reviewQueues();
        const signal = processingSignal();
        const workers: Worker[] = [];
        try {
          if (profile.google.enabled)
            for (const ats of GOOGLE_ATS)
              workers.push(
                await deps.startGoogleWorker(
                  store,
                  queues,
                  await discoveryQueue(ats),
                  profile,
                  ats,
                ),
              );
          if (profile.freehire.enabled)
            workers.push(
              await deps.startFreehireWorker(
                store,
                queues,
                await discoveryQueue('freehire'),
                profile.freehire,
              ),
            );
          workers.push(await deps.startCrawlWorker(store, queues));
          workers.push(
            await deps.startAssessmentWorker(
              store,
              queues,
              loadCandidateDocuments,
              llm.assess,
            ),
          );
          workers.push(
            await queues.startStaleWorker(store, deps.createCrawlExtractors()),
          );
          console.info(
            `[workers] Started ${Object.keys(discoveryQueues).join(', ')} discovery; ${STAGES.join(', ')}, stale-check consumers`,
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
    backfill: defineCommand({
      meta: {
        description:
          'Preview or queue a bounded historical assessment backfill',
      },
      args: {
        limit: {
          type: 'string',
          description: 'Maximum listings to queue',
        },
        id: { type: 'string', description: 'Specific listing ID to queue' },
        preview: {
          type: 'boolean',
          description: 'Preview without queuing assessments',
        },
      },
      run: async ({ args }) => {
        if ((args.limit === undefined) === (args.id === undefined))
          throw new Error('Provide exactly one of --limit or --id');
        const id = args.id === undefined ? undefined : integer(args.id);
        const limit = args.limit === undefined ? 1 : integer(args.limit);
        const store = await database();
        if (args.preview) {
          console.log(
            JSON.stringify({
              mode: 'preview',
              ...store.previewAssessmentBackfill(limit, id),
            }),
          );
          return;
        }
        const queues = await reviewQueues();
        const queued = await backfillAssessments(
          store,
          limit,
          async (stage, id) => {
            await queues.enqueue(stage, id);
          },
          id,
        );
        console.log(JSON.stringify({ mode: 'run', queued }));
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
    const { selected, offset, name } = selectInvocation(
      argv,
      subCommands,
      sourceCommands,
    );
    if (
      !argv.length ||
      argv.includes('--help') ||
      argv.includes('-h') ||
      (argv.length === 1 && argv[0] === 'fetch')
    ) {
      console.log(
        selected
          ? await renderUsage(
              {
                meta: { ...selected.meta, name },
                args: selected.args as ArgsDef,
                subCommands: selected.subCommands,
              },
              command,
            )
          : await renderUsage(command),
      );
      return 0;
    }
    if (!selected) throw new Error(`Unknown command: ${argv[0]}`);
    validateArguments(argv.slice(offset), selected.args as ArgsDef);
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
      await Promise.all([
        queues?.close(),
        ...Object.values(discoveryQueues).map((queue) => queue.close()),
      ]);
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

#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SqliteStore } from './persistence.js';
import { loadProfile } from './profile.js';
import { listenReviewServer } from './web.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Usage: node dist/cli.js <command>

fetch             Search Google and save new job URLs (no analysis)
auth              Sign in with your ChatGPT subscription in a browser
review [--limit N] Scrape pending jobs with Firecrawl, then analyze through ChatGPT OAuth
worker            Continuously review new jobs with persistent retries
fetch-worker      Schedule fetching with FETCH_CRON (default: hourly, UTC)
serve [--port 3000]  Open the local review UI (127.0.0.1 only)
jobs              Print saved active jobs as JSON

Database, .env and profile.ts resolve from the application directory, not the shell's cwd.
Google needs AUTOM_API_KEY. Review needs Firecrawl and a saved ChatGPT OAuth login.
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let store: SqliteStore | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        limit: { type: 'string' },
        port: { type: 'string' },
      },
    });
    const command = parsed.positionals[0];
    const v = parsed.values;
    if (v.help || !command) {
      console.log(HELP);
      return v.help ? 0 : 1;
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
      ].includes(command)
    )
      throw new Error(HELP);
    const allowed =
      command === 'review' ? ['limit'] : command === 'serve' ? ['port'] : [];
    if (Object.keys(v).some((key) => !allowed.includes(key)))
      throw new Error('Unexpected option for command');
    try {
      loadEnvFile(resolve(ROOT, '.env'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (command === 'auth') {
      const { llm } = await import('./llm/index.js');
      const controller = new AbortController();
      const stop = () =>
        controller.abort(new Error('Authentication interrupted'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await llm.authenticate({ signal: controller.signal });
        console.log('Signed in with ChatGPT.');
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      return 0;
    }
    const profile = ['fetch', 'fetch-worker', 'review', 'worker'].includes(
      command,
    )
      ? await loadProfile()
      : undefined;
    const { llm } = await import('./llm/index.js');
    const review: typeof llm.reviewJob = (url, options) =>
      llm.reviewJob(url, { ...options, location: profile?.location });
    store = new SqliteStore(resolve(ROOT, 'jobs.sqlite'));
    if (command === 'jobs')
      console.log(JSON.stringify(store.listReviewJobs('active'), null, 2));
    else if (command === 'fetch-worker') {
      const { workFetch } = await import('./fetch-worker.js');
      const { fetchJobs } = await import('./runner.js');
      const fetchStore = store;
      await workFetch(async () => {
        const outcome = await fetchJobs(fetchStore, undefined, profile);
        console.log(JSON.stringify(outcome));
        if (outcome.failures.length)
          throw new Error(outcome.failures.join('; '));
      });
    } else if (command === 'worker') {
      const { workJobs } = await import('./runner.js');
      await workJobs(ROOT, store, review);
    } else if (command === 'fetch' || command === 'review') {
      const { fetchJobs, reviewJobs } = await import('./runner.js');
      const outcome =
        command === 'fetch'
          ? await fetchJobs(store, undefined, profile)
          : await reviewJobs(
              ROOT,
              store,
              {
                limit:
                  v.limit === undefined
                    ? undefined
                    : integer(v.limit, 0, Number.MAX_SAFE_INTEGER),
              },
              review,
            );
      console.log(JSON.stringify(outcome));
      return outcome.failures.length ? 1 : 0;
    } else {
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
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store?.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

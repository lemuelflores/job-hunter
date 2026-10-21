import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../dist/cli.js';
import { createLlm } from '../dist/review/llm/index.js';
import { SqliteStore } from '../dist/sqlite.js';

// Shared Arrange: copy the application so path and broken-installation checks stay isolated.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
  await cp(resolve('package.json'), join(root, 'package.json'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await cp(resolve('profile.ts'), join(root, 'profile.ts'));
  const cli = (...args) =>
    spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
  return { root, cli };
}

test('jobs reads the app-local database from another cwd without initializing a model', async (t) => {
  // Arrange: seed the copied application's database and close it before invoking the CLI.
  const { root, cli } = await fixture(t);
  const store = new SqliteStore(join(root, 'jobs.sqlite'));
  store.saveResults(
    [1, 2].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: `Engineer ${id}`,
      query: 'remote',
    })),
  );
  const expected = JSON.parse(JSON.stringify(store.listReviewJobs('active')));
  store.close();
  // Act: list jobs from an unrelated working directory.
  const saved = cli('jobs');
  // Assert: read the application's own saved listings.
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), expected);
  // Act: list jobs with an unsupported provider configured.
  const withoutModel = spawnSync(
    process.execPath,
    [join(root, 'dist/cli.js'), 'jobs'],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, MODEL_PROVIDER: 'unsupported' },
    },
  );
  // Assert: listing jobs does not initialize the provider.
  assert.equal(withoutModel.status, 0, withoutModel.stderr);
  assert.deepEqual(JSON.parse(withoutModel.stdout), expected);
});

test('CLI rejects unknown commands, unsupported options and invalid arguments', async (t) => {
  // Arrange: pair invalid invocations with their expected diagnostics.
  const { cli } = await fixture(t);
  for (const [args, error] of [
    [['review', '--db', '/tmp/arbitrary.sqlite'], /Unknown option.*--db/],
    [['review', '--status', 'rejected'], /Unknown option.*--status/],
    [['review', '--limit', '0'], /Expected an integer/],
    [['fetch', '--limit', '1'], /Unknown option.*--limit/],
    [['unknown'], /Unknown command: unknown/],
    [['worker'], /Unknown command: worker/],
    [['toString'], /Unknown command: toString/],
    [['jobs', 'extra'], /Unexpected argument/],
    [['jobs', '--unexpected'], /Unknown option.*--unexpected/],
    [['review', '--limit'], /--limit.*argument/],
    [['review', '--limit', '1.5'], /Expected an integer/],
    [['review', '--limit', '9007199254740992'], /Expected an integer/],
    [['serve', '--port', '65536'], /Expected an integer/],
    [['serve', '--port', '0'], /Expected an integer/],
    [['retry'], /Missing required argument: --stage/],
    [['retry', '--id', '1'], /Missing required argument: --stage/],
    [['retry', '--stage', 'stack'], /Missing required argument: --id/],
    [['retry', '--stage', 'stack', '--id', '0'], /Expected an integer/],
    [['repair', '--stage', 'invalid'], /Invalid.*stage/],
    [['repair', '--id', '1'], /Unknown option.*--id/],
  ]) {
    // Act: run this invalid command-line case.
    const invalid = cli(...args);
    // Assert: fail with the corresponding validation error.
    assert.equal(invalid.status, 1, args.join(' '));
    assert.match(invalid.stderr, error, args.join(' '));
  }
});

test('CLI prints global and command help including required retry options', async (t) => {
  // Arrange: use an isolated application for all help invocations.
  const { cli } = await fixture(t);
  // Act / Assert: accept global help and an invocation without a command.
  assert.equal(cli('--help').status, 0);
  assert.equal(cli().status, 0);
  for (const command of [
    'review',
    'review-worker',
    'fetch-worker',
    'fetch-scheduler',
    'retry',
    'serve',
  ]) {
    // Act: request this command's help page.
    const help = cli(command, '--help');
    // Assert: print command-specific usage without an error.
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`job-hunter ${command}`));
  }
  // Act / Assert: show required options with both help spellings.
  assert.match(cli('retry', '--help').stdout, /--stage/);
  assert.match(cli('retry', '-h').stdout, /--id/);
});

test('CLI loads profiles only for commands that need them', async (t) => {
  // Arrange: break the copied profile's syntax.
  const { root, cli } = await fixture(t);
  await writeFile(join(root, 'profile.ts'), 'export default {broken');
  for (const command of ['fetch-worker', 'review-worker']) {
    // Act: invoke a command that requires the profile.
    const invalid = cli(command);
    // Assert: report the profile failure instead of starting work.
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Cannot load profile.ts/);
  }
  // Act / Assert: listing and help do not need a valid profile.
  assert.equal(cli('jobs').status, 0);
  assert.equal(cli('--help').status, 0);
  // Arrange: remove the profile entirely.
  await rm(join(root, 'profile.ts'));
  // Act: invoke discovery with the missing profile.
  const missing = cli('fetch-worker');
  // Assert: identify the missing profile in the diagnostic.
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot load profile.ts.*profile.ts/);
});

test('fetch and fetch-scheduler only enqueue, without loading profile or database', async (t) => {
  const { root, cli } = await fixture(t);
  await rm(join(root, 'profile.ts'));
  await rm(join(root, 'dist/sqlite.js'));
  await rm(join(root, 'dist/discovery/discover-jobs.js'));
  await writeFile(
    join(root, 'dist/bullmq.js'),
    `export class FetchQueue {
      async enqueue() { console.log('enqueued'); return { id: '42' }; }
      async close() { console.log('queue closed'); }
    }`,
  );
  const manual = cli('fetch');
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /enqueued\n\{"queued":"42"\}\nqueue closed/);
  await writeFile(
    join(root, 'dist/discovery/worker.js'),
    `export async function scheduleFetch(enqueue) { await enqueue(); }`,
  );
  const scheduled = cli('fetch-scheduler');
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.match(scheduled.stdout, /enqueued\nqueue closed/);
});

test('fetch-worker runs discovery and drains before closing queues', async (t) => {
  const { root, cli } = await fixture(t);
  await writeFile(
    join(root, 'dist/bullmq.js'),
    `export class JobQueues {
      async scheduleListing(_store, id) { console.log('review ' + id); }
      async close() { console.log('reviews closed'); }
    }
    export class FetchQueue {
      async startWorker(fetch) {
        const active = fetch();
        setImmediate(() => process.emit('SIGTERM'));
        return { async close() { await active; console.log('worker drained'); } };
      }
      async close() { console.log('fetch queue closed'); }
    }`,
  );
  await writeFile(
    join(root, 'dist/discovery/discover-jobs.js'),
    `export async function fetchJobs(store, _search, profile, schedule) {
      if (!store || !profile) throw new Error('missing dependency');
      await new Promise(resolve => setTimeout(resolve, 30));
      await schedule([42]);
      return { added: 1, pending: 1, failures: [] };
    }`,
  );
  const stopped = cli('fetch-worker');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /review 42/);
  assert.match(stopped.stdout, /"added":1/);
  for (const closed of ['reviews closed', 'fetch queue closed'])
    assert.ok(
      stopped.stdout.indexOf('worker drained') < stopped.stdout.indexOf(closed),
    );
  await writeFile(
    join(root, 'dist/bullmq.js'),
    `export class JobQueues { async close() { console.log('reviews closed'); } }
    export class FetchQueue {
      async startWorker() { throw new Error('startup failed'); }
      async close() { console.log('fetch queue closed'); }
    }`,
  );
  const failed = cli('fetch-worker');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /startup failed/);
  assert.match(failed.stdout, /reviews closed/);
  assert.match(failed.stdout, /fetch queue closed/);
});

test('CLI help works without the database implementation installed', async (t) => {
  // Arrange: remove the copied database module.
  const { root, cli } = await fixture(t);
  await rm(join(root, 'dist/sqlite.js'));
  for (const args of [[], ['--help'], ['review', '--help'], ['retry', '-h']]) {
    // Act: request global or command-specific usage.
    const help = cli(...args);
    // Assert: print usage without loading the unavailable database module.
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /USAGE/);
  }
});

test('CLI auth routes through the provider and removes signal listeners on success or failure', async (t) => {
  // Arrange: stub provider authentication and capture original signal-listener counts.
  const llm = createLlm();
  let calls = 0;
  const before = ['SIGINT', 'SIGTERM'].map((event) =>
    process.listenerCount(event),
  );
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(llm, 'authenticate', async (options) => {
    calls++;
    // Assert: auth receives a cancellation signal from the CLI.
    assert.ok(options.signal instanceof AbortSignal);
  });
  // Act / Assert: successful authentication restores listeners.
  assert.equal(await main(['auth']), 0);
  assert.equal(calls, 1);
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
    before,
  );
  // Arrange: make the provider reject login.
  llm.authenticate = async () => {
    throw new Error('denied');
  };
  // Act / Assert: failed authentication also restores listeners and rejects invalid options.
  assert.equal(await main(['auth']), 1);
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
    before,
  );
  assert.equal(await main(['auth', '--limit', '1']), 1);
});

test('review-worker closes started consumers before queues on shutdown and startup failure', async (t) => {
  const { root, cli } = await fixture(t);
  await writeFile(
    join(root, 'dist/bullmq.js'),
    `export class JobQueues {
      async close() { console.log('queues closed'); }
    }`,
  );
  for (const [file, name] of [
    ['crawl', 'startCrawlWorker'],
    ['location-check', 'startLocationWorker'],
    ['tech-check', 'startTechWorker'],
  ]) {
    await writeFile(
      join(root, `dist/review/${file}.js`),
      `export async function ${name}() {
        console.log('${file} started');
        ${file === 'tech-check' ? "setImmediate(() => process.emit('SIGTERM'));" : ''}
        return { async close() {
          await new Promise(resolve => setTimeout(resolve, 10));
          console.log('${file} closed');
        } };
      }`,
    );
  }
  const stopped = cli('review-worker');
  assert.equal(stopped.status, 0, stopped.stderr);
  for (const file of ['crawl', 'location-check', 'tech-check']) {
    assert.match(stopped.stdout, new RegExp(`${file} started`));
    assert.match(stopped.stdout, new RegExp(`${file} closed`));
    assert.ok(
      stopped.stdout.indexOf(`${file} closed`) <
        stopped.stdout.indexOf('queues closed'),
    );
  }
  assert.match(stopped.stdout, /\[worker\] Stopped/);

  await writeFile(
    join(root, 'dist/review/location-check.js'),
    `export async function startLocationWorker() { throw new Error('startup failed'); }`,
  );
  const failed = cli('review-worker');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /startup failed/);
  assert.match(failed.stdout, /crawl closed[\s\S]*queues closed/);
  assert.doesNotMatch(failed.stdout, /tech-check started/);
});

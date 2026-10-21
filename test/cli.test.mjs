import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../dist/cli.js';
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
    [['fetch-worker'], /Unknown command: fetch-worker/],
    [['review-worker'], /Unknown command: review-worker/],
    [['fetch-scheduler'], /Unknown command: fetch-scheduler/],
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
  for (const command of ['review', 'workers', 'scheduler', 'retry', 'serve']) {
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
  // Act: invoke workers, which requires the profile.
  const invalid = cli('workers');
  // Assert: report the profile failure instead of starting work.
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Cannot load profile.ts/);
  // Act / Assert: listing and help do not need a valid profile.
  assert.equal(cli('jobs').status, 0);
  assert.equal(cli('--help').status, 0);
  // Arrange: remove the profile entirely.
  await rm(join(root, 'profile.ts'));
  // Act: invoke discovery with the missing profile.
  const missing = cli('workers');
  // Assert: identify the missing profile in the diagnostic.
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot load profile.ts.*profile.ts/);
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

test('non-web commands work without the UI asset', async (t) => {
  const { root, cli } = await fixture(t);
  await rm(join(root, 'dist/web/index.html'));
  for (const args of [[], ['--help'], ['serve', '--help'], ['jobs']]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
  }
  const result = cli('serve');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT.*index.html/);
});

test('queue module imports without loading SQLite or connecting to Redis', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'node:sqlite' || specifier.endsWith('/sqlite.js'))
        throw new Error('SQLite loading denied');
      return nextResolve(specifier, context);
    }});
    await import(${JSON.stringify(new URL('../dist/bullmq.js', import.meta.url).href)});
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('CLI auth routes through the provider and removes signal listeners on success or failure', async (t) => {
  // Arrange: stub provider authentication and capture original signal-listener counts.
  const llm = { authenticate: async () => {} };
  const dependencies = { createLlm: () => llm };
  let calls = 0;
  const before = ['SIGINT', 'SIGTERM'].map((event) =>
    process.listenerCount(event),
  );
  const output = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(llm, 'authenticate', async (options) => {
    calls++;
    // Assert: auth receives a cancellation signal from the CLI.
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(typeof options.onAuthorize, 'function');
    options.onAuthorize('https://auth.example/authorize');
  });
  // Act / Assert: successful authentication restores listeners.
  assert.equal(await main(['auth'], dependencies), 0);
  assert.equal(calls, 1);
  assert.deepEqual(
    output.mock.calls.map((call) => call.arguments[0]),
    [
      'Open this URL in your browser to sign in:\nhttps://auth.example/authorize',
      'Signed in with ChatGPT.',
    ],
  );
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
    before,
  );
  // Arrange: make the provider reject login.
  llm.authenticate = async () => {
    throw new Error('denied');
  };
  // Act / Assert: failed authentication also restores listeners and rejects invalid options.
  assert.equal(await main(['auth'], dependencies), 1);
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
    before,
  );
  assert.equal(await main(['auth', '--limit', '1'], dependencies), 1);
});

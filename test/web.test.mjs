import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { SqliteStore } from '../dist/sqlite.js';
import {
  listenReviewServer,
  serveReviewServer,
  UI_HTML,
} from '../dist/web/server.js';

// Evaluate only the production's pure assessment functions, without a DOM or fetch.
const { stackLabel, matchesAssessments } = runInNewContext(
  `${UI_HTML.match(/<script id="assessment-logic">([\s\S]*?)<\/script>/)[1]}
  ({ stackLabel, matchesAssessments });`,
);

test('UI labels every stack state and distinguishes skipped assessments', () => {
  // Arrange: pair each assessment state with its user-facing label.
  const labels = {
    not_checked: 'Not checked',
    pending: 'pending',
    match: 'match',
    partial_match: 'partial match',
    potential_match: 'potential match',
    unclear: 'unclear',
    error: 'error',
  };
  for (const [stack_status, label] of Object.entries(labels)) {
    // Act / Assert: label the stack result independently of location eligibility.
    assert.equal(stackLabel({ stack_status, eligibility: 'eligible' }), label);
  }
  for (const eligibility of ['ineligible', 'error']) {
    // Act / Assert: distinguish skipped checks without hiding completed results.
    assert.equal(
      stackLabel({ eligibility, stack_status: 'not_checked' }),
      'Skipped',
    );
    assert.equal(stackLabel({ eligibility, stack_status: 'match' }), 'match');
  }
  // Act / Assert: default a missing assessment to not checked.
  assert.equal(stackLabel({}), 'Not checked');
});

test('UI assessment filters work independently and in combination', () => {
  // Arrange: cover every stack state and mixed location results.
  const states = [
    'not_checked',
    'pending',
    'match',
    'partial_match',
    'potential_match',
    'unclear',
    'error',
  ];
  const jobs = states.map((stack_status, index) => ({
    reviewKey: String(index + 1),
    eligibility: 'eligible',
    stack_status,
  }));
  jobs.push(
    { reviewKey: '8', eligibility: 'ineligible', stack_status: 'not_checked' },
    {
      reviewKey: '9',
      eligibility: 'error',
      reason: 'Fetch failed',
      stack_status: 'not_checked',
    },
    { reviewKey: '10', eligibility: 'unclear', stack_status: 'match' },
  );
  const keys = (eligibility, stack) =>
    jobs
      .filter((job) => matchesAssessments(job, eligibility, stack))
      .map((job) => job.reviewKey);
  // Act / Assert: leaving both filters unset includes every listing.
  assert.equal(keys('all', 'all').length, 10);
  for (const state of states) {
    // Act: apply each stack filter without restricting location.
    const filtered = keys('all', state);
    // Assert: retain exactly the listings with that assessment.
    assert.deepEqual(
      filtered,
      jobs
        .filter((job) => job.stack_status === state)
        .map((job) => job.reviewKey),
    );
    assert.match(UI_HTML, new RegExp(`<option value="${state}">`));
  }
  // Act / Assert: intersect filters, including combinations with no matches.
  assert.deepEqual(keys('unclear', 'match'), ['10']);
  assert.deepEqual(keys('unclear', 'pending'), []);
  assert.deepEqual(keys('all', 'pending'), ['2']);
  assert.deepEqual(keys('ineligible', 'all'), ['8']);
  // Act / Assert: missing stack status retains the not-checked default.
  assert.equal(matchesAssessments({}, 'all', 'not_checked'), true);
});

test('UI Error filters include the relevant failed processing stages', () => {
  // Arrange: include location, stack and crawl failures with unfinished results.
  const jobs = [
    {
      reviewKey: '1',
      eligibility: 'pending',
      stack_status: 'match',
      stages: [{ stage: 'location', state: 'failed' }],
    },
    {
      reviewKey: '2',
      eligibility: 'ineligible',
      stack_status: 'pending',
      stages: [{ stage: 'stack', state: 'failed', error: 'Model offline' }],
    },
    {
      reviewKey: '3',
      eligibility: 'pending',
      stack_status: 'pending',
      stages: [{ stage: 'crawl', state: 'failed', error: 'Scraper offline' }],
    },
  ];
  // Act / Assert: location errors include location and crawl failures only.
  assert.deepEqual(
    jobs
      .filter((job) => matchesAssessments(job, 'error', 'all'))
      .map((job) => job.reviewKey),
    ['1', '3'],
  );
  // Act / Assert: stack errors include only failed stack assessments.
  assert.deepEqual(
    jobs
      .filter((job) => matchesAssessments(job, 'all', 'error'))
      .map((job) => job.reviewKey),
    ['2'],
  );
  for (const stage of ['crawl', 'location', 'stack']) {
    for (const state of [
      'pending',
      'complete',
      'failed',
      'terminal',
      'blocked',
    ]) {
      // Arrange: isolate each processing-stage/state combination.
      const job = { stages: [{ stage, state }] };
      // Act / Assert: terminal page failures affect location, not stack filtering.
      assert.equal(
        matchesAssessments(job, 'error', 'all'),
        stage !== 'stack' && ['failed', 'terminal'].includes(state),
      );
      assert.equal(
        matchesAssessments(job, 'all', 'error'),
        stage === 'stack' && state === 'failed',
      );
    }
  }
  // Act / Assert: saved error results work without processing-stage metadata.
  assert.equal(
    matchesAssessments(
      { eligibility: 'error', stack_status: 'error' },
      'error',
      'error',
    ),
    true,
  );
});

// Seed an isolated SQLite database and remove it after the server tests finish.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-web-'));
  const store = new SqliteStore(join(root, 'jobs.sqlite'));
  store.saveResults(
    [1, 2].map((id) => ({
      url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
      title: `Engineer ${id}`,
      query: 'remote',
    })),
  );
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

test('HTTP UI lists eligibility and persists individual listing statuses', async (t) => {
  // Arrange: seed an ineligible job and a stack failure, then start a local server.
  const { store } = await fixture(t);
  const job = store.getJob(1);
  store.review(job.id, 'ineligible', 'US residents only', 'United States');
  store.failStage(2, 'stack', 'Model unavailable', true);
  const server = await listenReviewServer(store, 0, '0.0.0.0');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path);
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  // Act: request the review page.
  const page = await get('/');
  // Assert: serve the expected HTML and location filter.
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await page.text(), UI_HTML);
  assert.match(UI_HTML, /Location eligibility/);
  // Act: retrieve the active listings through the API.
  const jobs = (await (await get('/api/jobs')).json()).jobs;
  // Assert: expose assessments and stage failures without full listing text.
  assert.equal(jobs.length, 2);
  assert.ok(
    jobs
      .find((row) => row.id === 2)
      .stages.some(
        (stage) =>
          stage.stage === 'stack' && stage.error === 'Model unavailable',
      ),
  );
  assert.equal('listing_text' in jobs[0], false);
  assert.equal(jobs.find((row) => row.id === job.id).eligibility, 'ineligible');
  assert.equal(
    jobs.find((row) => row.id === job.id).reason,
    'US residents only',
  );
  // Act / Assert: hide the reviewed job and retrieve it from the hidden list.
  assert.equal(
    (
      await post('/api/jobs/status', {
        reviewKey: String(job.id),
        status: 'hidden',
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await get('/api/jobs?status=hidden')).json()).jobs.length,
    1,
  );
  // Act / Assert: restore the job before moving it into the rejected list.
  assert.equal(
    (
      await post('/api/jobs/status', {
        reviewKey: String(job.id),
        status: 'active',
      })
    ).status,
    200,
  );
  // Act / Assert: reject the job and verify rejected and active list membership.
  assert.equal(
    (
      await post('/api/jobs/status', {
        reviewKey: String(job.id),
        status: 'rejected',
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await get('/api/jobs?status=rejected')).json()).jobs.length,
    1,
  );
  assert.deepEqual(
    (await (await get('/api/jobs?status=active')).json()).jobs.map(
      (row) => row.id,
    ),
    [2],
  );
  // Act / Assert: reject unsupported statuses and nonexistent review keys.
  assert.equal(
    (await post('/api/jobs/status', { reviewKey: '1', status: 'deleted' }))
      .status,
    400,
  );
  assert.equal(
    (await post('/api/jobs/status', { reviewKey: '999', status: 'hidden' }))
      .status,
    404,
  );
  // Act / Assert: refuse cross-origin status updates.
  assert.equal(
    (
      await post(
        '/api/jobs/status',
        { reviewKey: '1', status: 'hidden' },
        { origin: 'https://evil.test' },
      )
    ).status,
    403,
  );
  // Act: send a request with an untrusted Host header.
  const hostileHost = await new Promise((resolve, reject) => {
    httpGet(`${base}/`, { headers: { host: 'evil.test' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  // Assert: deny the untrusted host.
  assert.equal(hostileHost, 403);
  // Act / Assert: reject invalid list filters and oversized request bodies.
  assert.equal((await get('/api/jobs?status=deleted')).status, 400);
  assert.equal(
    (await post('/api/jobs/status', { padding: 'x'.repeat(17000) })).status,
    413,
  );
});

test('serve lifecycle closes the listener and removes signal handlers', {
  timeout: 5000,
}, async (t) => {
  // Arrange: capture signal listener counts and intercept the server-ready message.
  const { store } = await fixture(t);
  const before = ['SIGINT', 'SIGTERM'].map((signal) =>
    process.listenerCount(signal),
  );
  const ready = Promise.withResolvers();
  t.mock.method(console, 'log', (message) => ready.resolve(message));
  // Act: start the managed server and wait for its advertised address.
  const serving = serveReviewServer(store, 0);
  const message = await Promise.race([ready.promise, serving]);
  try {
    // Assert: advertise a loopback URL and serve requests while running.
    assert.match(message, /^Review UI: http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(
      (await fetch(message.slice('Review UI: '.length))).status,
      200,
    );
  } finally {
    // Act: send repeated shutdown signals and wait for the server to finish.
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await serving;
  }
  // Assert: restore the original signal listeners after shutdown.
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
    before,
  );
});

test('CLI reads app-local database from another cwd and validates arguments', async (t) => {
  // Arrange: copy an app with its database and profile outside the project cwd.
  const { root, store } = await fixture(t);
  await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
  // A temporary package marker preserves ES module semantics outside this project.
  await cp(resolve('package.json'), join(root, 'package.json'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await cp(resolve('profile.ts'), join(root, 'profile.ts'));
  // Run each CLI invocation from an unrelated directory to check app-local paths.
  const cli = (...args) =>
    spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
  // Act: list saved jobs from the copied application.
  const saved = cli('jobs');
  // Assert: read the application's own database successfully.
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(
    JSON.parse(saved.stdout).length,
    store.listReviewJobs('active').length,
  );
  // Act: list jobs with an unsupported model provider configured.
  const withoutModel = spawnSync(
    process.execPath,
    [join(root, 'dist/cli.js'), 'jobs'],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, MODEL_PROVIDER: 'unsupported' },
    },
  );
  // Assert: listing jobs does not initialize the model provider.
  assert.equal(withoutModel.status, 0, withoutModel.stderr);
  assert.deepEqual(JSON.parse(withoutModel.stdout), JSON.parse(saved.stdout));
  // Arrange: pair invalid commands and arguments with their expected diagnostics.
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
    // Assert: exit unsuccessfully with the corresponding validation error.
    assert.equal(invalid.status, 1, args.join(' '));
    assert.match(invalid.stderr, error, args.join(' '));
  }
  // Act / Assert: accept global help and an invocation without a command.
  assert.equal(cli('--help').status, 0);
  assert.equal(cli().status, 0);
  // Arrange: cover help for each worker and review command below.
  for (const command of [
    'review',
    'review-worker',
    'fetch-worker',
    'retry',
    'serve',
  ]) {
    // Act: request this command's help page.
    const help = cli(command, '--help');
    // Assert: print command-specific usage without an error.
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`job-hunter ${command}`));
  }
  // Act / Assert: show retry's required options for both help spellings.
  assert.match(cli('retry', '--help').stdout, /--stage/);
  assert.match(cli('retry', '-h').stdout, /--id/);
  // Arrange: make the copied profile syntactically invalid.
  await writeFile(join(root, 'profile.ts'), 'export default {broken');
  for (const command of ['fetch', 'review-worker']) {
    // Act: run each command that requires a loadable profile.
    const invalid = cli(command);
    // Assert: report the broken profile instead of starting the command.
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Cannot load profile.ts/);
  }
  // Act / Assert: keep listing and help independent of profile validity.
  assert.equal(cli('jobs').status, 0);
  assert.equal(cli('--help').status, 0);
  // Arrange: remove the profile entirely.
  await rm(join(root, 'profile.ts'));
  // Act: run a command that requires the missing profile.
  const missing = cli('fetch');
  // Assert: identify the missing profile in the diagnostic.
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot load profile.ts.*profile.ts/);
  // Arrange: remove the database implementation to check lazy help loading.
  await rm(join(root, 'dist/sqlite.js'));
  for (const args of [[], ['--help'], ['review', '--help'], ['retry', '-h']]) {
    // Act: request each global or command-specific usage variant.
    const help = cli(...args);
    // Assert: print usage without loading the unavailable database module.
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /USAGE/);
  }
});

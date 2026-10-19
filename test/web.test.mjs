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

// Only the DOM operations used by the inline UI; no browser dependency needed.
async function uiFixture(jobs) {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.className = '';
      this.value = 'all';
      this.text = '';
    }
    set textContent(value) {
      this.text = value;
      this.children = [];
    }
    get textContent() {
      return (
        this.text + this.children.map((child) => child.textContent).join('')
      );
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    remove() {
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    }
    replaceWith(node) {
      node.parent = this.parent;
      this.parent.children[this.parent.children.indexOf(this)] = node;
    }
    matches(selector) {
      return selector.startsWith('.')
        ? this.className.split(' ').includes(selector.slice(1))
        : this.tagName === selector;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector.split(', ').some((part) => child.matches(part))
          ? [child]
          : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0];
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector);
    }
    contains(node) {
      return (
        node === this || this.children.some((child) => child.contains(node))
      );
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const elements = Object.fromEntries(
    ['jobs', 'notice', 'eligibility', 'stack'].map((id) => [
      id,
      new Element('div'),
    ]),
  );
  const tabs = ['active', 'hidden', 'rejected'].map((status) => {
    const tab = new Element('button');
    tab.dataset.status = status;
    return tab;
  });
  const document = {
    getElementById: (id) => elements[id],
    querySelectorAll: () => tabs,
    createElement: (tag) => new Element(tag),
  };
  const requests = [];
  const statuses = new Map();
  // Keep status changes in memory so UI actions exercise subsequent list reloads.
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === 'POST') {
      const { reviewKey, status } = JSON.parse(options.body);
      statuses.set(reviewKey, status);
      return { ok: true, json: async () => ({}) };
    }
    const status = new URL(url, 'http://localhost').searchParams.get('status');
    return {
      ok: true,
      json: async () => ({
        jobs: jobs.filter(
          (job) => (statuses.get(job.reviewKey) || 'active') === status,
        ),
      }),
    };
  };
  // Run the real inline script against the minimal DOM and wait for async handlers.
  runInNewContext(UI_HTML.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document,
    fetch,
    URL,
    AbortController,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const event = async (element, type) => {
    element.listeners[type]();
    await settle();
  };
  await settle();
  return {
    ...elements,
    tabs,
    requests,
    event,
    cards: () => elements.jobs.querySelectorAll('.job'),
    filter: async (name, value) => {
      elements[name].value = value;
      await event(elements[name], 'change');
    },
  };
}

test('UI labels stack states, quotes untrusted evidence and keeps assessment filters independent', async () => {
  // Arrange: cover every stack state, hostile evidence and mixed location results.
  const states = [
    'not_checked',
    'pending',
    'match',
    'partial_match',
    'potential_match',
    'unclear',
    'error',
  ];
  const hostile = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
  const jobs = states.map((stack_status, index) => ({
    reviewKey: String(index + 1),
    eligibility: 'eligible',
    stack_status,
    stack_reason: hostile,
    stack_evidence: hostile,
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
  // Act: render the initial job list with the real UI script.
  const ui = await uiFixture(jobs);
  // Assert: render every listing before applying filters.
  assert.equal(ui.cards().length, 10);
  for (const [index, state] of states.entries()) {
    // Arrange: select the rendered card for this stack-state case.
    const card = ui.cards()[index];
    // Assert: label the assessments and display untrusted evidence as plain text.
    assert.equal(
      card.querySelector('.score').textContent,
      'Location: eligible',
    );
    const badge = card.querySelectorAll('.score')[1];
    assert.equal(badge.dataset.stackStatus, state);
    assert.equal(
      badge.textContent,
      `Stack: ${state === 'not_checked' ? 'Not checked' : state.replaceAll('_', ' ')}`,
    );
    assert.equal(
      card.querySelector('.assessment').querySelector('p').textContent,
      hostile,
    );
    assert.equal(card.querySelector('blockquote').textContent, hostile);
    assert.equal(card.querySelector('img'), undefined);
    assert.equal(card.querySelector('script'), undefined);
    assert.match(card.textContent, /Stack evidence from the listing/);
  }
  // Assert: distinguish failed stack checks from skipped assessments.
  assert.match(ui.cards()[6].textContent, /Stack assessment error/);
  assert.match(ui.cards()[7].textContent, /Stack: Skipped/);
  assert.match(
    ui.cards()[8].textContent,
    /Location: errorStack: Skipped.*Location assessment error/,
  );
  for (const state of states) {
    // Arrange: use each stack state as an independent filter case.
    // Act: filter the rendered list by this stack state.
    await ui.filter('stack', state);
    // Assert: keep only cards with the selected stack status.
    assert.ok(ui.cards().length > 0);
    assert.ok(
      ui
        .cards()
        .every(
          (card) =>
            card.querySelectorAll('.score')[1].dataset.stackStatus === state,
        ),
    );
  }
  // Act: combine stack and location filters.
  await ui.filter('stack', 'match');
  await ui.filter('eligibility', 'unclear');
  // Assert: retain the matching listing and the selected stack filter.
  assert.deepEqual(
    ui.cards().map((card) => card.dataset.reviewKey),
    ['10'],
  );
  assert.equal(ui.stack.value, 'match');
  // Act: select a stack status absent from the current location results.
  await ui.filter('stack', 'pending');
  // Assert: show the empty state without resetting the location filter.
  assert.equal(ui.cards().length, 0);
  assert.ok(ui.jobs.querySelector('.empty'));
  assert.equal(ui.eligibility.value, 'unclear');
  // Act: clear only the location filter.
  await ui.filter('eligibility', 'all');
  // Assert: preserve the pending stack filter and expose all stack filter options.
  assert.deepEqual(
    ui.cards().map((card) => card.dataset.reviewKey),
    ['2'],
  );
  for (const state of states)
    assert.match(UI_HTML, new RegExp(`<option value="${state}">`));
});

test('UI updates same-key assessments and preserves hide, reject and restore actions', async () => {
  // Arrange: render two pending jobs, then update an existing job's assessment.
  const jobs = [1, 2].map((id) => ({
    reviewKey: String(id),
    eligibility: 'eligible',
    stack_status: 'pending',
  }));
  const ui = await uiFixture(jobs);
  jobs[0].stack_status = 'match';
  jobs[0].stack_reason = 'Updated assessment';
  // Act: hide the other job, triggering a list reload.
  await ui.event(ui.cards()[1].querySelector('button'), 'click');
  // Assert: refresh the assessment even though its review key has not changed.
  assert.equal(ui.cards().length, 1);
  assert.match(ui.cards()[0].textContent, /Stack: match.*Updated assessment/);
  // Act: open the hidden listings tab.
  await ui.event(ui.tabs[1], 'click');
  // Assert: offer restoration for the hidden job.
  assert.equal(ui.cards()[0].dataset.reviewKey, '2');
  assert.equal(ui.cards()[0].querySelector('button').textContent, 'Restore');
  // Act: restore the hidden job and return to active listings.
  await ui.event(ui.cards()[0].querySelector('button'), 'click');
  await ui.event(ui.tabs[0], 'click');
  // Assert: both jobs are active again.
  assert.equal(ui.cards().length, 2);
  // Act: reject the first job and open rejected listings.
  await ui.event(ui.cards()[0].querySelectorAll('button')[1], 'click');
  await ui.event(ui.tabs[2], 'click');
  // Assert: show the rejected job and persist every requested status transition.
  assert.equal(ui.cards()[0].dataset.reviewKey, '1');
  assert.deepEqual(
    ui.requests
      .filter((request) => request.method === 'POST')
      .map((request) => JSON.parse(request.body)),
    [
      { reviewKey: '2', status: 'hidden' },
      { reviewKey: '2', status: 'active' },
      { reviewKey: '1', status: 'rejected' },
    ],
  );
});

test('UI displays stage failures as text and includes them in the independent Error filters', async () => {
  // Arrange: include hostile location error text and failures at all three stages.
  const hostile = '<script>untrusted()</script>';
  // Act: render jobs containing location, stack and crawl failures.
  const ui = await uiFixture([
    {
      reviewKey: '1',
      eligibility: 'pending',
      stack_status: 'match',
      stages: [{ stage: 'location', state: 'failed', error: hostile }],
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
  ]);
  // Assert: display failure details without interpreting them as markup.
  assert.match(ui.cards()[0].textContent, /location: failed/);
  assert.ok(ui.cards()[0].textContent.includes(hostile));
  assert.equal(ui.cards()[0].querySelector('script'), undefined);
  // Act: select the location Error filter.
  await ui.filter('eligibility', 'error');
  // Assert: include both location failures and crawl failures.
  assert.deepEqual(
    ui.cards().map((card) => card.dataset.reviewKey),
    ['1', '3'],
  );
  // Act: clear the location filter and select stack errors instead.
  await ui.filter('eligibility', 'all');
  await ui.filter('stack', 'error');
  // Assert: include only the failed stack assessment.
  assert.deepEqual(
    ui.cards().map((card) => card.dataset.reviewKey),
    ['2'],
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

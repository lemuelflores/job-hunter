import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Run the browser state transitions with a small DOM double and controlled HTTP.
function browser(fetch) {
  const element = () => ({
    children: [],
    dataset: {},
    className: '',
    value: 'all',
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    },
    replaceChildren() {
      this.children = [];
    },
    remove() {
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
    },
    contains() {
      return false;
    },
    get classList() {
      return { contains: (name) => this.className.split(' ').includes(name) };
    },
    querySelector() {
      return this.children.find((node) =>
        ['empty', 'list-control button'].includes(node.className),
      );
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    addEventListener() {},
  });
  const nodes = Object.fromEntries(
    ['jobs', 'notice', 'eligibility', 'stack'].map((id) => [id, element()]),
  );
  const scripts = [...UI_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const ui = runInNewContext(
    `${scripts[0][1]}\n${scripts[1][1].replace(/load\(\);\s*\}\)\(\);\s*$/, 'return { load, updateStatus, show: (status) => { currentStatus = status; return load(); } }; })();')}`,
    {
      URL,
      AbortController,
      fetch,
      document: {
        createElement: element,
        getElementById: (id) => nodes[id],
        querySelectorAll: () => [],
      },
    },
  );
  return {
    ...ui,
    notice: nodes.notice,
    keys: () =>
      nodes.jobs.children
        .filter((node) => node.className === 'job-card')
        .map((node) => node.dataset.reviewKey),
    change: (reviewKey, status) =>
      ui.updateStatus({ closest: () => ({ dataset: { reviewKey } }) }, status),
  };
}

test('successful browser saves stop overriding fresh server state in another tab', async () => {
  let status = 'active';
  const fetch = async (path, options) => {
    if (options?.method === 'POST') {
      status = JSON.parse(options.body).status;
      return Response.json({ ok: true });
    }
    return Response.json({
      jobs: path.endsWith(`=${status}`) ? [{ reviewKey: '1', status }] : [],
    });
  };
  const first = browser(fetch);
  const second = browser(fetch);
  await first.load();
  await first.change('1', 'hidden');
  assert.deepEqual(first.keys(), []);
  await second.show('hidden');
  await second.change('1', 'active');
  await first.load();
  assert.deepEqual(first.keys(), ['1']);
  await first.change('1', 'hidden');
  await first.show('hidden');
  assert.deepEqual(first.keys(), ['1']);
});

test('failed browser saves restore the card without leaving a stale override', async () => {
  let status = 'active';
  const ui = browser(async (path, options) =>
    options?.method === 'POST'
      ? Response.json({ error: 'Write failed' }, { status: 500 })
      : Response.json({
          jobs: path.endsWith(`=${status}`) ? [{ reviewKey: '1', status }] : [],
        }),
  );
  await ui.load();
  await ui.change('1', 'hidden');
  assert.deepEqual(ui.keys(), ['1']);
  assert.match(ui.notice.textContent, /Write failed/);
  status = 'hidden';
  await ui.show('hidden');
  assert.deepEqual(ui.keys(), ['1']);
});

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

test('UI cards group statuses, reasons and expandable evidence without interpreting listing HTML', () => {
  const element = (tag) => ({
    tag,
    children: [],
    dataset: {},
    attributes: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener() {},
  });
  const scripts = [...UI_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const { renderJob } = runInNewContext(
    `${scripts[0][1]}\n${scripts[1][1].replace(/load\(\);\s*\}\)\(\);\s*$/, 'return { renderJob }; })();')}`,
    {
      URL,
      document: {
        createElement: element,
        getElementById: () => element('div'),
        querySelectorAll: () => [],
      },
    },
  );
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const job = {
    reviewKey: '1',
    title: '<img src=x onerror=alert(1)>',
    company: 'Example',
    location: 'Worldwide',
    eligibility: 'eligible',
    reason: 'Remote from your location',
    evidence: 'Work from anywhere',
    stack_status: 'partial_match',
    stack_reason: 'Some core skills match',
    stack_evidence: 'TypeScript and Go',
    url: 'https://example.com/job',
    stages: [{ stage: 'stack', state: 'pending', error: 'Temporary failure' }],
  };
  const card = renderJob(job);
  const nodes = descendants(card);
  assert.equal(card.className, 'job-card');
  assert.equal(card.attributes['aria-labelledby'], 'job-title-1');
  assert.equal(nodes.find((node) => node.tag === 'h2').textContent, job.title);
  assert.ok(nodes.some((node) => node.textContent === 'Location: Worldwide'));
  const metadata = nodes.find(
    (node) => node.className === 'job-card__metadata',
  );
  assert.equal(metadata.children[0].textContent, 'Example');
  assert.equal(metadata.children[1].textContent, 'Location: Worldwide');
  for (const [fields, company, location] of [
    [{}, 'Company not provided', 'Not provided'],
    [{ company: '  ', location: '  ' }, 'Company not provided', 'Not provided'],
    [{ company: null, location: null }, 'Company not provided', 'Not provided'],
    [{ company: 42, location: 42 }, 'Company not provided', 'Not provided'],
    [{ company: ' Example ', location: ' Worldwide ' }, 'Example', 'Worldwide'],
    [
      { board: ' Example board ', eligibility: 'pending' },
      'Example board',
      'Not provided',
    ],
    [{ eligibility: 'error' }, 'Company not provided', 'Not provided'],
    [
      { eligibility: 'unclear', location: 'Europe' },
      'Company not provided',
      'Europe',
    ],
    [
      { eligibility: 'unclear', location: 'Unclear' },
      'Company not provided',
      'Unclear',
    ],
  ]) {
    const row = descendants(renderJob({ reviewKey: '3', ...fields })).find(
      (node) => node.className === 'job-card__metadata',
    );
    assert.equal(row.children[0].textContent, company);
    assert.equal(row.children[1].textContent, `Location: ${location}`);
  }
  assert.ok(nodes.some((node) => node.className === 'job-card__error'));
  const panels = nodes.filter((node) => node.className === 'assessment');
  assert.equal(panels.length, 2);
  for (const [index, reason, evidence, status] of [
    [0, job.reason, job.evidence, 'eligible'],
    [1, job.stack_reason, job.stack_evidence, 'partial-match'],
  ]) {
    const contents = descendants(panels[index]);
    assert.equal(panels[index].children[0].className, 'assessment__header');
    assert.equal(panels[index].children[1].className, 'assessment__content');
    assert.equal(panels[index].children[1].children[0].textContent, reason);
    assert.ok(contents.some((node) => node.textContent === reason));
    assert.ok(
      contents.some((node) => node.className?.endsWith(`__status--${status}`)),
    );
    const details = contents.find((node) => node.tag === 'details');
    assert.equal(details.attributes.open, undefined);
    assert.equal(details.children[0].tag, 'summary');
    assert.equal(details.children[1].textContent, evidence);
  }
  const link = nodes.find((node) => node.tag === 'a');
  assert.equal(link.href, job.url);
  assert.equal(link.rel, 'noopener noreferrer');
  assert.deepEqual(
    nodes
      .filter((node) => node.tag === 'button')
      .map((node) => node.textContent),
    ['Hide', 'Reject'],
  );
  const pending = descendants(
    renderJob({ reviewKey: '2', url: 'javascript:alert(1)' }, true),
  );
  assert.equal(
    pending.some((node) => node.tag === 'a'),
    false,
  );
  assert.equal(pending.filter((node) => node.tag === 'details').length, 0);
  assert.equal(
    pending.filter(
      (node) => node.textContent === 'No assessment available yet.',
    ).length,
    2,
  );
  assert.ok(
    pending
      .filter((node) => node.tag === 'button')
      .every((node) => node.disabled),
  );
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

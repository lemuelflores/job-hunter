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

// Test the production Alpine component's state, not a reimplementation of its DOM.
function browser(fetch, href = 'http://localhost/') {
  const location = { href };
  const history = [];
  const document = { hidden: false, querySelectorAll: () => [] };
  const window = { scrollBy() {} };
  const timers = new Map();
  const ui = runInNewContext(
    `${UI_HTML.match(/<script id="assessment-logic">([\s\S]*?)<\/script>/)[1]}
    ${UI_HTML.match(/<script id="review-component">([\s\S]*?)<\/script>/)[1]}
    window.jobReview();`,
    {
      URL,
      AbortController,
      fetch,
      location,
      document,
      history: {
        pushState: (_state, _unused, url) => {
          location.href = String(url);
          history.push(location.href);
        },
      },
      setInterval: (callback, delay) => {
        timers.set(callback, delay);
        return callback;
      },
      clearInterval: (timer) => timers.delete(timer),
      window,
    },
  );
  ui.$nextTick = async () => {};
  return {
    ui,
    location,
    history,
    document,
    window,
    timers,
    load: () => ui.load(),
    show: (status) => ui.selectView({ status }),
    get notice() {
      return { textContent: ui.notice };
    },
    keys: () => Array.from(ui.visibleJobs, (job) => job.reviewKey),
    change: (reviewKey, status) =>
      ui.updateStatus(
        ui.visibleJobs.find((job) => job.reviewKey === reviewKey),
        status,
      ),
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

test('restoring unfinished listings explains explicit repair without starting processing', async () => {
  for (const state of ['pending', 'complete']) {
    let status = 'hidden';
    const requests = [];
    const ui = browser(async (path, options) => {
      requests.push(path);
      if (options?.method === 'POST') {
        status = JSON.parse(options.body).status;
        return Response.json({ ok: true });
      }
      return Response.json({
        jobs: path.endsWith(`=${status}`)
          ? [{ reviewKey: '1', status, stages: [{ stage: 'crawl', state }] }]
          : [],
      });
    });
    await ui.show('hidden');
    await ui.change('1', 'active');
    assert.equal(
      ui.notice.textContent.includes('pnpm job-hunter repair'),
      state === 'pending',
    );
    assert.deepEqual(requests, [
      '/api/jobs?status=hidden',
      '/api/jobs/status',
      '/api/jobs?status=hidden',
    ]);
  }
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

test('URL selections validate, survive reconstruction and restore on history navigation', async () => {
  const requests = [];
  const fetch = async (path) => {
    requests.push(path);
    return Response.json({ jobs: [] });
  };
  const first = browser(
    fetch,
    'http://localhost/?status=hidden&eligibility=eligible&stack=match&other=kept',
  );
  assert.equal(first.ui.status, 'hidden');
  assert.equal(first.ui.eligibility, 'eligible');
  assert.equal(first.ui.stack, 'match');
  await first.ui.selectView({ status: 'hidden' });
  assert.equal(
    first.history.length,
    0,
    'reselecting a tab must not add history',
  );
  await first.ui.selectView({ stack: 'pending' });
  assert.equal(requests.length, 0, 'filtering needs no network request');
  const reloaded = browser(fetch, first.location.href);
  assert.equal(reloaded.ui.stack, 'pending');
  assert.equal(new URL(first.location.href).searchParams.get('other'), 'kept');
  first.location.href =
    'http://localhost/?status=rejected&eligibility=unclear&stack=partial_match';
  await first.ui.restoreView();
  assert.equal(first.ui.status, 'rejected');
  assert.equal(first.ui.eligibility, 'unclear');
  assert.equal(first.ui.stack, 'partial_match');
  assert.deepEqual(requests, ['/api/jobs?status=rejected']);
  assert.equal(
    first.history.length,
    1,
    'popstate must not add a history entry',
  );
  const invalid = browser(
    fetch,
    'http://localhost/?status=__proto__&eligibility=bad&stack=bad',
  );
  assert.equal(invalid.ui.status, 'active');
  assert.equal(invalid.ui.eligibility, 'all');
  assert.equal(invalid.ui.stack, 'all');
});

test('visible polling admits only one read, retains data on errors and cleans up', async () => {
  let calls = 0;
  const read = Promise.withResolvers();
  const page = browser(async () => {
    calls++;
    if (calls === 1) return Response.json({ jobs: [{ reviewKey: '1' }] });
    return read.promise;
  });
  await page.load();
  page.document.hidden = true;
  await page.ui.refresh();
  assert.equal(calls, 1);
  page.document.hidden = false;
  const refreshing = page.ui.refresh();
  await page.ui.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(page.keys(), ['1']);
  read.resolve(Response.json({ error: 'Offline' }, { status: 503 }));
  await refreshing;
  assert.deepEqual(page.keys(), ['1']);
  assert.match(page.notice.textContent, /Offline/);
  assert.equal(page.ui.loading, false);
  page.ui.init();
  assert.deepEqual([...page.timers.values()], [5000]);
  page.ui.destroy();
  assert.equal(page.timers.size, 0);
});

test('stale reads cannot replace a newly selected status even if abort is ignored', async () => {
  const old = Promise.withResolvers();
  const page = browser(async (path) =>
    path.endsWith('active')
      ? old.promise
      : Response.json({ jobs: [{ reviewKey: '2' }] }),
  );
  const loading = page.load();
  await page.show('hidden');
  old.resolve(Response.json({ jobs: [{ reviewKey: '1' }] }));
  await loading;
  assert.deepEqual(page.keys(), ['2']);
  assert.equal(page.ui.loading, false);
});

test('reads cannot undo pending saves and pre-save responses cannot undo reconciliation', async () => {
  let status = 'active';
  const saving = Promise.withResolvers();
  const stale = Promise.withResolvers();
  let reads = 0;
  const page = browser(async (_path, options) => {
    if (options?.method === 'POST') {
      await saving.promise;
      status = 'hidden';
      return Response.json({ ok: true });
    }
    reads++;
    if (reads === 3) return stale.promise;
    return Response.json({
      jobs: status === 'active' ? [{ reviewKey: '1' }] : [],
    });
  });
  await page.load();
  const mutation = page.change('1', 'hidden');
  await page.ui.refresh();
  assert.deepEqual(
    page.keys(),
    [],
    'fresh source reads cannot undo a pending move',
  );
  const oldRead = page.ui.refresh();
  saving.resolve();
  await mutation;
  assert.deepEqual(page.keys(), []);
  stale.resolve(Response.json({ jobs: [{ reviewKey: '1' }] }));
  await oldRead;
  assert.deepEqual(page.keys(), []);
  assert.equal(Object.keys(page.ui.pending).length, 0);
  status = 'active';
  await page.ui.refresh();
  assert.deepEqual(
    page.keys(),
    ['1'],
    'later changes from other tabs remain authoritative',
  );
});

test('a successful save with a failed reconciliation stays saved and retries reads', async () => {
  let reads = 0;
  const page = browser(async (_path, options) => {
    if (options?.method === 'POST') return Response.json({ ok: true });
    reads++;
    if (reads === 1)
      return Response.json({ jobs: [{ reviewKey: '1' }, { reviewKey: '2' }] });
    if (reads === 2) throw new Error('Offline');
    return Response.json({ jobs: [{ reviewKey: '2' }, { reviewKey: '3' }] });
  });
  await page.load();
  await page.change('1', 'hidden');
  assert.deepEqual(page.keys(), ['2']);
  assert.equal(page.ui.saveError, '');
  assert.match(page.ui.loadError, /Offline/);
  await page.ui.refresh();
  assert.deepEqual(page.keys(), ['2', '3']);
  assert.equal(page.ui.loadError, '');
});

test('malformed reads retain existing cards instead of looking like an empty result', async () => {
  let response = { jobs: [{ reviewKey: '1' }] };
  const page = browser(async () => Response.json(response));
  await page.load();
  for (response of [
    null,
    {},
    { jobs: [null] },
    { jobs: [{ reviewKey: 1 }] },
    { jobs: [{ reviewKey: '1' }, { reviewKey: '1' }] },
  ]) {
    await page.load();
    assert.deepEqual(page.keys(), ['1']);
    assert.match(page.ui.loadError, /Invalid jobs/);
  }
});

test('continuity anchors a surviving neighbor and transfers focus without scrolling', async () => {
  const page = browser();
  const focused = { isConnected: true };
  const focusCalls = [];
  const scrollCalls = [];
  const card = (key, top) => ({
    dataset: { reviewKey: key },
    top,
    getBoundingClientRect() {
      return { top: this.top, bottom: this.top + 300 };
    },
    contains: (element) => element === focused && key === '2',
    querySelector: () => ({
      focus: (options) => focusCalls.push([key, options.preventScroll]),
    }),
  });
  const first = card('1', -400);
  const second = card('2', -50);
  const third = card('3', 274);
  let cards = [first, second, third];
  page.document.activeElement = focused;
  page.document.querySelectorAll = () => cards;
  page.window.scrollBy = (x, y) => scrollCalls.push([x, y]);
  await page.ui.preservePosition(() => {
    cards = [first, third];
    third.top -= 324;
    focused.isConnected = false;
  });
  assert.deepEqual(scrollCalls, [[0, -324]]);
  assert.deepEqual(focusCalls, [['3', true]]);
  // With no surviving cards, the selected tab is the only useful focus fallback.
  focusCalls.length = 0;
  page.document.activeElement = focused;
  first.contains = () => true;
  page.document.querySelector = (selector) => ({
    focus: (options) => focusCalls.push([selector, options.preventScroll]),
  });
  await page.ui.preservePosition(() => {
    cards = [];
  });
  assert.deepEqual(focusCalls, [['[data-status="active"]', true]]);
});

test('UI presentation helpers retain assessment data, metadata fallbacks and safe links', () => {
  const { ui } = browser();
  const job = {
    eligibility: 'eligible',
    reason: 'Remote',
    evidence: '<b>Anywhere</b>',
    stack_status: 'partial_match',
    stack_reason: 'TypeScript',
    stack_evidence: 'Go',
  };
  const [location, stack] = ui.assessments(job);
  assert.equal(location.reason, job.reason);
  assert.equal(location.evidence, job.evidence);
  assert.equal(stack.label, 'partial match');
  assert.equal(stack.reason, job.stack_reason);
  assert.equal(stack.evidence, job.stack_evidence);
  for (const value of [null, undefined, 42, '', '  '])
    assert.equal(ui.displayText(value, 'Not provided'), 'Not provided');
  assert.equal(ui.displayText(' Example ', 'Not provided'), 'Example');
  assert.equal(
    ui.safeUrl('https://example.com/job'),
    'https://example.com/job',
  );
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    '/relative',
    null,
  ])
    assert.equal(ui.safeUrl(value), null);
  assert.match(UI_HTML, /x-for="job in visibleJobs" :key="job.reviewKey"/);
  assert.match(UI_HTML, /x-text="job.title/);
  assert.doesNotMatch(UI_HTML, /x-html|innerHTML/);
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
      source: id === 1 ? 'google' : 'freehire',
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
  const alpine = await get('/alpine.js');
  assert.equal(alpine.status, 200);
  assert.equal(
    alpine.headers.get('content-type'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(alpine.headers.get('cache-control'), 'no-store');
  assert.match(await alpine.text(), /Alpine/);
  assert.match(UI_HTML, /<script defer src="\/alpine.js"><\/script>/);
  assert.equal((await get('/node_modules/alpinejs/package.json')).status, 404);
  assert.match(UI_HTML, /Location eligibility/);
  // Act: retrieve the active listings through the API.
  const jobs = (await (await get('/api/jobs')).json()).jobs;
  // Assert: expose assessments and stage failures without full listing text.
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((row) => row.id === 1).source, 'google');
  assert.equal(jobs.find((row) => row.id === 2).source, 'freehire');
  assert.match(
    UI_HTML,
    /:aria-label="`Source: \$\{\{ google: 'Google', freehire: 'Freehire' \}\[job.source\] \|\| 'Unknown'\}`"/,
  );
  assert.match(UI_HTML, /class="job-card__source"/);
  assert.match(UI_HTML, /\.job-card__source--google\s*\{/);
  assert.match(UI_HTML, /\.job-card__source--freehire\s*\{/);
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

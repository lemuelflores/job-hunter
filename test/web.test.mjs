import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as TanStackVirtual from '@tanstack/virtual-core';
import { SqliteStore } from '../src/infra/sqlite.ts';
import {
  jobReview,
  matchesAssessments,
  stackLabel,
} from '../src/web/review.js';
import {
  listenReviewServer,
  UI_HTML as PRODUCTION_HTML,
  serveReviewServer,
} from '../src/web/server.ts';

const UI_HTML = readFileSync(
  new URL('../src/web/index.html', import.meta.url),
  'utf8',
);

// Test the production Alpine component's state, not a reimplementation of its DOM.
function browser(fetch, href = 'http://localhost/') {
  const location = { href };
  const history = [];
  const document = {
    hidden: false,
    documentElement: { scrollHeight: 400000 },
    querySelectorAll: () => [],
  };
  const listeners = new Map();
  const window = {
    TanStackVirtual,
    // Canvas/layout are exercised in the browser smoke test, not this DOM-free harness.
    createCardSizer: () => ({
      configure: () => false,
      estimate: () => 360,
      clear() {},
    }),
    scrollY: 0,
    innerHeight: 900,
    innerWidth: 1280,
    document,
    scrollBy() {},
    scrollTo() {},
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    requestAnimationFrame: (callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    performance,
  };
  window.window = window;
  const timers = new Map();
  const ui = jobReview({
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
  });
  ui.$nextTick = async () => {};
  ui.$el = { querySelector: () => ({ clientWidth: 1040 }) };
  ui.$refs = {
    virtualList: {
      getBoundingClientRect: () => ({ top: 250 - window.scrollY }),
    },
  };
  return {
    ui,
    location,
    history,
    document,
    window,
    timers,
    listeners,
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

test('assessment state is retained separately for each listing and assessment', () => {
  const { ui } = browser();
  ui.assessmentState('1', 'Location eligibility').showEvidence = true;
  assert.equal(
    ui.assessmentState('1', 'Location eligibility').showEvidence,
    true,
  );
  assert.equal(ui.assessmentState('1', 'Stack match').showEvidence, false);
  assert.equal(
    ui.assessmentState('2', 'Location eligibility').showEvidence,
    false,
  );
});

test('listing links use validated URLs and isolate the opened tab', () => {
  const title = UI_HTML.match(
    /<a\s+class="job-row__title-link"[\s\S]*?<\/a\s*>/,
  )[0];
  const view = UI_HTML.match(
    /<a\s+class="button job-row__link"[\s\S]*?<\/a\s*>/,
  )[0];
  for (const link of [title, view]) {
    assert.match(link, /:href="safeUrl\(job.url\)"/);
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener noreferrer"/);
  }
  assert.match(UI_HTML, /x-show="!safeUrl\(job.url\)"/);
});

test('unmounted cards use content-aware estimates instead of a fixed height', async (t) => {
  const estimates = [];
  const page = browser(async () =>
    Response.json({ jobs: [{ reviewKey: '1', title: 'Engineer' }] }),
  );
  page.window.createCardSizer = () => ({
    configure: () => false,
    estimate: (content) => {
      estimates.push(content);
      return 480;
    },
    clear() {},
  });
  t.after(() => page.ui.destroy());
  await page.ui.init();
  assert.equal(estimates[0].title, 'Engineer');
  assert.equal(page.ui.totalSize, 480);
});

test('large result sets select a bounded render window and update it on scroll', async () => {
  const page = browser(async () =>
    Response.json({
      jobs: Array.from({ length: 1000 }, (_, index) => ({
        reviewKey: String(index),
      })),
    }),
  );
  await page.ui.init();
  assert.equal(page.ui.visibleJobs.length, 1000);
  assert.ok(
    page.ui.renderedJobs.length > 0 && page.ui.renderedJobs.length < 20,
  );
  assert.equal(page.ui.renderedJobs[0].reviewKey, '0');
  page.window.scrollY = 100000;
  page.listeners.get('scroll')();
  assert.ok(Number(page.ui.renderedJobs[0].reviewKey) > 200);
  assert.ok(page.ui.renderedJobs.length < 20);
  page.ui.destroy();
  assert.equal(page.listeners.size, 0);
});

test('a reported card height updates the following card offset', async () => {
  const page = browser(async () =>
    Response.json({ jobs: [{ reviewKey: '1' }, { reviewKey: '2' }] }),
  );
  await page.ui.init();
  page.ui.measureRow({
    isConnected: true,
    getAttribute: () => '0',
    offsetHeight: 640,
    getBoundingClientRect: () => ({ height: 640, width: 1040 }),
  });
  assert.equal(page.ui.renderedJobs[1].virtualStart, 656);
  page.ui.destroy();
});

test('the render window retains a focused listing and its keyboard neighbors', async () => {
  const page = browser(async () =>
    Response.json({
      jobs: Array.from({ length: 1000 }, (_, index) => ({
        reviewKey: String(index),
      })),
    }),
  );
  await page.ui.init();
  page.document.activeElement = {
    closest: () => ({ dataset: { reviewKey: '2' } }),
  };
  page.ui.syncVirtual();
  page.window.scrollY = 100000;
  page.listeners.get('scroll')();
  assert.deepEqual(
    Array.from(page.ui.renderedJobs.slice(0, 3), (job) => job.reviewKey),
    ['1', '2', '3'],
  );
  assert.ok(page.ui.renderedJobs.length < 25);
  page.document.activeElement = null;
  page.ui.syncVirtual();
  assert.ok(Number(page.ui.renderedJobs[0].reviewKey) > 200);
  page.ui.destroy();
});

test('polling keeps its visible anchor when new rows move it outside overscan', async () => {
  const page = browser(async () =>
    Response.json({
      jobs: Array.from({ length: 1000 }, (_, index) => ({
        reviewKey: String(index),
      })),
    }),
  );
  await page.ui.init();
  page.document.querySelectorAll = () =>
    Array.from(page.ui.renderedJobs, (job) => ({
      dataset: { reviewKey: job.reviewKey },
      contains: () => false,
      getBoundingClientRect: () => ({
        top: job.virtualStart + 250 - page.window.scrollY,
        bottom: job.virtualStart + 610 - page.window.scrollY,
      }),
    }));
  page.window.scrollBy = (_x, y) => {
    page.window.scrollY += y;
    page.listeners.get('scroll')();
  };
  page.window.scrollY = 100000;
  page.listeners.get('scroll')();
  const anchor = page.document
    .querySelectorAll()
    .find((row) => row.getBoundingClientRect().bottom > 0);
  const top = anchor.getBoundingClientRect().top;
  await page.ui.preservePosition(() => {
    page.ui.cache.active = [
      ...Array.from({ length: 30 }, (_, index) => ({
        reviewKey: `new-${index}`,
      })),
      ...page.ui.cache.active,
    ];
  });
  const remaining = page.document
    .querySelectorAll()
    .find((row) => row.dataset.reviewKey === anchor.dataset.reviewKey);
  assert.equal(remaining?.getBoundingClientRect().top, top);
  assert.ok(page.ui.renderedJobs.length < 20);
  page.ui.destroy();
});

test('relative dates span seconds through years without disguising unknown dates', () => {
  const { ui } = browser(() => assert.fail('No request needed'));
  ui.now = Date.parse('2026-10-22T12:00:00Z');
  for (const [seconds, expected] of [
    [0, 'just now'],
    [0.5, 'just now'],
    [1, '1 second ago'],
    [35, '35 seconds ago'],
    [59, '59 seconds ago'],
    [60, '1 minute ago'],
    [3599, '59 minutes ago'],
    [3600, '1 hour ago'],
    [86399, '23 hours ago'],
    [86400, '1 day ago'],
    [604799, '6 days ago'],
    [604800, '1 week ago'],
    [1814400, '3 weeks ago'],
    [2592000, '1 month ago'],
    [7776000, '3 months ago'],
    [31536000, '1 year ago'],
    [63072000, '2 years ago'],
    [-3600, 'in 1 hour'],
  ]) {
    assert.equal(
      ui.relativeDate(new Date(ui.now - seconds * 1000).toISOString()),
      expected,
    );
  }
  for (const value of [null, undefined, '', ' ', 'invalid', 0])
    assert.equal(ui.relativeDate(value), '');
});

test('the existing visible refresh updates relative ages even when a read fails', async () => {
  const { ui, document } = browser(async () => {
    throw new Error('Offline');
  });
  const found = new Date(Date.now() - 120000).toISOString();
  ui.now = Date.parse(found);
  document.hidden = true;
  await ui.refresh();
  assert.equal(ui.relativeDate(found), 'just now');
  document.hidden = false;
  await ui.refresh();
  assert.equal(ui.relativeDate(found), '2 minutes ago');
  assert.equal(ui.loadError, 'Offline');
});

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
    querySelector: (selector) => {
      assert.equal(selector, '.job-row__title');
      return {
        focus: (options) => focusCalls.push([key, options.preventScroll]),
      };
    },
  });
  const first = card('1', -400);
  const second = card('2', -50);
  const third = card('3', 274);
  let cards = [first, second, third];
  page.document.activeElement = focused;
  page.document.querySelectorAll = (selector) => {
    assert.equal(selector, '.job-row');
    return cards;
  };
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
      postedAt: id === 1 ? '2025-01-02T12:00:00Z' : null,
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
  assert.equal(await page.text(), PRODUCTION_HTML);
  const assetPath = PRODUCTION_HTML.match(/src="(\/assets\/[^"]+\.js)"/)[1];
  const bundle = await get(assetPath);
  assert.equal(bundle.status, 200);
  assert.equal(
    bundle.headers.get('content-type'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(bundle.headers.get('cache-control'), 'no-store');
  const bundleSource = await bundle.text();
  assert.match(bundleSource, /Alpine/);
  assert.doesNotMatch(bundleSource, /process\.env/);
  assert.doesNotMatch(
    PRODUCTION_HTML,
    /importmap|assessment-logic|review-component/,
  );
  assert.equal((await get('/main.js')).status, 404);
  assert.equal((await get('/review.js')).status, 404);
  assert.equal((await get('/src/web/server.ts')).status, 404);
  assert.equal((await get('/assets/../../profile.ts')).status, 404);
  assert.equal((await get(`${assetPath}.map`)).status, 404);
  assert.equal((await get('/card-size.ts')).status, 404);
  assert.equal((await get('/pretext/package.json')).status, 404);
  assert.equal((await get('/pretext/layout.d.ts')).status, 404);
  assert.equal((await get('/virtual/index.js.map')).status, 404);
  assert.equal((await get('/node_modules/alpinejs/package.json')).status, 404);
  // Act: retrieve the active listings through the API.
  const jobs = (await (await get('/api/jobs')).json()).jobs;
  // Assert: expose assessments and stage failures without full listing text.
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((row) => row.id === 1).source, 'google');
  assert.equal(jobs.find((row) => row.id === 2).source, 'freehire');
  assert.equal(
    jobs.find((row) => row.id === 1).posted_at,
    '2025-01-02T12:00:00.000Z',
  );
  assert.equal(jobs.find((row) => row.id === 1).first_seen, job.first_seen);
  assert.equal(jobs.find((row) => row.id === 2).posted_at, null);
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
        reviewKey: ` ${job.id} `,
        status: 'hidden',
        extra: 'ignored',
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
  for (const payload of [
    null,
    [],
    'invalid',
    {},
    { reviewKey: 1, status: 'hidden' },
    { reviewKey: ' \t', status: 'hidden' },
    { reviewKey: '1' },
    { reviewKey: '1', status: null },
  ]) {
    const response = await post('/api/jobs/status', payload);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Invalid request payload',
    });
  }
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

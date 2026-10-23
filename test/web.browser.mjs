import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { listenReviewServer } from '../src/web/server.ts';

async function browser(t, beforeLoad = '') {
  assert.ok(
    process.env.CHROMIUM_PATH,
    'Set CHROMIUM_PATH to a Chromium executable',
  );
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults(
    Array.from({ length: 1000 }, (_, i) => ({
      url: `https://example.com/jobs/${i}`,
      title: `Engineer ${i}`,
      source: 'google',
      query: 'remote',
    })),
  );
  const server = await listenReviewServer(store, 0);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const profile = await mkdtemp(join(tmpdir(), 'job-hunter-browser-'));
  const chrome = spawn(process.env.CHROMIUM_PATH, [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ]);
  let closeBrowser = null;
  t.after(async () => {
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      if (closeBrowser) await closeBrowser();
      else chrome.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });
  const endpoint = await new Promise((resolve, reject) => {
    chrome.once('error', reject);
    chrome.stderr.on('data', (chunk) => {
      const match = String(chunk).match(
        /DevTools listening on (ws:\/\/[^\s]+)/,
      );
      if (match) resolve(match[1]);
    });
  });
  const pages = await (
    await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)
  ).json();
  const ws = new WebSocket(
    pages.find((page) => page.type === 'page').webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    ws.addEventListener('open', resolve, { once: true }),
  );
  t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) =>
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result),
      );
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify(result.exceptionDetails),
    );
    return result.result.value;
  };
  const waitFor = (expression) =>
    evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 10000;
      const check = () => {
        if (${expression}) return resolve();
        if (performance.now() > deadline) return reject(new Error(${JSON.stringify(`Timed out waiting for: ${expression}`)}));
        requestAnimationFrame(check);
      }; check();
    })`);
  closeBrowser = () => call('Browser.close');
  await call('Runtime.enable');
  await call('Page.enable');
  if (beforeLoad)
    await call('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
  await call('Page.navigate', {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  await waitFor(
    `document.querySelector('.job-row') && document.querySelector('#jobs').getAttribute('aria-busy') !== 'true'`,
  );
  return { call, evaluate, waitFor, errors, store };
}

test('a listing can be hidden and restored through the page and stays saved after reload', {
  timeout: 60000,
}, async (t) => {
  const { call, evaluate, waitFor, errors, store } = await browser(t);
  const key = await evaluate(
    `document.querySelector('.job-row').dataset.reviewKey`,
  );
  const row = `document.querySelector('[data-review-key="${key}"]')`;
  const button = (label) =>
    `[...${row}.querySelectorAll('button')].find(button => button.textContent.trim() === '${label}' && button.getClientRects().length)`;

  await evaluate(`${button('Hide')}.click()`);
  await waitFor(`!${row}`);
  await evaluate(`document.querySelector('[data-status="hidden"]').click()`);
  await waitFor(
    `${row} && ${button('Restore')} && !${button('Restore')}.disabled && document.querySelector('#jobs').getAttribute('aria-busy') !== 'true'`,
  );
  assert.deepEqual(
    store.listReviewJobs('hidden').map((job) => job.reviewKey),
    [key],
  );

  await call('Page.reload');
  await waitFor(
    `document.querySelector('[data-status="hidden"]').getAttribute('aria-pressed') === 'true' && ${row} && ${button('Restore')}`,
  );
  await evaluate(`${button('Restore')}.click()`);
  await waitFor(`!${row}`);
  await evaluate(`document.querySelector('[data-status="active"]').click()`);
  await waitFor(
    `${row} && ${button('Hide')} && !${button('Hide')}.disabled && document.querySelector('#jobs').getAttribute('aria-busy') !== 'true'`,
  );
  assert.ok(
    store.listReviewJobs('active').some((job) => job.reviewKey === key),
  );
  assert.equal(store.listReviewJobs('hidden').length, 0);

  await call('Page.reload');
  await waitFor(
    `document.querySelector('[data-status="active"]').getAttribute('aria-pressed') === 'true' && ${row} && ${button('Hide')}`,
  );
  assert.deepEqual(errors, []);
});

test('Pretext improves unmounted-card estimates while real DOM measurements remain authoritative', {
  timeout: 60000,
}, async (t) => {
  const { call, evaluate, errors } = await browser(t);
  assert.ok(
    await evaluate(`document.querySelectorAll('.job-row').length < 20`),
  );
  await evaluate(`(() => {
    const ui = Alpine.$data(document.querySelector('main'));
    ui.refresh = () => {};
    document.documentElement.style.overflowY = 'scroll';
    window.sampleJob = {
      ...ui.cache.active[0], reviewKey: 'sample', title: 'Engineer', company: 'Example',
      location: 'Remote', eligibility: 'eligible', reason: 'Remote role.', stack_status: 'match',
      stack_reason: 'TypeScript.', posted_at: null, first_seen: '2026-10-24T00:00:00Z', stages: [],
    };
    window.sizingResults = [];
    window.frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.showSample = async (job, status = 'active') => {
      await ui.preservePosition(() => {
        ui.status = status;
        ui.cache[status] = [job];
      });
      await frame();
    };
  })()`);
  for (const width of [1280, 375, 320]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const results = await evaluate(`(async () => {
      const ui = Alpine.$data(document.querySelector('main'));
      const sizer = createCardSizer(document.querySelector('#jobs'));
      const sample = sampleJob;
      await showSample(sample);
      sizer.configure(ui.cardContent(sample));
      const cases = [
        { job: sample },
        { job: { ...sample, reason: 'The position is fully remote and accepts candidates living in Malaysia. '.repeat(5) } },
        { job: { ...sample, stack_reason: 'Experience with TypeScript, Node.js, PostgreSQL and distributed systems is required. '.repeat(8) } },
        { job: { ...sample, title: 'Senior Staff Software Engineer, Infrastructure and Developer Experience Platform' } },
        { job: { ...sample, company: 'An unusually long multinational company name with many words', location: 'Remote, Europe, Middle East, Africa and Asia Pacific' } },
        { job: { ...sample, reason: 'Remote work.\\n\\nMalaysia is eligible.\\nNo residency restriction.' } },
        { job: { ...sample, reason: '工作地点不限。欢迎来自亚洲各地的远程工程师。'.repeat(10) } },
        { job: { ...sample, reason: 'https://example.com/verylongunbrokenpath'.repeat(10) } },
        { job: { ...sample, title: '', company: '', location: '', reason: '', stack_reason: '' } },
        { job: { ...sample, stages: [{ stage: 'crawl', state: 'failed', error: 'An upstream request failed. '.repeat(10) }, { stage: 'stack', state: 'failed', error: 'Model unavailable' }] } },
        { job: { ...sample, url: 'invalid' } },
        { job: sample, status: 'hidden' },
      ];
      const result = [];
      for (const {job, status} of cases) {
        await showSample(job, status);
        const content = ui.cardContent(job);
        const estimate = sizer.estimate(content);
        const actual = document.querySelector('.job-row').getBoundingClientRect().height;
        result.push({ estimate, actual, error: Math.abs(estimate - actual), fixedError: Math.abs(360 - actual) });
      }
      sizingResults.push(...result);
      return result;
    })()`);
    assert.ok(
      results.every((result) => result.error < 4),
      `${width}px estimates: ${JSON.stringify(results)}`,
    );
    assert.equal(
      await evaluate(`document.documentElement.scrollWidth <= innerWidth`),
      true,
    );
  }
  const totals = await evaluate(
    `sizingResults.reduce((sum, row) => ({pretext: sum.pretext + row.error, fixed: sum.fixed + row.fixedError}), {pretext:0,fixed:0})`,
  );
  assert.ok(totals.pretext < totals.fixed / 4, JSON.stringify(totals));
  t.diagnostic(
    `36 card/viewport cases: total absolute error ${totals.pretext.toFixed(1)}px with Pretext vs ${totals.fixed.toFixed(1)}px with 360px`,
  );
  const evidence = await evaluate(`(async () => {
    const ui = Alpine.$data(document.querySelector('main'));
    const job = { ...sampleJob, evidence: 'Worldwide. '.repeat(100) };
    await showSample(job);
    const before = document.querySelector('.job-row').offsetHeight;
    const stackBefore = document.querySelectorAll('.assessment__text')[1].textContent;
    document.querySelector('.assessment__explanation').click();
    await frame();
    const row = document.querySelector('.job-row');
    return {
      before, after: row.offsetHeight, spacer: document.querySelector('#jobs').offsetHeight,
      location: document.querySelector('.assessment__text').textContent,
      stackBefore, stackAfter: document.querySelectorAll('.assessment__text')[1].textContent,
      pressed: document.querySelector('.assessment__explanation').getAttribute('aria-pressed'),
    };
  })()`);
  assert.equal(evidence.location, 'Worldwide. '.repeat(100));
  assert.equal(evidence.stackAfter, evidence.stackBefore);
  assert.equal(evidence.pressed, 'true');
  assert.ok(evidence.after > evidence.before);
  assert.ok(
    Math.abs(evidence.spacer - evidence.after) < 2,
    JSON.stringify(evidence),
  );
  const fonts = await evaluate(`(async () => {
    const ui = Alpine.$data(document.querySelector('main'));
    const job = { ...sampleJob, reason: 'A fully remote engineering role for candidates in Asia. '.repeat(20) };
    await ui.preservePosition(() => {
      ui.status = 'active';
      ui.cache.active = Array.from({length:100}, (_, index) => ({...job, reviewKey:'font-'+index}));
    });
    await frame();
    const before = ui.totalSize;
    document.body.style.fontFamily = 'monospace';
    document.fonts.dispatchEvent(new Event('loadingdone'));
    await frame();
    await frame();
    const actual = document.querySelector('.job-row').offsetHeight;
    return {before, after:ui.totalSize, expected:actual * 100 + 16 * 99};
  })()`);
  assert.notEqual(fonts.before, fonts.after);
  assert.ok(
    Math.abs(fonts.after - fonts.expected) < 400,
    JSON.stringify(fonts),
  );
  const fallback = await evaluate(`(async () => {
    const ui = Alpine.$data(document.querySelector('main'));
    await showSample(sampleJob);
    const segmenter = Intl.Segmenter;
    Intl.Segmenter = undefined;
    try {
      const sizer = createCardSizer(document.querySelector('#jobs'));
      const content = ui.cardContent(sampleJob);
      sizer.configure(content);
      return {estimate:sizer.estimate(content), actual:document.querySelector('.job-row').offsetHeight};
    } finally { Intl.Segmenter = segmenter; }
  })()`);
  assert.ok(
    Math.abs(fallback.estimate - fallback.actual) < 2,
    JSON.stringify(fallback),
  );
  assert.deepEqual(errors, []);
});

for (const [feature, source] of [
  ['Canvas 2D', 'HTMLCanvasElement.prototype.getContext = () => null;'],
  ['Intl.Segmenter', 'Intl.Segmenter = undefined;'],
]) {
  test(`the review UI mounts when ${feature} is unavailable at startup`, {
    timeout: 20000,
  }, async (t) => {
    const { evaluate, errors } = await browser(t, source);
    const state = await evaluate(`(() => {
      const ui = Alpine.$data(document.querySelector('main'));
      return {count:ui.visibleJobs.length, height:ui.totalSize, mounted:document.querySelectorAll('.job-row').length};
    })()`);
    assert.equal(state.count, 1000);
    assert.ok(state.height > 0 && Number.isFinite(state.height));
    assert.ok(state.mounted > 0 && state.mounted < 20);
    assert.deepEqual(errors, []);
  });
}

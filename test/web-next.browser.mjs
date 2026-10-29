import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessment, result } from './fixtures/workflow.mjs';

test('production inbox displays and updates isolated saved reviews', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-next-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  store.saveResults([{ ...result(1), title: 'Production test engineer' }]);
  store.saveListingText(1, 'Saved private source text');
  store.saveAssessment(1, {
    ...assessment,
    eligibility: [
      {
        item: 'Location',
        result: 'fail',
        jd_quote: null,
        candidate_fact: null,
      },
    ],
    requirements: [
      {
        requirement: 'TypeScript',
        priority: 'required',
        status: 'documented',
        jd_quote: 'TypeScript',
        candidate_evidence: null,
      },
    ],
  });
  store.close();

  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      env: {
        ...process.env,
        JOB_HUNTER_DB_PATH: path,
        JOB_HUNTER_WEB_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve) => server.once('exit', resolve));
  t.after(async () => {
    server.kill('SIGTERM');
    await exited;
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Ready')) resolve();
    });
    server.once('error', reject);
    server.once('exit', (code) =>
      reject(new Error(`Next server exited: ${code}`)),
    );
  });
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/1`)).text();
  assert.match(html, /Production test engineer/);
  assert.ok(html.includes(assessment.verdict_reason));
  assert.ok(!html.includes('Saved private source text'));
  assert.equal((await fetch(`${base}/999999`)).status, 404);
  assert.equal((await fetch(`${base}/cv.md`)).status, 404);
  assert.equal((await fetch(`${base}/candidate-profile.md`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
  });
  t.after(() => browser.close());
  const noJavaScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJavaScript.newPage();
  await staticPage.goto(`${base}/1`);
  await expect(
    staticPage.getByRole('heading', { name: 'Production test engineer' }),
  ).toBeVisible();
  await expect(
    staticPage
      .getByRole('paragraph')
      .filter({ hasText: assessment.verdict_reason }),
  ).toBeVisible();
  await noJavaScript.close();
  const page = await browser.newPage();
  await page.goto(base);
  await t.test('manual URL dialog submits and reports success', async () => {
    await page.route('**/api/inbox/add', async (route) => {
      assert.deepEqual(route.request().postDataJSON(), {
        url: 'https://example.com/job',
      });
      await route.fulfill({ json: { id: 2, added: true } });
    });
    await page.getByRole('button', { name: 'Add URL' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a listing' });
    await dialog.getByLabel('Job listing URL').fill('https://example.com/job');
    await dialog.getByRole('button', { name: 'Add listing' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      'Listing added and queued.',
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();
    await page.unroute('**/api/inbox/add');
  });
  await expect(page).toHaveURL(`${base}/1`);
  await expect(
    page.getByRole('heading', { name: 'Production test engineer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('paragraph').filter({ hasText: assessment.verdict_reason }),
  ).toBeVisible();
  for (const [title, kind] of [
    ['Verdict', 'verdict'],
    ['Hard stops', 'hard-stops'],
    ['Decision-changing questions', 'questions'],
    ['Concerns to weigh', 'concerns'],
    ['Strengths', 'strengths'],
    ['Role summary', 'confidence'],
  ]) {
    await expect(
      page.locator('.report__section--brief').filter({
        has: page.getByRole('heading', { name: title, exact: true }),
      }),
    ).toHaveClass(new RegExp(`report__section--${kind}\\b`));
  }
  for (const [title, color] of [
    ['Verdict', 'rgb(244, 252, 248)'],
    ['Hard stops', 'rgb(255, 247, 251)'],
    ['Decision-changing questions', 'rgb(255, 250, 234)'],
    ['Concerns to weigh', 'rgb(255, 250, 253)'],
    ['Strengths', 'rgb(250, 252, 255)'],
    ['Role summary', 'rgb(250, 253, 253)'],
    ['Compensation', 'rgb(250, 253, 253)'],
    ['Schedule', 'rgb(250, 253, 253)'],
  ]) {
    await expect(
      page.locator('.report__section--brief').filter({
        has: page.getByRole('heading', { name: title, exact: true }),
      }),
    ).toHaveCSS('background-color', color);
  }
  await expect(
    page.locator('.report__labels').getByText('Recommendation: Skip'),
  ).toHaveClass(/badge--skip/);
  await expect(
    page.locator('.report-row__badges').getByText('Recommendation: Skip'),
  ).toHaveClass(/badge--skip/);
  await expect(
    page.locator('.report__labels').getByText('Confidence: high'),
  ).toHaveClass(/badge--evidence/);
  await expect(
    page.getByRole('cell', { name: 'fail', exact: true }).locator('.badge'),
  ).toHaveClass(/badge--bad/);
  await expect(
    page.getByRole('cell', { name: 'required', exact: true }).locator('.badge'),
  ).toHaveClass(/badge--info/);
  await expect(
    page
      .getByRole('cell', { name: 'documented', exact: true })
      .locator('.badge'),
  ).toHaveClass(/badge--good/);
  await page.getByRole('link', { name: /Production test engineer/ }).click();
  await expect(page).toHaveURL(`${base}/1`);
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByText('No listings match your search.')).toBeVisible();
  await expect(page).toHaveURL(`${base}/`);
  const hiddenHtml = await (await fetch(`${base}/1`)).text();
  assert.ok(hiddenHtml.includes('Production test engineer'));
  assert.ok(hiddenHtml.includes('Restore'));
  const hiddenPage = await browser.newPage();
  await hiddenPage.goto(`${base}/1`);
  await expect(
    hiddenPage.getByRole('button', { name: 'Restore' }),
  ).toBeVisible();
  await hiddenPage.getByLabel('Filters').click();
  await expect(hiddenPage.getByLabel('Review status')).toHaveValue('hidden');
  await hiddenPage.close();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('hidden');
  await page.getByLabel('Filters').click();
  await expect(page).toHaveURL(`${base}/1`);
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel('Filters').click();
  await page.getByLabel('Review status').selectOption('active');
  await page.getByLabel('Filters').click();
  await expect(
    page.getByRole('heading', { name: 'Production test engineer' }),
  ).toBeVisible();
  const invalidHost = await new Promise((resolve, reject) => {
    const request = get(
      `${base}/`,
      { headers: { host: `attacker.example:${port}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const invalidOrigin = await fetch(`${base}/api/inbox/status`, {
    method: 'POST',
    headers: {
      origin: 'http://attacker.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: 1, status: 'hidden' }),
  });
  assert.equal(invalidOrigin.status, 403);

  const updated = new SqliteStore(path);
  updated.saveResults([{ ...result(2), title: 'Second test engineer' }]);
  updated.saveListingText(2, 'Another saved source');
  updated.saveAssessment(2, assessment);
  updated.close();
  const staticNavigation = await browser.newContext({
    javaScriptEnabled: false,
  });
  const staticNavigationPage = await staticNavigation.newPage();
  await staticNavigationPage.goto(`${base}/1`);
  await staticNavigationPage
    .getByRole('link', { name: /Second test engineer/ })
    .click();
  await expect(staticNavigationPage).toHaveURL(`${base}/2`);
  await expect(
    staticNavigationPage.getByRole('heading', { name: 'Second test engineer' }),
  ).toBeVisible();
  await staticNavigation.close();
  await page.reload();
  await page.getByRole('link', { name: /Second test engineer/ }).click();
  await expect(page).toHaveURL(`${base}/2`);
  await expect(
    page.getByRole('heading', { name: 'Second test engineer' }),
  ).toBeVisible();
  await page.getByLabel('Find an evaluation').fill('Production test engineer');
  await expect(page).toHaveURL(`${base}/1`);
  await page.getByLabel('Find an evaluation').clear();
  await page.getByRole('link', { name: /Second test engineer/ }).click();
  await page.getByRole('link', { name: /Production test engineer/ }).click();
  await expect(page).toHaveURL(`${base}/1`);
  await page.goBack();
  await expect(page).toHaveURL(`${base}/2`);
  await expect(
    page.getByRole('heading', { name: 'Second test engineer' }),
  ).toBeVisible();

  await t.test(
    'refresh failures retain the inbox and recover on a later poll',
    async () => {
      const refreshPage = await browser.newPage();
      await refreshPage.clock.install();
      let reads = 0;
      await refreshPage.route('**/api/inbox', async (route) => {
        reads++;
        if (reads === 1) {
          await route.fulfill({ status: 503, body: 'unavailable' });
          return;
        }
        await route.continue();
      });
      await refreshPage.goto(`${base}/1`);
      await expect(refreshPage.locator('p[role="alert"]')).toHaveText(
        'Could not refresh listings. Retrying…',
      );
      await expect(
        refreshPage.getByRole('heading', { name: 'Production test engineer' }),
      ).toBeVisible();
      await refreshPage.clock.fastForward(5000);
      await expect(refreshPage.locator('p[role="alert"]')).toHaveCount(0);
      assert.equal(reads, 2);
      await refreshPage.close();
    },
  );

  await t.test(
    'malformed refreshes do not replace saved listings with an empty inbox',
    async () => {
      const refreshPage = await browser.newPage();
      await refreshPage.route('**/api/inbox', (route) =>
        route.fulfill({ json: { listings: 'invalid' } }),
      );
      await refreshPage.goto(`${base}/1`);
      await expect(refreshPage.locator('p[role="alert"]')).toHaveText(
        'Could not refresh listings. Retrying…',
      );
      await expect(
        refreshPage.getByRole('heading', { name: 'Production test engineer' }),
      ).toBeVisible();
      await refreshPage.close();
    },
  );

  await t.test('a slow refresh does not create overlapping polls', async () => {
    const refreshPage = await browser.newPage();
    await refreshPage.clock.install();
    let reads = 0;
    let started;
    const requestStarted = new Promise((resolve) => {
      started = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await refreshPage.route('**/api/inbox', async (route) => {
      reads++;
      started();
      await gate;
      await route.continue();
    });
    await refreshPage.goto(`${base}/1`);
    await requestStarted;
    await refreshPage.clock.fastForward(30000);
    assert.equal(reads, 1);
    release();
    await refreshPage.waitForResponse((response) =>
      response.url().endsWith('/api/inbox'),
    );
    await refreshPage.close();
  });

  await t.test(
    'an older refresh cannot undo a completed status change',
    async () => {
      const refreshPage = await browser.newPage();
      let started;
      const requestStarted = new Promise((resolve) => {
        started = resolve;
      });
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let finished;
      const staleFinished = new Promise((resolve) => {
        finished = resolve;
      });
      let reads = 0;
      await refreshPage.route('**/api/inbox', async (route) => {
        reads++;
        if (reads !== 1) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        started();
        await gate;
        await route.fulfill({ response });
        finished();
      });
      await refreshPage.goto(`${base}/1`);
      await requestStarted;
      await refreshPage
        .getByRole('button', { name: 'Hide', exact: true })
        .click();
      await expect(
        refreshPage.getByRole('link', { name: /Production test engineer/ }),
      ).toHaveCount(0);
      release();
      await staleFinished;
      await expect(
        refreshPage.getByRole('link', { name: /Production test engineer/ }),
      ).toHaveCount(0);
      await refreshPage.close();
    },
  );

  await t.test(
    'a successful status change remains visible if its refresh fails',
    async () => {
      const restored = await fetch(`${base}/api/inbox/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, status: 'active' }),
      });
      assert.equal(restored.status, 200);
      const refreshPage = await browser.newPage();
      let reads = 0;
      await refreshPage.route('**/api/inbox', async (route) => {
        reads++;
        if (reads === 1) {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 503, body: 'unavailable' });
      });
      await refreshPage.goto(`${base}/1`);
      await refreshPage.waitForResponse((response) =>
        response.url().endsWith('/api/inbox'),
      );
      await refreshPage
        .getByRole('button', { name: 'Hide', exact: true })
        .click();
      await expect(refreshPage.locator('p[role="alert"]')).toBeVisible();
      await expect(
        refreshPage.getByRole('link', { name: /Production test engineer/ }),
      ).toHaveCount(0);
      await refreshPage.close();
    },
  );

  await t.test('a failed status change leaves the listing active', async () => {
    const restored = await fetch(`${base}/api/inbox/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, status: 'active' }),
    });
    assert.equal(restored.status, 200);
    const actionPage = await browser.newPage();
    await actionPage.route('**/api/inbox/status', (route) =>
      route.fulfill({ status: 503, body: 'unavailable' }),
    );
    await actionPage.goto(`${base}/1`);
    await actionPage.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(
      actionPage.getByRole('link', { name: /Production test engineer/ }),
    ).toBeVisible();
    await expect(
      actionPage.getByRole('button', { name: 'Hide', exact: true }),
    ).toBeEnabled();
    const persisted = new SqliteStore(path);
    assert.equal(persisted.getJob(1).status, 'active');
    persisted.close();
    await actionPage.close();
  });

  await t.test(
    'marking a listing stale moves it to the stale filter',
    async () => {
      const actionPage = await browser.newPage();
      await actionPage.goto(`${base}/1`);
      const actions = actionPage.locator('.report__actions');
      await expect(actions.locator('button')).toHaveText([
        'Applied',
        'Hide',
        'Reject',
        'Stale',
      ]);
      await actionPage
        .getByRole('button', { name: 'Stale', exact: true })
        .click();
      await expect(
        actionPage.getByRole('link', { name: /Production test engineer/ }),
      ).toHaveCount(0);
      await actionPage.getByLabel('Filters').click();
      await actionPage.getByLabel('Review status').selectOption('stale');
      await actionPage.getByLabel('Filters').click();
      await expect(
        actionPage.getByRole('button', { name: 'Restore' }),
      ).toBeVisible();
      const persisted = new SqliteStore(path);
      assert.equal(persisted.getJob(1).status, 'stale');
      persisted.close();
      await actionPage.close();
    },
  );
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SqliteStore } from '../dist/persistence.js';
import { UI_HTML } from '../dist/ui.js';
import { listenReviewServer } from '../dist/web.js';

const batch = 'a'.repeat(32);
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

test('HTTP UI lists eligibility, persists reversible statuses and board-level company actions', async (t) => {
  const { store } = await fixture(t);
  const [job] = store.claimBatch(batch, 1);
  store.review(
    job.id,
    batch,
    'ineligible',
    'US residents only',
    'United States',
  );
  store.finishBatch(batch);
  const server = await listenReviewServer(store, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path);
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await page.text(), UI_HTML);
  assert.match(UI_HTML, /Location eligibility/);
  const jobs = (await (await get('/api/jobs')).json()).jobs;
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((row) => row.id === job.id).eligibility, 'ineligible');
  assert.equal(
    jobs.find((row) => row.id === job.id).reason,
    'US residents only',
  );
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
  assert.equal(
    (
      await post('/api/jobs/status', {
        reviewKey: String(job.id),
        status: 'active',
      })
    ).status,
    200,
  );
  const company = await (
    await post('/api/jobs/company-status', {
      companyKey: jobs[0].companyKey,
      status: 'rejected',
    })
  ).json();
  assert.equal(company.updated, 2);
  assert.equal(
    (await (await get('/api/jobs?status=rejected')).json()).jobs.length,
    2,
  );
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
  const hostileHost = await new Promise((resolve, reject) => {
    httpGet(`${base}/`, { headers: { host: 'evil.test' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await get('/api/jobs?status=deleted')).status, 400);
  assert.equal(
    (await post('/api/jobs/status', { padding: 'x'.repeat(17000) })).status,
    413,
  );
});

test('CLI reads app-local database from another cwd and validates arguments', async (t) => {
  const { root, store } = await fixture(t);
  await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
  // A temporary package marker preserves ES module semantics outside this project.
  await cp(resolve('package.json'), join(root, 'package.json'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await cp(resolve('profile.ts'), join(root, 'profile.ts'));
  await mkdir(join(root, 'src'));
  await cp(resolve('src/title.ts'), join(root, 'src/title.ts'));
  const cli = (...args) =>
    spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
  const saved = cli('jobs');
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(
    JSON.parse(saved.stdout).length,
    store.listReviewJobs('active').length,
  );
  assert.equal(cli('review', '--db', '/tmp/arbitrary.sqlite').status, 1);
  assert.equal(cli('review', '--status', 'rejected').status, 1);
  assert.equal(cli('review', '--limit', '0').status, 1);
  assert.match(cli('review', '--limit', '0').stderr, /Expected an integer/);
  assert.equal(cli('fetch', '--limit', '1').status, 1);
  assert.equal(cli('--help').status, 0);
  await writeFile(join(root, 'profile.ts'), 'export default {broken');
  for (const command of ['fetch', 'review', 'worker']) {
    const invalid = cli(command);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Cannot load profile.ts/);
  }
  assert.equal(cli('jobs').status, 0);
  assert.equal(cli('--help').status, 0);
  await rm(join(root, 'profile.ts'));
  const missing = cli('fetch');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot load profile.ts.*profile.ts/);
});

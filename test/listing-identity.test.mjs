import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { listInbox } from '../src/app/review-data.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { fetchGreenhouseListing } from '../src/integrations/ats/greenhouse.ts';
import { searchFreehireListings } from '../src/integrations/search/freehire.ts';
import { assessJob } from '../src/workflow/assess-job.ts';
import { crawlJob } from '../src/workflow/crawl.ts';
import { assessment } from './fixtures/workflow.mjs';

test('crawl and assessment fill missing identity without replacing stored fields', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { source: 'user', url: 'https://example.test/job', title: '', query: '' },
  ]);
  await crawlJob(
    store,
    1,
    {
      ats: [
        {
          hosts: ['example.test'],
          extract: async () => ({
            text: 'job text',
            title: 'Source title',
            company: 'Source company',
          }),
        },
      ],
      fallback: async () => ({ text: 'fallback' }),
    },
    async () => {},
  );
  await assessJob(
    store,
    1,
    async () => ({ cv: 'cv', profile: 'profile' }),
    async () => ({
      ...assessment,
      company: 'Model company',
      role: 'Model role',
    }),
  );
  assert.equal(store.getJob(1).title, 'Source title');
  assert.equal(store.getJob(1).company, 'Source company');
  assert.equal(store.getAssessment(1).assessment.company, 'Model company');
});

test('assessment fills blanks independently and keeps an existing title', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'freehire',
      url: 'https://example.test/job',
      title: 'Existing',
      query: '',
    },
  ]);
  store.saveListingText(1, 'job text');
  await assessJob(
    store,
    1,
    async () => ({ cv: 'cv', profile: 'profile' }),
    async () => ({
      ...assessment,
      company: 'Model company',
      role: 'Model role',
    }),
  );
  assert.equal(store.getJob(1).company, 'Model company');
  assert.equal(store.getJob(1).title, 'Existing');
});

test('Freehire discovery accepts missing fields and retains first-source provenance on duplicates', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const items = [
    {
      url: 'https://example.test/1',
      description: 'text',
      company: 'Company',
      title: 'Role',
    },
    { url: 'https://example.test/2', description: 'text', title: null },
    {
      url: 'https://example.test/3',
      description: 'text',
      company: 'Only company',
    },
  ];
  const outcome = await searchFreehireListings(
    { enabled: true },
    (url) => url,
    {
      fetch: async (url) =>
        Response.json({
          data: items,
          meta: {
            total: 3,
            limit: Number(url.searchParams.get('limit')),
            offset: 0,
          },
        }),
    },
  );
  store.saveResults(outcome.discoveries);
  store.saveResults([
    {
      source: 'google',
      url: items[0].url,
      title: 'Later title',
      company: 'Later company',
      query: '',
    },
  ]);
  assert.equal(store.getJob(1).source, 'freehire');
  assert.equal(store.getJob(1).title, 'Role');
  assert.equal(store.getJob(1).company, 'Company');
  assert.equal(store.getJob(2).title, '');
  assert.equal(store.getJob(2).company, '');
  assert.equal(store.getJob(3).title, '');
  assert.equal(store.getJob(3).company, 'Only company');
});

test('Freehire listings ignore ATS identity and use assessment for missing fields', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'freehire',
      url: 'https://example.test/job',
      company: 'Freehire',
      query: '',
    },
  ]);
  await crawlJob(
    store,
    1,
    {
      ats: [
        {
          hosts: ['example.test'],
          extract: async () => ({
            text: 'text',
            company: 'ATS',
            title: 'ATS title',
          }),
        },
      ],
      fallback: async () => ({ text: 'fallback' }),
    },
    async () => {},
  );
  await assessJob(
    store,
    1,
    async () => ({ cv: 'cv', profile: 'profile' }),
    async () => ({ ...assessment, company: 'Model', role: 'Model title' }),
  );
  assert.equal(store.getJob(1).company, 'Freehire');
  assert.equal(store.getJob(1).title, 'Model title');
});

test('scraper output cannot supply identity', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { source: 'user', url: 'https://example.test/job', query: '' },
  ]);
  await crawlJob(
    store,
    1,
    {
      ats: [],
      fallback: async () => ({
        text: 'text',
        title: 'Page title',
        company: 'Page company',
      }),
    },
    async () => {},
  );
  assert.equal(store.getJob(1).title, '');
  assert.equal(store.getJob(1).company, '');
});

test('Greenhouse returns only structured identity available in its API response', async () => {
  const url = 'https://job-boards.greenhouse.io/tenant/jobs/1';
  const extract = (job) =>
    fetchGreenhouseListing(url, { fetch: async () => Response.json(job) });
  const full = await extract({
    id: 1,
    content: '<p>description</p>',
    title: 'Engineer',
    company_name: 'Company',
  });
  const missing = await extract({ id: 1, content: '<p>description</p>' });
  assert.equal(full.title, 'Engineer');
  assert.equal(full.company, 'Company');
  assert.equal(missing.title, undefined);
  assert.equal(missing.company, undefined);
});

test('inbox uses saved identity rather than report identity', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'freehire',
      url: 'https://example.test/job',
      title: 'Saved title',
      company: 'Saved company',
      query: '',
    },
  ]);
  store.saveListingText(1, 'private job text');
  await assessJob(
    store,
    1,
    async () => ({ cv: 'private cv', profile: 'private profile' }),
    async () => ({
      ...assessment,
      company: 'Model company',
      role: 'Model role',
    }),
  );
  const [item] = listInbox(store);
  assert.equal(item.company, 'Saved company');
  assert.equal(item.title, 'Saved title');
  assert.equal(item.assessment.company, 'Model company');
  assert.doesNotMatch(JSON.stringify(item), /private (job text|cv|profile)/);
});

test('a competing crawl checkpoint wins over a late extraction result', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { source: 'google', url: 'https://example.test/job', query: '' },
  ]);
  const extract = async () => {
    store.saveListingText(1, 'winning text', null, {
      title: 'Winning title',
      company: 'Winning company',
    });
    return { text: 'late text', title: 'Late title', company: 'Late company' };
  };
  await crawlJob(
    store,
    1,
    {
      ats: [{ hosts: ['example.test'], extract }],
      fallback: async () => ({ text: 'fallback' }),
    },
    async () => {},
  );
  assert.equal(store.getJob(1).title, 'Winning title');
  assert.equal(store.getJob(1).company, 'Winning company');
  assert.equal(store.getJob(1).listing_text, 'winning text');
});

test('reassessment does not replace identity established by the first assessment', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    { source: 'user', url: 'https://example.test/job', query: '' },
  ]);
  store.saveListingText(1, 'text');
  store.saveAssessment(1, {
    ...assessment,
    company: 'First company',
    role: 'First role',
  });
  store.queueReassessment(1);
  store.saveAssessment(1, {
    ...assessment,
    company: 'Second company',
    role: 'Second role',
  });
  assert.equal(store.getJob(1).company, 'First company');
  assert.equal(store.getJob(1).title, 'First role');
  assert.equal(store.getAssessment(1).assessment.company, 'Second company');
});

test('identity and crawl checkpoint roll back together on a storage failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'job-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(() => store.close());
  store.saveResults([
    { source: 'user', url: 'https://example.test/job', query: '' },
  ]);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER reject_title BEFORE UPDATE OF title ON jobs BEGIN SELECT RAISE(ABORT, 'reject title'); END",
  );
  db.close();
  assert.throws(
    () =>
      store.saveListingText(1, 'text', null, {
        company: 'Company',
        title: 'Role',
      }),
    /reject title/,
  );
  assert.equal(store.getJob(1).company, '');
  assert.equal(store.getJob(1).listing_text, null);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'crawl').state,
    'pending',
  );
});

test('assessment identity and report roll back together on a storage failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'job-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(() => store.close());
  store.saveResults([
    { source: 'user', url: 'https://example.test/job', query: '' },
  ]);
  store.saveListingText(1, 'text');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER reject_title BEFORE UPDATE OF title ON jobs BEGIN SELECT RAISE(ABORT, 'reject title'); END",
  );
  db.close();
  assert.throws(
    () =>
      store.saveAssessment(1, {
        ...assessment,
        company: 'Company',
        role: 'Role',
      }),
    /reject title/,
  );
  assert.equal(store.getJob(1).company, '');
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
});

test('historical completed reports do not fill blank stored identity on read', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'job-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(() => store.close());
  store.saveResults([
    { source: 'google', url: 'https://example.test/job', query: '' },
  ]);
  store.saveListingText(1, 'text');
  store.saveAssessment(1, {
    ...assessment,
    company: 'Report company',
    role: 'Report role',
  });
  const db = new DatabaseSync(path);
  db.exec("UPDATE jobs SET company='', title='' WHERE id=1");
  db.close();
  const [item] = listInbox(store);
  assert.equal(item.company, '');
  assert.equal(item.title, '');
  assert.equal(item.processing, 'complete');
  assert.equal(item.assessment.company, 'Report company');
  assert.equal(store.getJob(1).company, '');
});

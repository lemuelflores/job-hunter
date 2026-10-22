import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverFreehireJobs,
  discoverGoogleJobs,
} from '../dist/discovery/discover.js';
import { searchFreehire } from '../dist/discovery/freehire.js';
import { normalizeFreehireUrl } from '../dist/discovery/job-url.js';
import { checkLocation } from '../dist/review/location-check.js';
import { checkTech } from '../dist/review/tech-check.js';
import { SqliteStore } from '../dist/sqlite.js';
import {
  externalFixture,
  profile,
  result,
  stack,
} from './fixtures/workflow.mjs';

const config = {
  enabled: true,
  regions: ['global', 'apac', 'none'],
  work_mode: ['remote'],
  category: ['backend'],
  skills: ['php', 'laravel'],
  skills_exclude: ['dotnet'],
  countries: ['ph'],
  countries_exclude: ['in'],
  reality: ['fresh'],
  posted_within_days: 14,
};
const job = (id = 1) => ({
  url: result(id).url,
  title: 'Freehire engineer',
  description: '## Full description\nUS Laravel role',
});
const page = (url, data, total = data.length, extra = {}) =>
  Response.json({
    data,
    meta: {
      total,
      limit: Number(url.searchParams.get('limit')),
      offset: Number(url.searchParams.get('offset')),
      ...extra,
    },
  });

test('Freehire sends native filters, defaults, identification and full-description endpoint', async () => {
  const outcome = await searchFreehire(
    {
      ...config,
      q: 'title:"developer" -junior',
      skills_mode: 'and',
      salary_min: 1000,
      visa_sponsorship: false,
      q_fields: ['title', 'description'],
    },
    {
      fetch: async (url, init) => {
        assert.equal(
          url.origin + url.pathname,
          'https://freehire.me/api/v1/agent/jobs/search',
        );
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          regions: 'global,apac,none',
          work_mode: 'remote',
          category: 'backend',
          skills: 'php,laravel',
          skills_exclude: 'dotnet',
          countries: 'ph',
          countries_exclude: 'in',
          reality: 'fresh',
          posted_within_days: '14',
          q: 'title:"developer" -junior',
          skills_mode: 'and',
          salary_min: '1000',
          visa_sponsorship: 'false',
          q_fields: 'title,description',
          description_format: 'markdown',
          sort: 'created_at',
          order: 'desc',
          limit: '100',
          offset: '0',
        });
        assert.match(init.headers['User-Agent'], /lemuelflores\/job-hunter/);
        assert.ok(init.signal instanceof AbortSignal);
        return page(url, [job()]);
      },
    },
  );
  assert.deepEqual(outcome, { jobs: [job()], failures: [], total: 1 });
});

test('Freehire posting dates survive ingestion separately from discovery and rediscovery fills only unknown dates', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const posted = '2025-01-02T12:00:00Z';
  let data = [
    { ...job(1), posted_at: posted },
    { ...job(2), posted_at: null },
    { ...job(3), posted_at: 'invalid' },
    { ...job(4), posted_at: 123 },
    { ...job(5), posted_at: '2026-02-30T00:00:00Z' },
  ];
  const options = { fetch: async (url) => page(url, data) };
  await discoverFreehireJobs(store, config, options);
  const first = store.listReviewJobs('active').find((row) => row.id === 1);
  assert.equal(first.posted_at, '2025-01-02T12:00:00.000Z');
  assert.ok(first.first_seen > first.posted_at);
  for (const id of [2, 3, 4, 5]) assert.equal(store.getJob(id).posted_at, null);
  const before = store.getJob(2);
  data = [
    { ...job(1), posted_at: '2026-10-20T00:00:00Z' },
    { ...job(2), posted_at: posted },
  ];
  await discoverFreehireJobs(store, config, options);
  assert.equal(store.getJob(1).posted_at, first.posted_at);
  assert.equal(store.getJob(1).first_seen, first.first_seen);
  assert.equal(store.getJob(2).posted_at, first.posted_at);
  assert.equal(store.getJob(2).listing_text, before.listing_text);
});

test('pagination scans beyond 100 raw rows to the end and retains pages on error', async () => {
  let calls = 0;
  let outcome = await searchFreehire(
    { ...config, limit: 40 },
    {
      fetch: async (url) => {
        calls++;
        const size = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        assert.equal(offset, (calls - 1) * 40);
        return page(
          url,
          Array.from({ length: Math.min(size, 205 - offset) }, (_, i) =>
            offset + i === 40 ? null : job(offset + i),
          ),
          205,
        );
      },
    },
  );
  assert.equal(calls, 6);
  assert.equal(outcome.jobs.length, 204);
  assert.deepEqual(outcome.jobs.at(-1), job(204));
  assert.deepEqual(outcome.failures, []);
  calls = 0;
  outcome = await searchFreehire(
    { ...config, limit: 2 },
    {
      fetch: async (url) =>
        ++calls === 1
          ? page(url, [job(), null], 5)
          : new Response('', { status: 503 }),
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(outcome.jobs, [job()]);
  assert.match(outcome.failures[0], /503/);
  calls = 0;
  await searchFreehire(config, {
    fetch: async (url) => {
      calls++;
      return page(url, [], 50);
    },
  });
  assert.equal(calls, 1);
});

test('Freehire forwards new settings and refuses API-reported ignored names and values', async () => {
  for (const warning of [
    { ignored_params: ['future_filter'] },
    { ignored_values: { work_mode: ['future-mode'] } },
  ]) {
    const outcome = await searchFreehire(
      { ...config, future_filter: ['new-value'], work_mode: ['future-mode'] },
      {
        fetch: async (url) => {
          assert.equal(url.searchParams.get('future_filter'), 'new-value');
          assert.equal(url.searchParams.get('work_mode'), 'future-mode');
          return page(url, [job()], 1, warning);
        },
      },
    );
    assert.deepEqual(outcome.jobs, []);
    assert.match(outcome.failures[0], /Freehire ignored search settings/);
  }
});

test('Freehire forwards configured date filters and native paging/sorting without an age cap', async () => {
  const outcome = await searchFreehire(
    {
      ...config,
      open_within_days: 30,
      posted_within_days: 5,
      limit: 25,
      offset: 50,
      sort: 'posted_at',
      order: 'asc',
    },
    {
      fetch: async (url) => {
        assert.equal(url.searchParams.get('open_within_days'), '30');
        assert.equal(url.searchParams.get('posted_within_days'), '5');
        assert.equal(url.searchParams.get('offset'), '50');
        assert.equal(url.searchParams.get('limit'), '25');
        assert.equal(url.searchParams.get('sort'), 'posted_at');
        assert.equal(url.searchParams.get('order'), 'asc');
        return page(url, [job()], 51);
      },
    },
  );
  assert.deepEqual(outcome.jobs, [job()]);
});

test('Freehire retains results and reports unfinished work at the upstream pagination boundary', async () => {
  let calls = 0;
  const outcome = await searchFreehire(
    { ...config, offset: 9950, limit: 40 },
    {
      fetch: async (url) => {
        calls++;
        assert.equal(
          Number(url.searchParams.get('offset')),
          calls === 1 ? 9950 : 9990,
        );
        assert.equal(
          Number(url.searchParams.get('limit')),
          calls === 1 ? 40 : 10,
        );
        return page(
          url,
          Array.from(
            { length: Number(url.searchParams.get('limit')) },
            (_, i) => job(i),
          ),
          10001,
        );
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(outcome.jobs.length, 50);
  assert.match(outcome.failures[0], /pagination boundary reached/);
});

test('boundary skips malformed rows but refuses containers, ignored settings and invalid pagination', async () => {
  const valid = await searchFreehire(config, {
    fetch: async (url) =>
      page(url, [
        job(),
        null,
        {},
        { ...job(), description: '' },
        { ...job(), description: 42 },
        { ...job(), title: ' ' },
        { ...job(), location: 42 },
        { ...job(), countries: 'US' },
        { ...job(), regions: [42] },
        { ...job(), work_mode: {} },
      ]),
  });
  assert.deepEqual(valid.jobs, [job()]);
  for (const body of [
    null,
    [],
    {},
    { data: {}, meta: {} },
    { data: [], meta: { total: '1', limit: 100, offset: 0 } },
    { data: [job()], meta: { total: 1, limit: 99, offset: 0 } },
    {
      data: [job()],
      meta: {
        total: 1,
        limit: 100,
        offset: 0,
        ignored_params: [{ param: 'skills' }],
      },
    },
    {
      data: [job()],
      meta: {
        total: 1,
        limit: 100,
        offset: 0,
        ignored_values: { work_mode: ['foo'] },
      },
    },
  ]) {
    const outcome = await searchFreehire(config, {
      fetch: async () => Response.json(body),
    });
    assert.equal(outcome.jobs.length, 0);
    assert.match(
      outcome.failures[0],
      /Invalid Freehire|ignored search settings/,
    );
  }
});

test('Freehire accepts missing or null optional listing metadata', async () => {
  const listing = {
    ...job(),
    company: null,
    location: null,
    countries: null,
    regions: null,
    work_mode: null,
  };
  const outcome = await searchFreehire(config, {
    fetch: async (url) => page(url, [listing]),
  });
  assert.deepEqual(outcome.jobs, [listing]);
  assert.deepEqual(outcome.failures, []);
});

test('HTTP errors, exhausted rate budgets, cancellation and timeout preserve explicit failures', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    const outcome = await searchFreehire(config, {
      fetch: async () =>
        new Response('', { status, headers: { 'Retry-After': '60' } }),
    });
    assert.match(
      outcome.failures[0],
      new RegExp(`HTTP ${status}; retry after 60`),
    );
  }
  let calls = 0;
  const limited = await searchFreehire(
    { ...config, limit: 1 },
    {
      fetch: async (url) => {
        calls++;
        const response = page(url, [job()], 2);
        response.headers.set('X-RateLimit-Remaining', '0');
        response.headers.set('X-RateLimit-Reset', '10');
        return response;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(limited.jobs.length, 1);
  assert.match(limited.failures[0], /rate budget exhausted/);
  const controller = new AbortController();
  controller.abort(new Error('Stop ingestion'));
  assert.match(
    (
      await searchFreehire(config, {
        signal: controller.signal,
        fetch: async () => assert.fail('network'),
      })
    ).failures[0],
    /Stop ingestion/,
  );
  const during = new AbortController();
  const cancelled = await searchFreehire(config, {
    signal: during.signal,
    fetch: async (_url, init) => {
      during.abort(new Error('Cancelled during fetch'));
      init.signal.throwIfAborted();
    },
  });
  assert.match(cancelled.failures[0], /Cancelled during fetch/);
  // Keep the event loop alive while the native timeout's unref'ed timer fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const timed = await searchFreehire(config, {
      timeoutMs: 1,
      fetch: async (_url, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener(
            'abort',
            () => reject(init.signal.reason),
            { once: true },
          ),
        ),
    });
    assert.match(timed.failures[0], /timeout/i);
  } finally {
    clearInterval(keepAlive);
  }
});

test('URL acceptance reuses ATS identity without rewriting opaque original links', () => {
  assert.equal(
    normalizeFreehireUrl(
      'https://boards.greenhouse.io/example/jobs/1?source=freehire#top',
    ),
    result(1).url,
  );
  for (const url of [
    'https://careers.example.com/role?job=1&utm_source=freehire.me',
    'http://careers.example.com/role/1',
    'https://10.example.com/job',
    'https://job-boards.eu.greenhouse.io/example/jobs/1',
    'https://localhost/job',
    'http://127.0.0.1/job',
    'http://2130706433/job',
    'http://10.0.0.1/job',
    'http://192.168.1.1/job',
    'http://172.20.0.1/job',
    'http://[::1]/job',
    'https://example.com:8080/job',
    'https://jobs.lever.co/example',
    'https://jobs.ashbyhq.com/example/bad',
  ])
    assert.equal(normalizeFreehireUrl(url), url);
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@example.com/job',
    'https://user@example.com/job',
    'data:text/html,<script>alert(1)</script>',
    'not a url',
  ])
    assert.equal(normalizeFreehireUrl(url), null, url);
});

test('Freehire saves descriptions/checkpoints and both real assessments without extraction', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const original =
    'https://careers.example.com/role?id=1&utm_source=freehire.me';
  const metadata = {
    title: 'Freehire engineer',
    company: 'Example',
    location: 'United States',
    countries: ['US'],
    regions: ['north_america'],
    work_mode: 'hybrid',
  };
  const f = externalFixture(t, ({ url }) =>
    url.hostname === 'freehire.me'
      ? page(url, [
          { ...job(), ...metadata, url: original },
          { ...job(2), description: ' ' },
          { ...job(3), url: 'javascript:alert(1)' },
        ])
      : undefined,
  );
  const outcome = await discoverFreehireJobs(store, config);
  assert.equal(outcome.added, 1);
  assert.equal(store.getJob(1).url, original);
  assert.equal(store.getJob(1).title, 'Freehire engineer');
  assert.equal(store.getJob(1).source, 'freehire');
  assert.deepEqual(JSON.parse(store.getJob(1).query), config);
  const text = `Freehire listing metadata:\n${JSON.stringify(metadata)}\n\n${job().description}`;
  assert.equal(store.getJob(1).listing_text, text);
  assert.equal(store.stages(1)[0].state, 'complete');
  await checkLocation(store, 1, f.reviewLocation);
  await checkTech(store, 1, f.reviewStack);
  assert.equal(store.getJob(1).eligibility, 'ineligible');
  assert.equal(store.getJob(1).stack_status, 'match');
  assert.deepEqual(
    f.requests.map(({ url }) => url.hostname),
    ['freehire.me', 'chatgpt.com', 'chatgpt.com'],
  );
  for (const { body } of f.requests.slice(1))
    assert.ok(body.input[0].content[0].text.includes(text));
  const locationRequest = JSON.stringify(f.requests[1].body);
  const techRequest = JSON.stringify(f.requests[2].body);
  assert.ok(locationRequest.includes(profile.review.location));
  assert.ok(!locationRequest.includes(JSON.stringify(profile.review.stack)));
  assert.ok(
    f.requests[2].body.input[0].content[0].text.includes(
      JSON.stringify(profile.review.stack),
    ),
  );
  assert.ok(!techRequest.includes(profile.review.location));
});

test('Freehire keeps the original config snapshot when search settings change', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  let id = 1;
  const settings = {
    ...config,
    skills: ['php'],
    salary_min: 0,
    visa_sponsorship: false,
  };
  const original = JSON.stringify(settings);
  externalFixture(t, ({ url }) =>
    url.hostname === 'freehire.me' ? page(url, [job(1), job(id)]) : undefined,
  );
  await discoverFreehireJobs(store, settings);
  settings.skills.push('typescript');
  settings.salary_min = 1000;
  id = 2;
  await discoverFreehireJobs(store, settings);
  const rows = store.listReviewJobs('active');
  assert.equal(rows.find((row) => row.id === 1).query, original);
  assert.equal(
    rows.find((row) => row.id === 2).query,
    JSON.stringify(settings),
  );
  assert.ok(rows.every((row) => row.source === 'freehire'));
});

test('cross-source ingestion preserves canonical identities in both arrival orders and saved decisions', async (t) => {
  for (const first of ['google', 'freehire']) {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    externalFixture(t, ({ url }) => {
      if (url.hostname === 'freehire.me')
        return page(url, [
          {
            ...job(),
            url: 'https://boards.greenhouse.io/example/jobs/1?utm_source=freehire.me',
          },
        ]);
      if (url.hostname === 'api.autom.dev')
        return Response.json({
          organic_results: [{ link: result(1).url, title: 'Google engineer' }],
        });
    });
    const google = () => discoverGoogleJobs(store, profile);
    const freehire = () => discoverFreehireJobs(store, config);
    await (first === 'google' ? google() : freehire());
    const originalQuery = store.getJob(1).query;
    await (first === 'google' ? freehire() : google());
    assert.equal(store.getJob(1).source, first);
    assert.equal(store.getJob(1).query, originalQuery);
    assert.equal(
      originalQuery,
      first === 'google' ? profile.google.query : JSON.stringify(config),
    );
    assert.equal(store.listReviewJobs('active').length, 1);
    assert.ok(store.getJob(1).listing_text.endsWith(job().description));
    store.review(1, 'eligible', 'Keep decision');
    store.reviewStack(1, stack);
    store.setReviewStatus('1', 'hidden');
    const { last_seen: _before, ...before } = store.getJob(1);
    const stages = store.stages(1);
    await freehire();
    await google();
    const { last_seen: _after, ...after } = store.getJob(1);
    assert.deepEqual(after, before);
    assert.deepEqual(store.stages(1), stages);
  }
});

test('inactive, failed and terminal checkpoints stay unchanged; failed generations are not reset', () => {
  const store = new SqliteStore(':memory:');
  try {
    store.saveResults([1, 2, 3, 4].map(result));
    store.setReviewStatus('1', 'rejected');
    store.failStage(2, 'crawl', 'Exhausted', true);
    store.terminalCrawl(3, 'Gone');
    store.failStage(4, 'crawl', 'Old error', true);
    store.resetStage(4, 'crawl');
    const before = [1, 2, 3].map((id) => ({
      stages: store.stages(id),
      job: store.getJob(id),
    }));
    store.saveResults(
      [1, 2, 3, 4].map((id) => ({
        ...result(id),
        listingText: job().description,
      })),
    );
    for (const id of [1, 2, 3]) {
      assert.equal(store.getJob(id).listing_text, null);
      assert.deepEqual(store.stages(id), before[id - 1].stages);
      assert.equal(store.getJob(id).status, before[id - 1].job.status);
    }
    assert.equal(store.getJob(4).listing_text, job().description);
    assert.equal(store.stages(4)[0].generation, 1);
  } finally {
    store.close();
  }
});

test('description ingestion rolls back the whole local transaction on an invalid checkpoint', () => {
  const store = new SqliteStore(':memory:');
  try {
    assert.throws(
      () =>
        store.saveResults([
          { ...result(1), listingText: job().description },
          { ...result(2), listingText: ' ' },
        ]),
      /Invalid listing text/,
    );
    assert.equal(store.getJob(1), undefined);
    assert.deepEqual(store.stages(1), []);
    store.saveResults([{ ...result(1), listingText: job().description }]);
    assert.equal(store.stages(1)[0].state, 'complete');
    assert.equal(store.needsStage(1, 'location'), true);
    assert.equal(store.needsStage(1, 'stack'), true);
  } finally {
    store.close();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATS_DEFINITIONS,
  createGoogleSearch,
  GOOGLE_ATS,
} from '../dist/entrypoints/compose.js';
import {
  normalizeGoogleQuery,
  scopedGoogleQuery,
} from '../dist/integrations/search/google.js';

test('explicit query only collapses whitespace, without hidden filters or aliases', () => {
  assert.equal(
    normalizeGoogleQuery(' \n title:"nurse"\t OR "on-site"\n -agency  '),
    'title:"nurse" OR "on-site" -agency',
  );
  for (const query of ['', ' \n ', undefined, 42])
    assert.throws(() => normalizeGoogleQuery(query), /query is required/);
});

test('root base query retains the existing user search terms without ATS hosts', async () => {
  const profile = (await import('../profile.ts')).default;
  const query = normalizeGoogleQuery(profile.google.query);
  for (const term of [
    'fullstack',
    'full stack',
    'full-stack',
    'back end',
    'back-end',
    'front end',
    'front-end',
    'web',
    'developer',
    'engineer',
    'Laravel',
    'PHP',
    'Vue.js',
    'VueJS',
    'Nuxt.js',
    'NuxtJS',
    'Node.js',
    'NodeJS',
    'Node',
    'JavaScript',
    'TypeScript',
    'remote-first',
    'fully remote',
    'anywhere in the world',
    'work from home',
    'APAC',
    'Asia',
    'SEA',
    'Philippines',
  ])
    assert.ok(query.includes(term), term);
  assert.ok(!query.includes('site:'));
});

for (const ats of ATS_DEFINITIONS) {
  test(`${ats.selector} sends the domain restriction before the long profile query`, async (t) => {
    const profile = (await import('../profile.ts')).default;
    const scope = `(${ats.hosts
      .map((host) => `site:${host.replace(/^\*\./, '')}`)
      .join(' OR ')})`;
    const logs = [];
    t.mock.method(console, 'error', (message) => logs.push(message));
    const key = process.env.AUTOM_API_KEY;
    process.env.AUTOM_API_KEY = 'test-key';
    t.after(() => {
      if (key === undefined) delete process.env.AUTOM_API_KEY;
      else process.env.AUTOM_API_KEY = key;
    });
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(
        url.searchParams.get('query'),
        `${scope} (${normalizeGoogleQuery(profile.google.query)})`,
      );
      return Response.json({ organic_results: [] });
    });
    const outcome = await createGoogleSearch(profile.google, ats.selector)();
    assert.deepEqual(outcome.failures, []);
    assert.ok(logs[0].startsWith(`[google:${ats.selector}] page 1:`));
  });
}

test('each ATS scopes the complete normalized base query to only its host group', () => {
  assert.ok(GOOGLE_ATS.includes('workable'));
  assert.equal(
    scopedGoogleQuery(
      'engineer',
      ATS_DEFINITIONS.find((ats) => ats.selector === 'workable').hosts,
    ),
    '(site:apply.workable.com) (engineer)',
  );
  for (const ats of ATS_DEFINITIONS) {
    assert.equal(
      scopedGoogleQuery(
        ' engineer\n OR developer Laravel (APAC OR worldwide) ',
        ats.hosts,
      ),
      `(${ats.hosts
        .map((host) => `site:${host.replace(/^\*\./, '')}`)
        .join(' OR ')}) (engineer OR developer Laravel (APAC OR worldwide))`,
    );
  }
  assert.throws(
    () => createGoogleSearch({ enabled: true, query: 'engineer' }, 'unknown'),
    /Unknown ATS/,
  );
  for (const query of [
    'site:example.com engineer',
    '(SITE:example.com)',
    '-site:example.com',
  ])
    assert.throws(
      () => scopedGoogleQuery(query, ATS_DEFINITIONS[0].hosts),
      /must not contain site:/,
    );
});

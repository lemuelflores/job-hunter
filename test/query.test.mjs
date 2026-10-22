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

test('each ATS scopes the complete normalized base query to only its host group', () => {
  assert.ok(GOOGLE_ATS.includes('workable'));
  assert.equal(
    scopedGoogleQuery(
      'engineer',
      ATS_DEFINITIONS.find((ats) => ats.selector === 'workable').hosts,
    ),
    '(engineer) (site:apply.workable.com)',
  );
  for (const ats of ATS_DEFINITIONS) {
    assert.equal(
      scopedGoogleQuery(
        ' engineer\n OR developer Laravel (APAC OR worldwide) ',
        ats.hosts,
      ),
      `(engineer OR developer Laravel (APAC OR worldwide)) (${ats.hosts
        .map((host) => `site:${host}`)
        .join(' OR ')})`,
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

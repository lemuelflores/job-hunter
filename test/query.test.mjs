import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGoogleQuery } from '../dist/discovery/google.js';

test('explicit query only collapses whitespace, without hidden filters or aliases', () => {
  assert.equal(
    normalizeGoogleQuery(' \n title:"nurse"\t OR "on-site"\n -agency  '),
    'title:"nurse" OR "on-site" -agency',
  );
  for (const query of ['', ' \n ', undefined, 42])
    assert.throws(() => normalizeGoogleQuery(query), /query is required/);
});

test('root query retains the existing user search terms and all supported ATS hosts', async () => {
  const profile = (await import('../profile.ts')).default;
  const query = normalizeGoogleQuery(profile.google.query);
  for (const term of [
    'jobs.ashbyhq.com',
    'jobs.lever.co',
    'jobs.eu.lever.co',
    'boards.greenhouse.io',
    'job-boards.greenhouse.io',
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
});

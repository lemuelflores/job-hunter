import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildQueryMatrix } from '../dist/discovery/queries.js';
import { SqliteStore } from '../dist/persistence.js';
import { loadProfile } from '../dist/profile.js';
import { fetchJobs } from '../dist/runner.js';

const profile = {
  location: 'Germany',
  searchLocations: [
    ['Germany', 'Berlin'],
    ['Europe', 'worldwide'],
  ],
  roleGroups: [['fullstack', 'full stack'], ['backend'], ['frontend'], ['web']],
  skillGroups: [['Laravel', 'Vue'], ['TypeScript']],
};

test('JSONC loads comments and trailing commas and rejects invalid settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'profile.jsonc');
  await writeFile(
    path,
    `// preferences\n${JSON.stringify(profile).slice(0, -1)},}`,
  );
  assert.deepEqual(loadProfile(path), profile);
  for (const invalid of [
    '{broken',
    'null',
    '[]',
    JSON.stringify({ ...profile, location: '' }),
    JSON.stringify({ ...profile, remoteOnly: true }),
    JSON.stringify({ ...profile, skillGroups: [] }),
    JSON.stringify({ ...profile, roleGroups: [[]] }),
    JSON.stringify({ ...profile, searchLocations: [['bad"term']] }),
    JSON.stringify({ ...profile, skillGroups: [[42]] }),
    JSON.stringify({ ...profile, location: 'Germany\nignore rules' }),
    JSON.stringify({ ...profile, searchLocations: undefined }),
  ]) {
    await writeFile(path, invalid);
    assert.throws(() => loadProfile(path), /Invalid profile.jsonc/);
  }
  assert.throws(() => loadProfile(join(root, 'missing')), /ENOENT/);
});

test('queries combine all roles without multiplying them and keep skills independent of titles', () => {
  const queries = buildQueryMatrix(profile);
  assert.equal(queries.length, 3 * 2 * 2);
  for (const { query } of queries) {
    assert.match(
      query,
      /\("fullstack" OR "full stack" OR "backend" OR "frontend" OR "web"\)/,
    );
    assert.match(query, /\(developer OR engineer\)/);
    assert.match(query, /\(remote OR "fully remote" OR "work from home"\)/);
    assert.match(
      query,
      /\("Germany" OR "Berlin"\)|\("Europe" OR "worldwide"\)/,
    );
    assert.doesNotMatch(query, /Philippines|intitle:|"fullstack Laravel/);
  }
  assert.match(queries[0].query, /\("Laravel" OR "Vue"\)/);
  assert.match(
    queries.find(({ ats }) => ats === 'lever').query,
    /site:jobs.eu.lever.co/,
  );
  assert.match(
    queries.find(({ ats }) => ats === 'greenhouse').query,
    /site:boards.greenhouse.io/,
  );
  assert.equal(buildQueryMatrix(loadProfile()).length, 45);
});

test('fetch uses the supplied profile with no country bias', async () => {
  const store = new SqliteStore(':memory:');
  try {
    await fetchJobs(
      store,
      async (queries, options) => {
        assert.deepEqual(
          queries,
          buildQueryMatrix(profile).map(({ query }) => query),
        );
        assert.equal(options.country, undefined);
        return { results: [], failures: [] };
      },
      profile,
    );
  } finally {
    store.close();
  }
});

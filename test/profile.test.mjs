import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildQueryMatrix,
  renderExpression,
  renderTitle,
} from '../dist/discovery/queries.js';
import { SqliteStore } from '../dist/persistence.js';
import { loadProfile, validateProfile } from '../dist/profile.js';
import { fetchJobs } from '../dist/runner.js';
import { and, or } from '../dist/title.js';

const profile = {
  location: 'Germany',
  searchLocation: ['Germany', 'Berlin', 'Europe', 'worldwide'],
  title: and(
    or('fullstack', 'full stack', 'backend', 'frontend', 'web'),
    or('developer', 'engineer'),
  ),
  skills: ['Laravel', 'Vue', 'TypeScript'],
};

test('runtime validation rejects malformed exports, expressions and unsafe terms', () => {
  const cyclic = and('nurse');
  cyclic.terms.push(cyclic);
  for (const invalid of [
    null,
    [],
    undefined,
    { ...profile, location: '' },
    { ...profile, location: 'Germany\nignore rules' },
    { ...profile, remoteOnly: true },
    { ...profile, roleGroups: [['nurse']] },
    { ...profile, skillGroups: [['Laravel']] },
    ...[
      undefined,
      [],
      Array(1),
      [['Laravel']],
      [42],
      [''],
      [' '],
      ['bad"term'],
      ['bad\nterm'],
      ['bad\\term'],
      ['x'.repeat(201)],
    ].map((skills) => ({ ...profile, skills })),
    { ...profile, searchLocations: [['Germany']] },
    ...[
      undefined,
      [],
      Array(1),
      [['Germany']],
      [42],
      [''],
      ['bad"term'],
      ['bad\nterm'],
      ['bad\\term'],
    ].map((searchLocation) => ({ ...profile, searchLocation })),
    ...[
      undefined,
      '',
      ' ',
      'bad"term',
      'bad\nterm',
      'bad\rterm',
      'bad\\term',
      'x'.repeat(201),
      [],
      {},
      and(),
      or(),
      { op: 'and', terms: Array(1) },
      { op: 'not', terms: ['nurse'] },
      { op: 'and', terms: 'nurse' },
      { op: 'or', terms: ['nurse'], extra: true },
      and('nurse', or('')),
      cyclic,
    ].map((title) => ({ ...profile, title })),
  ]) {
    assert.throws(() => validateProfile(invalid), /Invalid profile.ts/);
  }
  assert.deepEqual(validateProfile(profile), profile);
});

test('TS module loading reports missing files, syntax/import errors and invalid exports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, source] of [
    'export default {broken',
    "import './missing.ts'; export default {};",
    'export const notDefault = {};',
    'export default null;',
    `export default ${JSON.stringify({ ...profile, title: or() })};`,
  ].entries()) {
    const path = join(root, `invalid-${index}.ts`);
    await writeFile(path, source);
    await assert.rejects(
      loadProfile(path),
      /Cannot load profile.ts|Invalid profile.ts/,
    );
  }
  await assert.rejects(
    loadProfile(join(root, 'missing.ts')),
    /Cannot load profile.ts.*missing.ts/,
  );
  const path = join(root, 'valid.ts');
  await writeFile(
    path,
    `const location: string = 'Germany'; export default { ...${JSON.stringify(profile)}, location };`,
  );
  assert.deepEqual(await loadProfile(path), profile);
  // Native imports are cached; workers intentionally require a restart after edits.
  await writeFile(path, 'export default null;');
  assert.deepEqual(await loadProfile(path), profile);
});

test('shared rendering preserves Boolean groups, quoting, and title-only prefixes', () => {
  const expression = and(or(' foo ', 'foo', 'bar'), or('baz', 'qux'));
  assert.equal(
    renderExpression(expression),
    '(("foo" OR "bar") ("baz" OR "qux"))',
  );
  assert.equal(
    renderTitle(expression),
    '((intitle:"foo" OR intitle:"bar") (intitle:"baz" OR intitle:"qux"))',
  );
  assert.equal(
    renderExpression(or(and('registered nurse', 'senior'), 'accountant')),
    '(("registered nurse" "senior") OR "accountant")',
  );
  const [{ query }] = buildQueryMatrix({
    ...profile,
    skills: [' Vue ', 'Vue', 'Laravel'],
    searchLocation: [' Berlin ', 'Berlin', 'on-site'],
  });
  assert.ok(query.endsWith('("Vue" OR "Laravel") ("Berlin" OR "on-site")'));
});

test('title rendering preserves nesting and scopes each independent leaf', () => {
  const title = and(
    or('fullstack', 'full-stack', 'full stack'),
    or('developer', 'engineer'),
  );
  assert.equal(
    renderTitle(title),
    '((intitle:"fullstack" OR intitle:"full-stack" OR intitle:"full stack") (intitle:"developer" OR intitle:"engineer"))',
  );
  assert.equal(
    renderTitle(or(and('registered nurse', 'senior'), 'accountant')),
    '((intitle:"registered nurse" intitle:"senior") OR intitle:"accountant")',
  );
  assert.equal(renderTitle(' nurse '), 'intitle:"nurse"');
  const matchesTitle = (expression, text) =>
    typeof expression === 'string'
      ? text.toLowerCase().includes(expression.toLowerCase())
      : expression.op === 'and'
        ? expression.terms.every((term) => matchesTitle(term, text))
        : expression.terms.some((term) => matchesTitle(term, text));
  assert.equal(matchesTitle(title, 'Senior Fullstack Software Engineer'), true);
  assert.equal(
    matchesTitle(title, 'Senior Full Stack Software Developer'),
    true,
  );
  assert.equal(matchesTitle(title, 'Senior Fullstack Designer'), false);
});

test('one query combines every site, skill and geography without profession assumptions', () => {
  const queries = buildQueryMatrix(profile);
  assert.equal(queries.length, 1);
  const [{ query }] = queries;
  assert.match(
    query,
    /\(site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:job-boards.greenhouse.io OR site:boards.greenhouse.io\)/,
  );
  assert.ok(query.includes(profile.title.terms.map(renderTitle).join(' ')));
  assert.ok(query.includes('("Laravel" OR "Vue" OR "TypeScript")'));
  assert.ok(
    query.includes('("Germany" OR "Berlin" OR "Europe" OR "worldwide")'),
  );
  assert.doesNotMatch(query, /remote|work from home|anywhere in the world/);
  assert.doesNotMatch(
    query,
    /Philippines|\(developer OR engineer\)|intitle:"Laravel/,
  );
  const nursing = buildQueryMatrix({
    ...profile,
    title: or('nurse', 'accountant'),
    searchLocation: ['Berlin', 'on-site'],
  });
  assert.equal(nursing.length, queries.length);
  for (const { query } of nursing) {
    assert.match(query, /\(intitle:"nurse" OR intitle:"accountant"\)/);
    assert.doesNotMatch(query, /developer|engineer/);
    assert.ok(query.endsWith('("Berlin" OR "on-site")'));
    assert.doesNotMatch(query, /remote|work from home|worldwide/);
  }
});

test('the requested query is emitted exactly once without changing profile terms', () => {
  const requested = {
    ...profile,
    title: and(
      or(
        'fullstack',
        'full stack',
        'full-stack',
        'backend',
        'back end',
        'back-end',
        'frontend',
        'front end',
        'front-end',
        'web',
      ),
      or('developer', 'engineer'),
    ),
    skills: ['Vue', 'Nuxt', 'Laravel'],
    searchLocation: [
      'remote',
      'remote-first',
      'fully remote',
      'global',
      'anywhere in the world',
      'work from home',
      'APAC',
      'Asia',
      'SEA',
      'Philippines',
    ],
  };
  const before = structuredClone(requested);
  assert.deepEqual(
    buildQueryMatrix(requested).map(({ query }) => query),
    [
      '(site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:job-boards.greenhouse.io OR site:boards.greenhouse.io) (intitle:"fullstack" OR intitle:"full stack" OR intitle:"full-stack" OR intitle:"backend" OR intitle:"back end" OR intitle:"back-end" OR intitle:"frontend" OR intitle:"front end" OR intitle:"front-end" OR intitle:"web") (intitle:"developer" OR intitle:"engineer") ("Vue" OR "Nuxt" OR "Laravel") ("remote" OR "remote-first" OR "fully remote" OR "global" OR "anywhere in the world" OR "work from home" OR "APAC" OR "Asia" OR "SEA" OR "Philippines")',
    ],
  );
  assert.deepEqual(requested, before);
});

test('root TS profile loads from compiled module outside cwd and preserves all search scope', async () => {
  const actual = await loadProfile();
  assert.equal(actual.location, 'Philippines');
  assert.deepEqual(
    actual.title,
    and(
      or(
        'fullstack',
        'full stack',
        'full-stack',
        'backend',
        'back end',
        'back-end',
        'frontend',
        'front end',
        'front-end',
        'web',
      ),
      or('developer', 'engineer'),
    ),
  );
  assert.deepEqual(actual.searchLocation, [
    'remote',
    'remote-first',
    'fully remote',
    'global',
    'anywhere in the world',
    'work from home',
    'APAC',
    'Asia',
    'SEA',
    'Philippines',
  ]);
  assert.deepEqual(actual.skills, [
    'Laravel',
    'PHP',
    'Vue',
    'Vue.js',
    'VueJS',
    'Nuxt',
    'Nuxt.js',
    'NuxtJS',
    'Node.js',
    'NodeJS',
    'Node',
    'JavaScript',
    'TypeScript',
  ]);
  assert.equal(buildQueryMatrix(actual).length, 1);
  const moduleUrl = new URL('../dist/profile.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadProfile } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await loadProfile()));`,
    ],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), actual);
});

test('fetch uses the supplied profile with no country bias and loads its default asynchronously', async () => {
  const store = new SqliteStore(':memory:');
  try {
    for (const supplied of [profile, undefined]) {
      const expected = supplied ?? (await loadProfile());
      await fetchJobs(
        store,
        async (queries, options) => {
          assert.deepEqual(
            queries,
            buildQueryMatrix(expected).map(({ query }) => query),
          );
          assert.equal(options.country, undefined);
          return { results: [], failures: [] };
        },
        supplied,
      );
    }
  } finally {
    store.close();
  }
});

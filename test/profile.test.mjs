import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchJobs } from '../dist/discovery/discover-jobs.js';
import {
  buildQueryMatrix,
  renderExpression,
  renderTitle,
} from '../dist/discovery/google.js';
import { loadProfile, validateProfile } from '../dist/profile.js';
import { SqliteStore } from '../dist/sqlite.js';

const profile = {
  location: 'Germany',
  searchLocation: ['Germany', 'Berlin', 'Europe', 'worldwide'],
  title: [
    { fullstack: ['full stack'], backend: [], frontend: [], web: [] },
    { developer: [], engineer: [] },
  ],
  skills: [{ Laravel: [], Vue: [], TypeScript: [] }],
};

test('runtime validation rejects malformed exports, expressions and unsafe terms', () => {
  const cyclic = {};
  cyclic.nurse = [cyclic];
  const malformedGroups = [
    undefined,
    '',
    'nurse',
    [],
    Array(1),
    {},
    [{}],
    [null],
    [42],
    ['nurse'],
    [['nurse']],
    [new Date()],
    [new Map([['nurse', []]])],
    [{ nurse: undefined }],
    [{ nurse: 'alias' }],
    [{ nurse: {} }],
    [{ nurse: Array(1) }],
    [{ nurse: [42] }],
    [{ nurse: [['alias']] }],
    { op: 'and', terms: ['nurse'] },
    [cyclic],
    ...[
      '',
      ' ',
      'bad"term',
      'bad\nterm',
      'bad\rterm',
      'bad\\term',
      'x'.repeat(201),
    ].flatMap((term) => [[{ [term]: [] }], [{ nurse: [term] }]]),
  ];
  for (const invalid of [
    null,
    [],
    undefined,
    { ...profile, location: '' },
    { ...profile, location: 'Germany\nignore rules' },
    { ...profile, remoteOnly: true },
    { ...profile, roleGroups: [['nurse']] },
    { ...profile, skillGroups: [['Laravel']] },
    ...malformedGroups.map((skills) => ({ ...profile, skills })),
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
    ...malformedGroups.map((title) => ({ ...profile, title })),
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
    `export default ${JSON.stringify({ ...profile, title: [{}] })};`,
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
  const expression = [{ ' foo ': ['foo', 'bar'], bar: [] }, { baz: ['qux'] }];
  assert.equal(
    renderExpression(expression),
    '("foo" OR "bar") ("baz" OR "qux")',
  );
  assert.equal(
    renderTitle(expression),
    '(intitle:"foo" OR intitle:"bar") (intitle:"baz" OR intitle:"qux")',
  );
  assert.equal(
    renderExpression([
      { 'registered nurse': [], accountant: [] },
      { senior: [] },
    ]),
    '("registered nurse" OR "accountant") ("senior")',
  );
  const [{ query }] = buildQueryMatrix({
    ...profile,
    skills: [{ ' Vue ': ['Vue'], Laravel: [] }],
    searchLocation: [' Berlin ', 'Berlin', 'on-site'],
  });
  assert.ok(query.endsWith('("Vue" OR "Laravel") ("Berlin" OR "on-site")'));
});

test('title rendering includes canonical keys, aliases, and every AND group', () => {
  const title = [
    { fullstack: ['full-stack', 'full stack'] },
    { developer: [], engineer: [] },
  ];
  assert.equal(
    renderTitle(title),
    '(intitle:"fullstack" OR intitle:"full-stack" OR intitle:"full stack") (intitle:"developer" OR intitle:"engineer")',
  );
  assert.equal(
    renderTitle([{ backend: ['back-end'], frontend: [] }, { engineer: [] }]),
    '(intitle:"backend" OR intitle:"back-end" OR intitle:"frontend") (intitle:"engineer")',
  );
  assert.equal(renderTitle([{ ' nurse ': [] }]), '(intitle:"nurse")');
});

test('one query combines every site, skill and geography without profession assumptions', () => {
  const queries = buildQueryMatrix(profile);
  assert.equal(queries.length, 1);
  const [{ query }] = queries;
  assert.match(
    query,
    /\(site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:job-boards.greenhouse.io OR site:boards.greenhouse.io\)/,
  );
  assert.ok(query.includes(renderTitle(profile.title)));
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
    title: [{ nurse: [], accountant: [] }],
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
    title: [
      {
        fullstack: ['full stack', 'full-stack'],
        backend: ['back end', 'back-end'],
        frontend: ['front end', 'front-end'],
        web: [],
      },
      { developer: [], engineer: [] },
    ],
    skills: [{ Vue: [], Nuxt: [], Laravel: [] }],
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

test('skill groups AND canonical and alias alternatives without title prefixes', () => {
  const grouped = {
    ...profile,
    skills: [{ Laravel: ['PHP'], Vue: ['Vue.js'] }, { TypeScript: [] }],
  };
  assert.deepEqual(validateProfile(grouped), grouped);
  const [{ query }] = buildQueryMatrix(grouped);
  assert.ok(
    query.includes('("Laravel" OR "PHP" OR "Vue" OR "Vue.js") ("TypeScript")'),
  );
  assert.doesNotMatch(query, /intitle:"(?:Laravel|PHP|Vue|Vue.js|TypeScript)"/);
});

test('root TS profile loads from compiled module outside cwd and preserves all search scope', async () => {
  const actual = await loadProfile();
  const configured = (await import('../profile.ts')).default;
  assert.deepEqual(actual, configured);
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
        async () => {},
      );
    }
  } finally {
    store.close();
  }
});

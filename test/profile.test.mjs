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

// Shared Arrange: canonical grouped terms exercise applicant and search geography separately.
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
  // Arrange: cover malformed groups, unsafe terms and cyclic alias values.
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
    // Arrange: use each invalid profile from the table with the shared valid baseline.
    // Act / Assert: validation rejects every malformed shape with an actionable error.
    assert.throws(() => validateProfile(invalid), /Invalid profile.ts/);
  }
  // Act / Assert: the valid baseline is accepted unchanged.
  assert.deepEqual(validateProfile(profile), profile);
});

test('TS module loading reports missing files, syntax/import errors and invalid exports', async (t) => {
  // Arrange: isolate temporary TypeScript modules and remove them after the test.
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, source] of [
    'export default {broken',
    "import './missing.ts'; export default {};",
    'export const notDefault = {};',
    'export default null;',
    `export default ${JSON.stringify({ ...profile, title: [{}] })};`,
  ].entries()) {
    // Arrange: write this table case's broken module to its own import path.
    const path = join(root, `invalid-${index}.ts`);
    await writeFile(path, source);
    // Act / Assert: loading surfaces syntax, import and export validation failures.
    await assert.rejects(
      loadProfile(path),
      /Cannot load profile.ts|Invalid profile.ts/,
    );
  }
  // Act / Assert: a nonexistent module reports the missing path.
  await assert.rejects(
    loadProfile(join(root, 'missing.ts')),
    /Cannot load profile.ts.*missing.ts/,
  );
  // Arrange: write a valid module containing a TypeScript annotation.
  const path = join(root, 'valid.ts');
  await writeFile(
    path,
    `const location: string = 'Germany'; export default { ...${JSON.stringify(profile)}, location };`,
  );
  // Act / Assert: native TypeScript loading returns the expected profile.
  assert.deepEqual(await loadProfile(path), profile);
  // Native imports are cached; workers intentionally require a restart after edits.
  await writeFile(path, 'export default null;');
  // Act / Assert: a repeated import retains the cached valid export.
  assert.deepEqual(await loadProfile(path), profile);
});

test('shared rendering preserves Boolean groups, quoting, and title-only prefixes', () => {
  // Arrange: include whitespace, duplicate aliases and multiple AND groups.
  const expression = [{ ' foo ': ['foo', 'bar'], bar: [] }, { baz: ['qux'] }];
  // Act / Assert: render normalized alternatives with prefixes only for titles.
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
  // Act: render a complete query with duplicate skill and geography terms.
  const [{ query }] = buildQueryMatrix({
    ...profile,
    skills: [{ ' Vue ': ['Vue'], Laravel: [] }],
    searchLocation: [' Berlin ', 'Berlin', 'on-site'],
  });
  // Assert: skill and geography alternatives are trimmed and deduplicated.
  assert.ok(query.endsWith('("Vue" OR "Laravel") ("Berlin" OR "on-site")'));
});

test('title rendering includes canonical keys, aliases, and every AND group', () => {
  // Arrange: combine canonical titles, aliases and a separate occupation group.
  const title = [
    { fullstack: ['full-stack', 'full stack'] },
    { developer: [], engineer: [] },
  ];
  // Act / Assert: every canonical title and alias receives the title-only prefix.
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
  // Arrange: use the shared profile with no additional query configuration.
  // Act: build its combined ATS query.
  const queries = buildQueryMatrix(profile);
  // Assert: one query preserves all terms without injecting profession or remote defaults.
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
  // Act: build the same query shape for unrelated occupations and on-site geography.
  const nursing = buildQueryMatrix({
    ...profile,
    title: [{ nurse: [], accountant: [] }],
    searchLocation: ['Berlin', 'on-site'],
  });
  // Assert: changing occupations does not change query count or introduce defaults.
  assert.equal(nursing.length, queries.length);
  for (const { query } of nursing) {
    // Assert: each generated occupation query preserves only the requested scope.
    assert.match(query, /\(intitle:"nurse" OR intitle:"accountant"\)/);
    assert.doesNotMatch(query, /developer|engineer/);
    assert.ok(query.endsWith('("Berlin" OR "on-site")'));
    assert.doesNotMatch(query, /remote|work from home|worldwide/);
  }
});

test('the requested query is emitted exactly once without changing profile terms', () => {
  // Arrange: retain a snapshot of the full requested title, skill and geography scope.
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
  // Act / Assert: generate exactly the requested query and leave its input unchanged.
  assert.deepEqual(
    buildQueryMatrix(requested).map(({ query }) => query),
    [
      '(site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:jobs.eu.lever.co OR site:job-boards.greenhouse.io OR site:boards.greenhouse.io) (intitle:"fullstack" OR intitle:"full stack" OR intitle:"full-stack" OR intitle:"backend" OR intitle:"back end" OR intitle:"back-end" OR intitle:"frontend" OR intitle:"front end" OR intitle:"front-end" OR intitle:"web") (intitle:"developer" OR intitle:"engineer") ("Vue" OR "Nuxt" OR "Laravel") ("remote" OR "remote-first" OR "fully remote" OR "global" OR "anywhere in the world" OR "work from home" OR "APAC" OR "Asia" OR "SEA" OR "Philippines")',
    ],
  );
  assert.deepEqual(requested, before);
});

test('skill groups AND canonical and alias alternatives without title prefixes', () => {
  // Arrange: combine alternatives in one skill group with a required second group.
  const grouped = {
    ...profile,
    skills: [{ Laravel: ['PHP'], Vue: ['Vue.js'] }, { TypeScript: [] }],
  };
  // Act / Assert: validation accepts the grouped skill expression unchanged.
  assert.deepEqual(validateProfile(grouped), grouped);
  // Act: render the validated skill groups in a query.
  const [{ query }] = buildQueryMatrix(grouped);
  // Assert: skill alternatives retain AND grouping and never gain title prefixes.
  assert.ok(
    query.includes('("Laravel" OR "PHP" OR "Vue" OR "Vue.js") ("TypeScript")'),
  );
  assert.doesNotMatch(query, /intitle:"(?:Laravel|PHP|Vue|Vue.js|TypeScript)"/);
});

test('root TS profile loads from compiled module outside cwd and preserves all search scope', async () => {
  // Arrange: use the root profile resolved by the compiled loader without a path override.
  // Act: load the default profile and its source export.
  const actual = await loadProfile();
  const configured = (await import('../profile.ts')).default;
  // Assert: default loading preserves the configured search scope.
  assert.deepEqual(actual, configured);
  assert.equal(buildQueryMatrix(actual).length, 1);
  // Arrange: resolve the compiled module before starting outside the repository.
  const moduleUrl = new URL('../dist/profile.js', import.meta.url).href;
  // Act: load the profile in a child process whose cwd is the temporary directory.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { loadProfile } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await loadProfile()));`,
    ],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  // Assert: module-relative resolution succeeds and yields the same profile.
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), actual);
});

test('fetch uses the supplied profile with no country bias and loads its default asynchronously', async () => {
  // Arrange: isolate discovery state in an in-memory store, closed even on failure.
  const store = new SqliteStore(':memory:');
  try {
    for (const supplied of [profile, undefined]) {
      // Arrange: determine the expected scope for this explicit or default profile case.
      const expected = supplied ?? (await loadProfile());
      // Act: discover jobs with an injected search callback and no results to scrape.
      await fetchJobs(
        store,
        async (queries, options) => {
          // Assert: discovery forwards the profile queries without a country override.
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProfile, validateProfile } from '../dist/profile.js';

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

test('validation accepts grouped canonical skills and aliases unchanged', () => {
  // Arrange: combine skill alternatives with a second required group.
  const grouped = {
    ...profile,
    skills: [{ Laravel: ['PHP'], Vue: ['Vue.js'] }, { TypeScript: [] }],
  };
  // Act / Assert: validation preserves the expression.
  assert.deepEqual(validateProfile(grouped), grouped);
});

test('root TS profile loads from compiled module outside cwd and preserves all search scope', async () => {
  // Arrange: use the root profile resolved by the compiled loader without a path override.
  // Act: load the default profile and its source export.
  const actual = await loadProfile();
  const configured = (await import('../profile.ts')).default;
  // Assert: default loading preserves the configured search scope.
  assert.deepEqual(actual, configured);
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

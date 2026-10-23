import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProfile, validateProfile } from '../src/infra/config.ts';
import { profile } from './fixtures/workflow.mjs';

test('profile requires candidate location, flat stack and explicit source enablement', () => {
  assert.deepEqual(validateProfile(profile), profile);
  assert.deepEqual(
    validateProfile({ ...profile, google: { enabled: false, query: '' } })
      .google,
    { enabled: false, query: '' },
  );
  for (const [value, message] of [
    [null, /Invalid profile.ts: profile/],
    [[], /Invalid profile.ts/],
    [{ location: 'Germany', skills: [{ Laravel: [] }] }, /Invalid profile.ts/],
    [{ ...profile, old: true }, /old/],
    [{ ...profile, review: { prompt: 'Remote' } }, /review/],
    [
      {
        ...profile,
        review: { locationPrompt: 'Germany', techPrompt: 'Laravel' },
      },
      /review/,
    ],
    [
      { ...profile, review: { ...profile.review, location: ' ' } },
      /review.location/,
    ],
    [{ ...profile, review: { ...profile.review, stack: [] } }, /review.stack/],
    [{ ...profile, review: { location: 'Germany' } }, /review.stack/],
    [{ ...profile, review: { stack: ['Laravel'] } }, /review.location/],
    [
      { ...profile, review: { ...profile.review, extra: true } },
      /review.extra/,
    ],
    [{ ...profile, google: { query: 'engineer' } }, /google.enabled/],
    [{ ...profile, google: { enabled: true, query: '\n ' } }, /google.query/],
    [
      {
        ...profile,
        google: { enabled: true, query: 'site:jobs.ashbyhq.com engineer' },
      },
      /google.query.*site:/,
    ],
    [
      { ...profile, google: { ...profile.google, filters: {} } },
      /google.filters/,
    ],
    [{ ...profile, freehire: {} }, /freehire.enabled/],
  ])
    assert.throws(() => validateProfile(value), message);
  for (const location of [undefined, null, '', '\n ', 42])
    assert.throws(
      () =>
        validateProfile({
          ...profile,
          review: { ...profile.review, location },
        }),
      /review.location/,
    );
  for (const stack of [
    undefined,
    null,
    '',
    'Laravel',
    [],
    [''],
    [' '],
    [42],
    [['Laravel']],
    [{ Laravel: [] }],
    Array(1),
  ])
    assert.throws(
      () =>
        validateProfile({ ...profile, review: { ...profile.review, stack } }),
      /review.stack/,
    );
});

test('Freehire passes filter semantics upstream and validates only local requirements and serializable types', () => {
  const freehire = {
    enabled: true,
    q: 'title:"engineer" -junior OR developer',
    q_fields: ['title', 'description'],
    semantic: true,
    regions: ['apac', 'none'],
    cities: 'Manila',
    skills: ['php', 'laravel'],
    skills_mode: 'and',
    skills_exclude: 'dotnet',
    category: ['backend'],
    category_exclude: ['mobile'],
    work_mode_mode: 'or',
    countries: ['ph'],
    countries_exclude: ['in'],
    source: ['greenhouse'],
    collections: ['yc'],
    salary_min: 50000,
    salary_currency: 'USD',
    salary_period: ['year'],
    visa_sponsorship: false,
    requires_clearance: false,
    auto_apply_available: true,
    experience_years_max: 5,
    experience_include_unspecified: true,
    open_within_days: 14,
    posted_within_days: 14,
    sort: 'posted_at',
    order: 'desc',
    limit: 25,
    offset: 0,
    description_format: 'markdown',
  };
  assert.deepEqual(
    validateProfile({ ...profile, freehire }).freehire,
    freehire,
  );
  for (const filters of [
    { future_filter: ['new-value'] },
    { country: ['ph'] },
    { work_mode: ['unknown'] },
    { regions_mode: 'and' },
    { skills: [] },
    { skills: [''] },
    { salary_min: -1 },
    { salary_min: '100' },
    { visa_sponsorship: 'false' },
    { q_fields: 'title,salary' },
    { reality: ['fake'] },
    { skills_mode: 'xor' },
    { open_within_days: 30 },
    { posted_within_days: 14 },
  ]) {
    const freehire = { enabled: true, ...filters };
    assert.deepEqual(
      validateProfile({ ...profile, freehire }).freehire,
      freehire,
    );
  }
  for (const invalid of [
    { enabled: 'true' },
    { skills: Array(1) },
    { skills: [42] },
    { skills: { name: 'php' } },
    { skills: null },
    { limit: 101 },
    { limit: 0 },
    { limit: '25' },
    { limit: 1.5 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: 10000 },
    { description_format: 'html' },
  ])
    assert.throws(
      () =>
        validateProfile({
          ...profile,
          freehire: { enabled: true, ...invalid },
        }),
      /Invalid profile.ts:.*freehire/,
    );
});

test('module loading reports bad files and preserves native module caching', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, source] of [
    'export default {broken',
    "import './missing.ts'; export default {};",
    'export const notDefault = {};',
    'export default null;',
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
    `const location: string = ${JSON.stringify(profile.review.location)}; export default { ...${JSON.stringify(profile)}, review: { ...${JSON.stringify(profile.review)}, location } };`,
  );
  assert.deepEqual(await loadProfile(path), profile);
  await writeFile(path, 'export default null;');
  assert.deepEqual(await loadProfile(path), profile);
});

test('root profile loads relative to the application outside cwd', async () => {
  const actual = await loadProfile();
  assert.deepEqual(actual, (await import('../profile.ts')).default);
  const moduleUrl = new URL('../src/infra/config.ts', import.meta.url).href;
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

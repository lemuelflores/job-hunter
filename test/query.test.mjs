import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildQueryMatrix,
  renderExpression,
  renderTitle,
} from '../dist/discovery/google.js';

// Shared Arrange: applicant residence and discovery geography are separate inputs.
const profile = {
  location: 'Germany',
  searchLocation: ['Germany', 'Berlin', 'Europe', 'worldwide'],
  title: [
    { fullstack: ['full stack'], backend: [], frontend: [], web: [] },
    { developer: [], engineer: [] },
  ],
  skills: [{ Laravel: [], Vue: [], TypeScript: [] }],
};

test('shared rendering preserves Boolean groups, quoting, and title-only prefixes', () => {
  // Arrange: include whitespace, duplicate aliases and multiple AND groups.
  const expression = [{ ' foo ': ['foo', 'bar'], bar: [] }, { baz: ['qux'] }];
  // Act / Assert: normalize alternatives with prefixes only for titles.
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
  // Act: render duplicate skill and geography terms.
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
  // Arrange: use the shared profile without extra query configuration.
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
  // Act: build a query for unrelated occupations and on-site geography.
  const nursing = buildQueryMatrix({
    ...profile,
    title: [{ nurse: [], accountant: [] }],
    searchLocation: ['Berlin', 'on-site'],
  });
  // Assert: changing occupations does not introduce defaults or additional queries.
  assert.equal(nursing.length, queries.length);
  for (const { query } of nursing) {
    // Assert: each query preserves only the requested occupation and geography.
    assert.match(query, /\(intitle:"nurse" OR intitle:"accountant"\)/);
    assert.doesNotMatch(query, /developer|engineer/);
    assert.ok(query.endsWith('("Berlin" OR "on-site")'));
    assert.doesNotMatch(query, /remote|work from home|worldwide/);
  }
});

test('the requested query is emitted exactly once without changing profile terms', () => {
  // Arrange: retain the full requested title, skill and geography scope.
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
  // Act / Assert: emit exactly the requested query and leave its input unchanged.
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
  // Act: render the skill groups in a query.
  const [{ query }] = buildQueryMatrix(grouped);
  // Assert: skill alternatives retain AND grouping without title prefixes.
  assert.ok(
    query.includes('("Laravel" OR "PHP" OR "Vue" OR "Vue.js") ("TypeScript")'),
  );
  assert.doesNotMatch(query, /intitle:"(?:Laravel|PHP|Vue|Vue.js|TypeScript)"/);
});

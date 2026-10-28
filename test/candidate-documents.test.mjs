import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCandidateDocuments } from '../src/infra/candidate-documents.ts';

async function directory(t) {
  const root = await mkdtemp('/tmp/opencode/job-hunter-candidate-');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reads both mandatory documents afresh for each assessment', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'cv.md'), 'CV first');
  await writeFile(join(root, 'candidate-profile.md'), 'Profile');
  assert.deepEqual(await loadCandidateDocuments(root), {
    cv: 'CV first',
    profile: 'Profile',
  });
  await writeFile(join(root, 'cv.md'), 'CV revised');
  assert.deepEqual(await loadCandidateDocuments(root), {
    cv: 'CV revised',
    profile: 'Profile',
  });
});

for (const [name, files, expected] of [
  ['missing CV', [['candidate-profile.md', 'profile']], /cv\.md/],
  ['missing profile', [['cv.md', 'cv']], /candidate-profile\.md/],
  [
    'blank CV',
    [
      ['cv.md', ' \n'],
      ['candidate-profile.md', 'profile'],
    ],
    /cv\.md/,
  ],
  [
    'blank profile',
    [
      ['cv.md', 'cv'],
      ['candidate-profile.md', '\t'],
    ],
    /candidate-profile\.md/,
  ],
  [
    'invalid UTF-8 CV',
    [
      ['cv.md', Buffer.from([0xff])],
      ['candidate-profile.md', 'profile'],
    ],
    /cv\.md/,
  ],
  [
    'NUL in profile',
    [
      ['cv.md', 'cv'],
      ['candidate-profile.md', 'secret\0profile'],
    ],
    /candidate-profile\.md/,
  ],
]) {
  test(`rejects ${name} without reporting document content`, async (t) => {
    const root = await directory(t);
    await Promise.all(
      files.map(([path, contents]) => writeFile(join(root, path), contents)),
    );
    await assert.rejects(loadCandidateDocuments(root), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  });
}

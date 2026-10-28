import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { result } from './fixtures/workflow.mjs';

test('legacy backup survives upgrade, new work, rollback and reopening', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-upgrade-rehearsal-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'current.sqlite');
  const backup = join(root, 'legacy-backup.sqlite');
  const restored = join(root, 'restored.sqlite');
  let store = new SqliteStore(current);
  store.saveResults([result(1)]);
  store.saveListingText(1, 'Legacy source text');
  store.close();
  const legacy = new DatabaseSync(current);
  legacy.exec(`DELETE FROM job_stages WHERE stage='assessment';
    CREATE TABLE legacy_stages (job_id INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('crawl','location','stack')), state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,stage));
    INSERT INTO legacy_stages SELECT * FROM job_stages;
    DROP TABLE job_stages;
    ALTER TABLE legacy_stages RENAME TO job_stages;
    DROP TABLE job_assessments;`);
  legacy.close();
  await copyFile(current, backup);

  store = new SqliteStore(current);
  assert.equal(store.getJob(1).listing_text, 'Legacy source text');
  assert.equal(
    store.stages(1).some((stage) => stage.stage === 'assessment'),
    false,
  );
  assert.deepEqual(store.queueAssessmentBackfill(1), [1]);
  store.close();
  store = new SqliteStore(current);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  store.close();

  await copyFile(backup, restored);
  const rollback = new DatabaseSync(restored, { readOnly: true });
  assert.equal(
    rollback.prepare('SELECT listing_text FROM jobs WHERE id=1').get()
      .listing_text,
    'Legacy source text',
  );
  assert.equal(
    rollback
      .prepare("SELECT count(*) AS n FROM job_stages WHERE stage='assessment'")
      .get().n,
    0,
  );
  assert.match(
    rollback
      .prepare("SELECT sql FROM sqlite_master WHERE name='job_stages'")
      .get().sql,
    /'location','stack'/,
  );
  rollback.close();
});

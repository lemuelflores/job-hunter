import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';

function report() {
  return {
    company: null,
    role: null,
    summary: 'Build software.',
    schedule_manila: null,
    hard_stops: [],
    eligibility: [],
    requirements: [],
    compensation: { advertised: null, vs_profile: 'not_stated' },
    strengths: [],
    concerns: [],
    confidence: 'medium',
    decision_changing_questions: [],
    score: 4,
    verdict_reason: 'Strong fit.',
    verdict: 'Apply',
  };
}

function fixture(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/job',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  return store;
}

test('an unknown assessment location does not erase a previously saved location', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-location-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/job',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE jobs SET location=? WHERE id=1').run('Germany');
  db.close();
  store.saveListingText(1, 'Full listing');
  store.saveAssessment(1, { ...report(), location: null });
  assert.equal(store.getJob(1).location, 'Germany');
});

test('a completed assessment is saved with its version and cannot be overwritten', (t) => {
  const store = fixture(t);
  store.saveListingText(1, 'Full listing');
  assert.equal(store.activateAssessment(1), false);
  store.saveAssessment(1, report());
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
  assert.throws(
    () => store.saveAssessment(1, { ...report(), verdict: 'Skip' }),
    /not pending/,
  );
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

test('invalid assessments do not complete the stage or persist partial output', (t) => {
  const store = fixture(t);
  store.saveListingText(1, 'Full listing');
  store.activateAssessment(1);
  assert.throws(
    () => store.saveAssessment(1, { ...report(), score: 9 }),
    /Invalid assessment/,
  );
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
});

test('new assessment work requires saved extracted text before it is ready', (t) => {
  const store = fixture(t);
  assert.equal(store.activateAssessment(1), false);
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(store.needsStage(1, 'assessment'), false);
});

test('old stage migration retains historical states and schedules no assessment', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-assessment-migration-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/job',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  store.saveListingText(1, 'Saved full listing');
  store.setReviewStatus('1', 'hidden');
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DELETE FROM job_stages WHERE stage='assessment'");
  legacy.close();
  store = new SqliteStore(path);
  store.failStage(1, 'location', 'Previous failure', true);
  const before = store.getJob(1);
  const stages = store.stages(1);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE old_stages (job_id INTEGER NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL CHECK(stage IN ('crawl','location','stack')), state TEXT NOT NULL CHECK(state IN ('pending','complete','failed','terminal','blocked')), error TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,stage));
    INSERT INTO old_stages SELECT * FROM job_stages;
    DROP TABLE job_stages;
    ALTER TABLE old_stages RENAME TO job_stages;
    CREATE INDEX stage_state_index ON job_stages(state);
    CREATE TABLE stage_audit (job_id INTEGER NOT NULL);
    CREATE TRIGGER stage_audit_trigger AFTER UPDATE ON job_stages
      BEGIN INSERT INTO stage_audit(job_id) VALUES (NEW.job_id); END;`);
  db.close();
  const migrated = new SqliteStore(path);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.getJob(1), before);
  assert.deepEqual(migrated.stages(1), stages);
  assert.equal(migrated.getAssessment(1), undefined);
  assert.equal(migrated.activateAssessment(1), false);
  migrated.resetStage(1, 'location');
  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      verify
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('stage_state_index','stage_audit_trigger')",
        )
        .get().n,
      2,
    );
    assert.equal(
      verify.prepare('SELECT count(*) AS n FROM stage_audit').get().n,
      1,
    );
  } finally {
    verify.close();
  }
  const reopened = new SqliteStore(path);
  try {
    assert.deepEqual(reopened.stages(1), migrated.stages(1));
    assert.equal(reopened.getAssessment(1), undefined);
  } finally {
    reopened.close();
  }
});

test('a persistence failure rolls back assessment completion and permits a later retry', async (t) => {
  const root = await mkdtemp('/tmp/opencode/job-assessment-rollback-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(() => store.close());
  store.saveResults([
    {
      source: 'google',
      url: 'https://example.test/job',
      title: 'Engineer',
      query: 'remote',
    },
  ]);
  store.saveListingText(1, 'Saved full listing');
  store.activateAssessment(1);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fail_assessment BEFORE INSERT ON job_assessments BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;",
  );
  assert.throws(
    () => store.saveAssessment(1, report()),
    /fixture persistence failure/,
  );
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  db.exec('DROP TRIGGER fail_assessment');
  db.close();
  store.saveAssessment(1, report());
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessJob } from '../src/workflow/assess-job.ts';
import { backfillAssessments } from '../src/workflow/backfill-assessments.ts';
import { enqueueMissingStages } from '../src/workflow/enqueue.ts';
import { assessment } from './fixtures/workflow.mjs';

function fixture(t, prepare = () => {}) {
  const root = mkdtempSync('/tmp/opencode/job-backfill-history-');
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults(
    Array.from({ length: 6 }, (_, i) => ({
      source: 'google',
      url: `https://example.test/job/${i + 1}`,
      title: 'Engineer',
      query: 'remote',
    })),
  );
  for (const id of [1, 2, 3, 4, 5])
    store.saveListingText(id, `Full text ${id}`);
  store.setReviewStatus('4', 'hidden');
  store.setReviewStatus('5', 'rejected');
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM job_stages WHERE stage='assessment'");
  prepare(db);
  db.close();
  store = new SqliteStore(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

test('re-evaluation preserves the old assessment until a replacement succeeds', async (t) => {
  const store = fixture(t);
  store.activateAssessment(1);
  store.saveAssessment(1, assessment);
  store.queueReassessment(1);
  assert.deepEqual(store.getAssessment(1).assessment, assessment);
  await assessJob(
    store,
    1,
    async () => ({ cv: 'CV', profile: 'Profile' }),
    async ({ listingText }) => {
      assert.equal(listingText, 'Full text 1');
      return { ...assessment, summary: 'Updated summary' };
    },
  );
  assert.equal(store.getAssessment(1).assessment.summary, 'Updated summary');
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'complete',
  );
});

test('a failed re-evaluation retains the previous assessment', async (t) => {
  const store = fixture(t);
  store.activateAssessment(1);
  store.saveAssessment(1, assessment);
  store.queueReassessment(1);
  await assert.rejects(
    assessJob(
      store,
      1,
      async () => ({ cv: 'CV', profile: 'Profile' }),
      async () => {
        throw new Error('Model unavailable');
      },
    ),
    /Model unavailable/,
  );
  assert.deepEqual(store.getAssessment(1).assessment, assessment);
  assert.throws(() => store.queueReassessment(1), /not eligible/);
});

test('re-evaluation rejects incomplete or inactive listings', (t) => {
  const store = fixture(t);
  assert.throws(() => store.queueReassessment(1), /not eligible/);
  assert.throws(() => store.queueReassessment(4), /not eligible/);
  assert.throws(() => store.queueReassessment(99), /not eligible/);
});

test('backfill selects and queues the freshest listings first', async (t) => {
  const store = fixture(t, (db) => {
    db.exec(`UPDATE jobs SET posted_at='2025-01-01T00:00:00.000Z', first_seen='2026-01-01T00:00:00.000Z' WHERE id=1;
      UPDATE jobs SET posted_at=NULL, first_seen='2025-06-01T00:00:00.000Z' WHERE id=2;
      UPDATE jobs SET posted_at='2025-09-01T00:00:00.000Z', first_seen='2024-01-01T00:00:00.000Z' WHERE id=3`);
  });
  const deliveries = [];
  assert.deepEqual(store.previewAssessmentBackfill(2).selectedIds, [3, 2]);
  assert.deepEqual(
    await backfillAssessments(store, 2, async (stage, id) =>
      deliveries.push([stage, id]),
    ),
    [3, 2],
  );
  assert.deepEqual(deliveries, [
    ['assessment', 3],
    ['assessment', 2],
  ]);
});

test('backfill preview is bounded and read-only; execution claims only the selected rows', (t) => {
  const store = fixture(t);
  assert.deepEqual(store.previewAssessmentBackfill(2), {
    eligible: 3,
    missingText: 1,
    terminalCrawl: 0,
    crawlNotComplete: 0,
    selectedIds: [1, 2],
  });
  assert.equal(
    store.stages(1).some((stage) => stage.stage === 'assessment'),
    false,
  );
  assert.deepEqual(store.queueAssessmentBackfill(2), [1, 2]);
  assert.deepEqual(store.previewAssessmentBackfill(2), {
    eligible: 1,
    missingText: 1,
    terminalCrawl: 0,
    crawlNotComplete: 0,
    selectedIds: [3],
  });
  assert.deepEqual(store.queueAssessmentBackfill(2), [3]);
  assert.deepEqual(store.queueAssessmentBackfill(2), []);
  assert.equal(
    store.stages(4).some((stage) => stage.stage === 'assessment'),
    false,
  );
});

test('backfill reports terminal crawls and does not reset failed or pending assessments', (t) => {
  const store = fixture(t);
  store.terminalCrawl(6, 'Gone');
  store.activateAssessment(1);
  store.failStage(1, 'assessment', 'Model failure', true);
  store.activateAssessment(2);
  assert.deepEqual(store.previewAssessmentBackfill(10), {
    eligible: 1,
    missingText: 0,
    terminalCrawl: 1,
    crawlNotComplete: 0,
    selectedIds: [3],
  });
  assert.deepEqual(store.queueAssessmentBackfill(10), [3]);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'failed',
  );
  assert.equal(
    store.stages(2).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
});

test('backfill rejects missing, invalid and unbounded limits', (t) => {
  const store = fixture(t);
  for (const limit of [
    undefined,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
  ]) {
    assert.throws(
      () => store.previewAssessmentBackfill(limit),
      /Invalid backfill limit/,
    );
    assert.throws(
      () => store.queueAssessmentBackfill(limit),
      /Invalid backfill limit/,
    );
  }
});

test('ID preview and claim preserve readiness and existing assessment safeguards', (t) => {
  const store = fixture(t);
  store.activateAssessment(1);
  assert.deepEqual(store.previewAssessmentBackfill(1, 2), {
    eligible: 1,
    missingText: 0,
    terminalCrawl: 0,
    crawlNotComplete: 0,
    selectedIds: [2],
  });
  assert.deepEqual(store.queueAssessmentBackfill(1, 2), [2]);
  for (const id of [1, 2, 4, 5, 6, 99])
    assert.throws(() => store.queueAssessmentBackfill(1, id), /not eligible/);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  assert.equal(
    store.stages(3).some((stage) => stage.stage === 'assessment'),
    false,
  );
});

test('a delivery failure leaves only the selected pending work recoverable', async (t) => {
  const store = fixture(t);
  const deliveries = [];
  await assert.rejects(
    backfillAssessments(store, 2, async (stage, id) => {
      deliveries.push([stage, id]);
      if (id === 1) throw new Error('Redis unavailable');
    }),
    /delivery failed; run repair --stage assessment/,
  );
  assert.deepEqual(deliveries, [['assessment', 1]]);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  assert.equal(
    store.stages(2).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  assert.equal(
    store.stages(3).some((stage) => stage.stage === 'assessment'),
    false,
  );
  assert.deepEqual(store.previewAssessmentBackfill(2).selectedIds, [3]);
  const repaired = [];
  await enqueueMissingStages(store, 1, async (stage, id) =>
    repaired.push([stage, id]),
  );
  assert.ok(repaired.some(([stage, id]) => stage === 'assessment' && id === 1));
});

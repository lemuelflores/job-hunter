import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessJob } from '../src/workflow/assess-job.ts';
import { crawlJob } from '../src/workflow/crawl.ts';
import { enqueueMissingStages } from '../src/workflow/enqueue.ts';

test('new discovery runs crawl then one assessment using the complete saved description', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const discovery = {
    source: 'google',
    url: 'https://example.test/job',
    title: 'Engineer',
    query: 'remote',
    snippet: 'Truncated search snippet',
  };
  store.saveResults([discovery]);
  const enqueued = [];
  const enqueue = async (stage, id) => enqueued.push([stage, id]);
  await enqueueMissingStages(store, 1, enqueue);
  assert.deepEqual(enqueued, [['crawl', 1]]);
  assert.deepEqual(
    store.stages(1).map((stage) => stage.stage),
    ['assessment', 'crawl'],
  );
  enqueued.length = 0;
  await crawlJob(
    store,
    1,
    { ats: [], fallback: async () => ({ text: 'Full job description' }) },
    enqueue,
  );
  assert.deepEqual(enqueued, [['assessment', 1]]);
  const report = {
    company: null,
    role: null,
    summary: 'Build software.',
    schedule_manila: null,
    hard_stops: ['Onsite'],
    eligibility: [],
    requirements: [],
    compensation: { advertised: null, vs_profile: 'not_stated' },
    strengths: [],
    concerns: [],
    confidence: 'high',
    decision_changing_questions: [],
    score: 2,
    verdict_reason: 'Onsite.',
    verdict: 'Skip',
  };
  const calls = [];
  const review = async (input) => {
    calls.push(input);
    return report;
  };
  const docs = async () => ({ cv: 'CV', profile: 'Profile' });
  await assessJob(store, 1, docs, review);
  await assessJob(store, 1, docs, review);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].listingText, 'Full job description');
  assert.deepEqual(store.getAssessment(1), { version: 1, assessment: report });
  assert.equal(store.saveResults([discovery]), 0);
  enqueued.length = 0;
  await enqueueMissingStages(store, 1, enqueue);
  assert.deepEqual(enqueued, []);
});

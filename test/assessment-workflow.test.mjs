import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { createChatgpt } from '../src/integrations/llm/chatgpt/index.ts';
import { assessJob } from '../src/workflow/assess-job.ts';

function report() {
  return {
    company: null,
    role: null,
    summary: 'Build software.',
    schedule_manila: null,
    hard_stops: ['Not remote'],
    eligibility: [],
    requirements: [],
    compensation: { advertised: null, vs_profile: 'not_stated' },
    strengths: [],
    concerns: [],
    confidence: 'medium',
    decision_changing_questions: [],
    score: 3,
    verdict_reason: 'Onsite.',
    verdict: 'Skip',
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
  store.saveListingText(1, 'Full saved job description');
  store.activateAssessment(1);
  return store;
}

test('assessment consumes saved text and candidate documents once even on redelivery', async (t) => {
  const store = fixture(t);
  const requests = [];
  const documents = async () => ({ cv: 'CV', profile: 'Profile' });
  const review = async (input) => {
    requests.push(input);
    return report();
  };
  await assessJob(store, 1, documents, review);
  await assessJob(store, 1, documents, review);
  assert.deepEqual(requests, [
    {
      listingText: 'Full saved job description',
      cv: 'CV',
      profile: 'Profile',
      signal: undefined,
    },
  ]);
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

test('failed, hidden and missing listings do not read private documents or call the model', async (t) => {
  const store = fixture(t);
  const documents = async () => assert.fail('unexpected document read');
  const review = async () => assert.fail('unexpected model call');
  store.failStage(1, 'assessment', 'exhausted', true);
  await assessJob(store, 1, documents, review);
  store.resetStage(1, 'assessment');
  store.setReviewStatus('1', 'hidden');
  await assessJob(store, 1, documents, review);
  await assessJob(store, 999, documents, review);
  store.setReviewStatus('1', 'active');
  await assessJob(
    store,
    1,
    async () => ({ cv: 'CV', profile: 'Profile' }),
    async () => report(),
  );
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

test('invalid provider output does not commit a partial assessment and can be retried', async (t) => {
  const store = fixture(t);
  const provider = createChatgpt({
    getCredentials: async () => ({ type: 'oauth', access: 'test' }),
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{ invalid' })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
      ),
  });
  const documents = async () => ({
    cv: 'Private CV',
    profile: 'Private profile',
  });
  await assert.rejects(
    assessJob(store, 1, documents, provider.assess),
    /^Error: Invalid assessment JSON$/,
  );
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
  await assessJob(store, 1, documents, async () => report());
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

test('missing candidate documents prevent any model request and preserve pending work', async (t) => {
  const store = fixture(t);
  await assert.rejects(
    assessJob(
      store,
      1,
      async () => {
        throw new Error('Missing CV');
      },
      async () => assert.fail('unexpected model call'),
    ),
    /Missing CV/,
  );
  assert.equal(store.getAssessment(1), undefined);
  assert.equal(
    store.stages(1).find((stage) => stage.stage === 'assessment').state,
    'pending',
  );
});

test('cancellation after model response prevents checkpointing', async (t) => {
  const store = fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    assessJob(
      store,
      1,
      async () => ({ cv: 'CV', profile: 'Profile' }),
      async () => {
        controller.abort();
        return report();
      },
      controller.signal,
    ),
  );
  assert.equal(store.getAssessment(1), undefined);
});

test('the real provider request and validator persist a full assessment', async (t) => {
  const store = fixture(t);
  let request;
  const provider = createChatgpt({
    getCredentials: async () => ({ type: 'oauth', access: 'test' }),
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(report()) })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
      );
    },
  });
  await assessJob(
    store,
    1,
    async () => ({ cv: 'Private CV', profile: 'Remote only' }),
    provider.assess,
  );
  assert.deepEqual(JSON.parse(request.input[0].content[0].text), {
    job_description: 'Full saved job description',
    cv: 'Private CV',
    profile: 'Remote only',
  });
  assert.deepEqual(store.getAssessment(1), {
    version: 1,
    assessment: report(),
  });
});

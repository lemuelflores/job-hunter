import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxHandler } from '../src/app/inbox-api.ts';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { assessment, result } from './fixtures/workflow.mjs';

function setup(t) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([result(1), result(2)]);
  store.saveListingText(1, 'Private listing text');
  store.saveAssessment(1, assessment);
  const retries = [];
  const handler = createInboxHandler({
    store,
    port: 3000,
    retry: async (stage, id) => {
      retries.push({ stage, id });
    },
  });
  return { store, retries, handler };
}

function request(path, options = {}) {
  return new Request(`http://localhost:3000${path}`, {
    ...options,
    headers: { host: 'localhost:3000', ...options.headers },
  });
}

test('GET returns saved inbox data without listing text', async (t) => {
  const { handler } = setup(t);
  const response = await handler(request('/api/inbox'));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(
    body.listings.find((job) => job.id === 1).assessment.verdict,
    assessment.verdict,
  );
  assert.ok(!JSON.stringify(body).includes('Private listing text'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('status mutation persists a valid change', async (t) => {
  const { handler, store } = setup(t);
  const response = await handler(
    request('/api/inbox/status', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 1, status: 'hidden' }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(store.getJob(1).status, 'hidden');
});

test('retry targets the failed stage, not a completed report', async (t) => {
  const { handler, store, retries } = setup(t);
  store.failStage(2, 'crawl', 'Unavailable', true);
  const response = await handler(
    request('/api/inbox/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 2 }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(retries, [{ stage: 'crawl', id: 2 }]);
});

test('unsafe hosts and cross-origin mutations are refused', async (t) => {
  const { handler, store } = setup(t);
  assert.equal(
    (
      await handler(
        request('/api/inbox', { headers: { host: 'attacker.example:3000' } }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handler(
        request('/api/inbox', { headers: { host: 'localhost:3001' } }),
      )
    ).status,
    403,
  );
  const response = await handler(
    request('/api/inbox/status', {
      method: 'POST',
      headers: {
        origin: 'http://attacker.example:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 1, status: 'hidden' }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(store.getJob(1).status, 'active');
});

test('invalid payloads and retries of completed work are rejected', async (t) => {
  const { handler, retries } = setup(t);
  const headers = { 'content-type': 'application/json' };
  assert.equal(
    (
      await handler(
        request('/api/inbox/status', { method: 'POST', headers, body: '{' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        request('/api/inbox/status', {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: 1, status: 'bogus' }),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        request('/api/inbox/status', {
          method: 'POST',
          headers: {},
          body: '{}',
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        request('/api/inbox/retry', {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: 1 }),
        }),
      )
    ).status,
    409,
  );
  assert.deepEqual(retries, []);
});

test('oversized mutation bodies cannot change a listing', async (t) => {
  const { handler, store } = setup(t);
  const response = await handler(
    request('/api/inbox/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        status: 'hidden',
        padding: 'x'.repeat(16384),
      }),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(store.getJob(1).status, 'active');
});

test('retry refuses hidden jobs even when a stage failed', async (t) => {
  const { handler, store, retries } = setup(t);
  store.failStage(2, 'crawl', 'Unavailable', true);
  store.setReviewStatus('2', 'hidden');
  const response = await handler(
    request('/api/inbox/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 2 }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(retries, []);
});

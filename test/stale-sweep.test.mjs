import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteStore } from '../src/infra/sqlite.ts';
import { PageError } from '../src/integrations/extraction.ts';
import { runStaleCheck } from '../src/workflow/stale-check.ts';

function check(store, fallback) {
  return runStaleCheck({
    store,
    extractors: { ats: [], fallback },
    now: () => 1_000,
    token: 'delivery',
  });
}

function listing(id, postedAt) {
  return {
    source: 'google',
    url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
    title: 'Engineer',
    query: 'remote',
    postedAt,
  };
}

test('a sweep snapshots active listings oldest first and survives reopening', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'stale-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults([
    listing(1, '2025-02-01T00:00:00Z'),
    listing(2, '2025-01-01T00:00:00Z'),
    listing(3, null),
    listing(4, '2024-01-01T00:00:00Z'),
  ]);
  store.setReviewStatus('1', 'hidden');
  assert.equal(store.startStaleSweep(1_000), true);
  store.close();
  store = new SqliteStore(path);
  t.after(() => store.close());
  assert.deepEqual(store.pendingStaleSweep(), [4, 2, 3]);
  assert.equal(store.startStaleSweep(100_000_000), false);
});

test('a completed sweep is eligible again 24 hours after its start', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01')]);
  assert.equal(store.startStaleSweep(1_000), true);
  const claim = store.claimStaleCheck(1_000, 'first', () => 'provider');
  store.completeStaleCheck(claim, { kind: 'available' }, 1_000);
  assert.equal(store.startStaleSweep(86_400_999), false);
  assert.equal(store.startStaleSweep(86_401_000), true);
  assert.deepEqual(store.pendingStaleSweep(), [1]);
});

test('a confirmed missing listing becomes stale without modifying its review stages', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  const stages = store.stages(1);
  store.startStaleSweep(1_000);
  await check(store, async () => {
    throw new PageError(404);
  });
  assert.equal(store.getJob(1).status, 'stale');
  assert.deepEqual(store.stages(1), stages);
  assert.deepEqual(store.pendingStaleSweep(), []);
});

test('a review decision made during a check is preserved', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  const pending = check(store, async () => {
    store.setReviewStatus('1', 'hidden');
    throw new PageError(404);
  });
  await pending;
  assert.equal(store.getJob(1).status, 'hidden');
  assert.deepEqual(store.pendingStaleSweep(), []);
});

test('a listing reactivated during a check is not marked stale by the old result', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  await check(store, async () => {
    store.setReviewStatus('1', 'hidden');
    store.setReviewStatus('1', 'active');
    throw new PageError(404);
  });
  assert.equal(store.getJob(1).status, 'active');
});

test('a rate-limited check remains pending for a later attempt', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  const outcome = await check(store, async () => {
    throw new PageError(429);
  });
  assert.equal(outcome.kind, 'rate-limited');
  assert.deepEqual(store.pendingStaleSweep(), [1]);
});

test('concurrent deliveries produce one external check and one durable completion', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let count = 0;
  const extractors = {
    ats: [],
    fallback: async () => {
      count++;
      entered.resolve();
      await gate.promise;
      return { text: 'listing' };
    },
  };
  const first = runStaleCheck({
    store,
    extractors,
    now: () => 1_000,
    token: 'first',
  });
  await entered.promise;
  const second = await runStaleCheck({
    store,
    extractors,
    now: () => 1_000,
    token: 'second',
  });
  gate.resolve();
  await first;
  assert.equal(second, null);
  assert.equal(count, 1);
  assert.deepEqual(store.pendingStaleSweep(), []);
});

test('claims are exclusive and persist five-second pacing across deliveries', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    listing(1, '2025-01-01T00:00:00Z'),
    listing(2, '2025-01-02T00:00:00Z'),
  ]);
  store.startStaleSweep(1_000);
  const first = store.claimStaleCheck(1_000, 'first', () => 'provider');
  assert.equal(first.id, 1);
  assert.equal(
    store.claimStaleCheck(6_000, 'second', () => 'provider'),
    null,
  );
  store.completeStaleCheck(first, { kind: 'available' }, 1_000);
  assert.equal(
    store.claimStaleCheck(5_999, 'second', () => 'provider'),
    null,
  );
  assert.equal(store.claimStaleCheck(6_000, 'second', () => 'provider').id, 2);
});

test('a limited provider cools down while other providers proceed', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([
    listing(1, '2025-01-01T00:00:00Z'),
    listing(2, '2025-01-02T00:00:00Z'),
  ]);
  store.startStaleSweep(1_000);
  const provider = (url) => (url.endsWith('/1') ? 'a' : 'b');
  const first = store.claimStaleCheck(1_000, 'first', provider);
  store.completeStaleCheck(
    first,
    { kind: 'rate-limited', retryAfter: null },
    1_000,
  );
  const second = store.claimStaleCheck(6_000, 'second', provider);
  assert.equal(second.id, 2);
  store.completeStaleCheck(second, { kind: 'available' }, 6_000);
  assert.equal(store.claimStaleCheck(60_999, 'third', provider), null);
  assert.equal(store.claimStaleCheck(61_000, 'third', provider).id, 1);
});

test('provider cooldown and pacing survive a restart', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'stale-backoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.sqlite');
  let store = new SqliteStore(path);
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  const claim = store.claimStaleCheck(1_000, 'first', () => 'provider');
  store.completeStaleCheck(
    claim,
    { kind: 'rate-limited', retryAfter: '300' },
    1_000,
  );
  store.close();
  store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(
    store.claimStaleCheck(300_999, 'second', () => 'provider'),
    null,
  );
  assert.equal(
    store.claimStaleCheck(301_000, 'second', () => 'provider').id,
    1,
  );
});

test('repeated rate limits increase the provider cooldown', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  const first = store.claimStaleCheck(1_000, 'first', () => 'provider');
  store.completeStaleCheck(
    first,
    { kind: 'rate-limited', retryAfter: null },
    1_000,
  );
  const retry = store.claimStaleCheck(61_000, 'retry', () => 'provider');
  store.completeStaleCheck(
    retry,
    { kind: 'rate-limited', retryAfter: null },
    61_000,
  );
  assert.equal(
    store.claimStaleCheck(180_999, 'third', () => 'provider'),
    null,
  );
  assert.equal(store.claimStaleCheck(181_000, 'third', () => 'provider').id, 1);
});

test('an expired delivery cannot overwrite its replacement', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01T00:00:00Z')]);
  store.startStaleSweep(1_000);
  const first = store.claimStaleCheck(1_000, 'first', () => 'provider');
  const replacement = store.claimStaleCheck(
    121_000,
    'replacement',
    () => 'provider',
  );
  assert.equal(
    store.completeStaleCheck(first, { kind: 'missing' }, 121_000),
    false,
  );
  assert.equal(store.getJob(1).status, 'active');
  assert.equal(
    store.completeStaleCheck(replacement, { kind: 'available' }, 121_000),
    true,
  );
  assert.deepEqual(store.pendingStaleSweep(), []);
});

test('an old delivery cannot complete an item in a newer sweep', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.saveResults([listing(1, '2025-01-01')]);
  store.startStaleSweep(1_000);
  const claim = store.claimStaleCheck(1_000, 'old', () => 'provider');
  store.completeStaleCheck(claim, { kind: 'available' }, 1_000);
  store.startStaleSweep(86_401_000);
  assert.equal(
    store.completeStaleCheck(claim, { kind: 'missing' }, 86_401_000),
    false,
  );
  assert.deepEqual(store.pendingStaleSweep(), [1]);
});

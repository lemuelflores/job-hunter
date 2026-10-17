import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PageError } from '../dist/firecrawl.js';
import { AuthenticationError, RateLimitError } from '../dist/llm/index.js';
import { SqliteStore } from '../dist/persistence.js';
import { fetchJobs, reviewJobs, workJobs } from '../dist/runner.js';

const result = (id) => ({
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
const decision = {
  eligibility: 'eligible',
  reason: 'Worldwide',
  evidence: '',
  company: '',
  location: '',
  title: '',
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'worker-test-'));
  const path = join(root, 'jobs.sqlite');
  const store = new SqliteStore(path);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, store };
}

test('manual review saves permanent page errors immediately and continues with other jobs', async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1), result(2)]);
  const outcome = await reviewJobs(root, store, {}, async (url) => {
    if (url === result(1).url)
      throw new PageError(
        404,
        'The job board you were viewing is no longer active.',
      );
    return decision;
  });
  assert.equal(outcome.reviewed, 2);
  assert.deepEqual(outcome.failures, []);
  const error = store.listReviewJobs('active').find((row) => row.id === 1);
  assert.equal(error.eligibility, 'error');
  assert.match(
    error.reason,
    /“The job board you were viewing is no longer active\.”/,
  );
  assert.equal(error.attempts, 0);
  assert.equal(store.pendingCount(), 0);
});

test('worker retries temporary page errors then saves error on the fifth failure', {
  timeout: 5000,
}, async (t) => {
  const { root, path, store } = await fixture(t);
  store.saveResults([result(1)]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => process.emit('SIGTERM'));
  let calls = 0;
  const running = workJobs(root, store, async () => {
    calls++;
    if (calls === 5) setImmediate(() => process.emit('SIGTERM'));
    throw new PageError(500);
  });
  for (let attempt = 1; attempt < 5; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
    const [row] = store.listReviewJobs('active');
    assert.equal(row.eligibility, 'pending');
    assert.equal(row.attempts, attempt);
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE jobs SET next_retry_at=0').run();
    } finally {
      db.close();
    }
    t.mock.timers.tick(30_000);
  }
  await running;
  assert.equal(calls, 5);
  const [row] = store.listReviewJobs('active');
  assert.equal(row.eligibility, 'error');
  assert.equal(row.reason, 'Page returned 500 status');
  assert.equal(store.pendingCount(), 0);
});

test('legacy eligibility constraint migrates without losing jobs, decisions or indexes', async (t) => {
  const { path, store } = await fixture(t);
  store.saveResults([result(1), result(2)]);
  const batch = 'c'.repeat(32);
  store.claimBatch(batch);
  store.review(1, batch, 'eligible', 'Worldwide');
  store.failReview(2, batch, 'Temporary failure');
  store.finishBatch(batch);
  const source = new DatabaseSync(path);
  const legacy = new DatabaseSync(`${path}.legacy`);
  try {
    const schema = source
      .prepare("SELECT sql FROM sqlite_master WHERE name='jobs'")
      .get().sql;
    legacy.exec(schema.replace(",'error'", ''));
    legacy.prepare('ATTACH DATABASE ? AS source').run(path);
    legacy.exec(
      'INSERT INTO jobs SELECT * FROM source.jobs; CREATE INDEX jobs_title ON jobs(title)',
    );
  } finally {
    source.close();
    legacy.close();
  }
  const migrated = new SqliteStore(`${path}.legacy`);
  try {
    assert.deepEqual(
      migrated.listReviewJobs('active'),
      store.listReviewJobs('active'),
    );
    migrated.claimBatch(batch);
    migrated.review(2, batch, 'error', 'Page returned 404 status');
    assert.equal(migrated.listReviewJobs('active')[0].eligibility, 'error');
    const db = new DatabaseSync(`${path}.legacy`);
    try {
      assert.ok(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='jobs_title'")
          .get(),
      );
    } finally {
      db.close();
    }
  } finally {
    migrated.close();
  }
});

test('worker skips failed listings, saves successes, picks up new fetches and cancels without a failed attempt', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1), result(2)]);
  const seen = [];
  await workJobs(root, store, async (url, { signal }) => {
    seen.push(url);
    if (url === result(1).url) throw new Error('temporary network failure');
    if (url === result(2).url) {
      await fetchJobs(store, async () => ({
        results: [result(3)],
        failures: [],
      }));
      await assert.rejects(
        reviewJobs(root, store, {}, async () => assert.fail('overlap')),
        /Another run/,
      );
      return decision;
    }
    process.emit('SIGTERM');
    signal.throwIfAborted();
    return decision;
  });
  assert.deepEqual(
    seen,
    [1, 2, 3].map((id) => result(id).url),
  );
  const rows = store.listReviewJobs('active');
  assert.equal(rows.find((row) => row.id === 1).attempts, 1);
  assert.match(rows.find((row) => row.id === 1).last_error, /network/);
  assert.equal(rows.find((row) => row.id === 2).eligibility, 'eligible');
  assert.equal(rows.find((row) => row.id === 3).attempts, 0);
  // Manual review deliberately bypasses worker backoff and resets successful jobs.
  assert.equal(
    (await reviewJobs(root, store, {}, async () => decision)).reviewed,
    2,
  );
  assert.ok(
    store
      .listReviewJobs('active')
      .every((row) => row.attempts === 0 && row.last_error === ''),
  );
});

test('backoff and exhaustion survive reopening; failed jobs remain pending for manual review', async (t) => {
  const { root, path, store } = await fixture(t);
  store.saveResults([result(1), result(2)]);
  store.setReviewStatus('2', 'hidden');
  const batch = 'a'.repeat(32);
  let now = 1_000_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reopened = new SqliteStore(path);
    try {
      const [job] = reopened.claimBatch(batch, 1, true, now);
      assert.equal(job.id, 1);
      reopened.failReview(job.id, batch, 'temporary failure', now);
      reopened.finishBatch(batch);
      const due = now + 60_000 * 2 ** attempt;
      assert.equal(reopened.listReviewJobs('active')[0].next_retry_at, due);
      assert.deepEqual(reopened.claimBatch(batch, 1, true, due - 1), []);
      now = due;
    } finally {
      reopened.close();
    }
  }
  assert.deepEqual(store.claimBatch(batch, 1, true, now + 1_000_000), []);
  assert.equal(store.pendingCount(), 1);
  assert.equal(
    (await reviewJobs(root, store, {}, async () => decision)).reviewed,
    1,
  );
  assert.equal(store.listReviewJobs('active')[0].last_error, '');
  assert.equal(store.listReviewJobs('hidden')[0].eligibility, 'pending');
});

test('authentication pauses all reviews without consuming attempts; rate limits pause with backoff', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1), result(2)]);
  for (const error of [
    new AuthenticationError('expired'),
    new RateLimitError('429'),
  ]) {
    let calls = 0;
    await workJobs(root, store, async () => {
      calls++;
      setImmediate(() => process.emit('SIGTERM'));
      throw error;
    });
    assert.equal(calls, 1);
  }
  const rows = store.listReviewJobs('active');
  assert.equal(
    rows.reduce((sum, row) => sum + row.attempts, 0),
    1,
  );
  assert.equal(store.pendingCount(), 2);
});

test('idle worker wakes for SIGTERM and releases the review lock', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  setImmediate(() => process.emit('SIGTERM'));
  await workJobs(root, store, async () => assert.fail('no jobs'));
  assert.equal((await reviewJobs(root, store)).reviewed, 0);
});

test('authentication resumes automatically after credentials become usable', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1)]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => process.emit('SIGTERM'));
  let calls = 0;
  const running = workJobs(root, store, async () => {
    if (++calls === 1) throw new AuthenticationError('expired');
    setImmediate(() => process.emit('SIGTERM'));
    return decision;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(store.listReviewJobs('active')[0].attempts, 0);
  t.mock.timers.tick(60_000);
  await running;
  assert.equal(calls, 2);
  assert.equal(store.pendingCount(), 0);
});

test('idle worker discovers fetched listings on its next poll', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => process.emit('SIGTERM'));
  let calls = 0;
  const running = workJobs(root, store, async () => {
    calls++;
    setImmediate(() => process.emit('SIGTERM'));
    return decision;
  });
  store.saveResults([result(1)]);
  assert.equal(calls, 0);
  t.mock.timers.tick(30_000);
  await running;
  assert.equal(calls, 1);
  assert.equal(store.pendingCount(), 0);
});

test('SIGKILL releases the lock and abandoned work is picked up on restart', {
  timeout: 5000,
}, async (t) => {
  const { root, path, store } = await fixture(t);
  store.saveResults([result(1)]);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { SqliteStore } from ${JSON.stringify(new URL('../dist/persistence.js', import.meta.url).href)};
    import { workJobs } from ${JSON.stringify(new URL('../dist/runner.js', import.meta.url).href)};
    await workJobs(${JSON.stringify(root)}, new SqliteStore(${JSON.stringify(path)}), async () => {
      setInterval(() => {}, 1000);
      process.send('reviewing');
      await new Promise(() => {});
    });
  `,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'message');
  await assert.rejects(
    reviewJobs(root, store, {}, async () => assert.fail('overlap')),
    /Another run/,
  );
  // The queue database remains writable while another process owns the review lock.
  store.saveResults([result(2)]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  let calls = 0;
  await workJobs(root, store, async () => {
    if (++calls === 2) setImmediate(() => process.emit('SIGTERM'));
    return decision;
  });
  assert.equal(calls, 2);
  assert.equal(store.pendingCount(), 0);
});

test('schema upgrade preserves existing decisions and adds retry defaults', async (t) => {
  const { path, store } = await fixture(t);
  store.saveResults([result(1)]);
  const batch = 'b'.repeat(32);
  store.claimBatch(batch);
  store.review(1, batch, 'eligible', 'Worldwide');
  store.finishBatch(batch);
  const db = new DatabaseSync(path);
  try {
    for (const column of ['attempts', 'next_retry_at', 'last_error'])
      db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  } finally {
    db.close();
  }
  const migrated = new SqliteStore(path);
  try {
    const [row] = migrated.listReviewJobs('active');
    assert.equal(row.eligibility, 'eligible');
    assert.equal(row.reason, 'Worldwide');
    assert.equal(row.attempts, 0);
    assert.equal(row.next_retry_at, 0);
    assert.equal(row.last_error, '');
  } finally {
    migrated.close();
  }
});

test('worker CLI pauses on missing credentials and exits cleanly on real SIGTERM', {
  timeout: 5000,
}, async (t) => {
  const { root, store } = await fixture(t);
  store.saveResults([result(1)]);
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), {
    recursive: true,
  });
  await cp(new URL('../profile.ts', import.meta.url), join(root, 'profile.ts'));
  await mkdir(join(root, 'src'));
  await cp(
    new URL('../src/title.ts', import.meta.url),
    join(root, 'src/title.ts'),
  );
  await cp(
    new URL('../package.json', import.meta.url),
    join(root, 'package.json'),
  );
  await symlink(
    new URL('../node_modules', import.meta.url).pathname,
    join(root, 'node_modules'),
    'dir',
  );
  const child = spawn(process.execPath, [join(root, 'dist/cli.js'), 'worker'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let log = '';
    child.on('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Worker exited before pausing: ${code}: ${log}`)),
    );
    child.stderr.on('data', (chunk) => {
      log += chunk;
      if (log.includes('Authentication paused:')) resolve();
    });
  });
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(store.listReviewJobs('active')[0].attempts, 0);
  assert.equal(
    (await reviewJobs(root, store, {}, async () => decision)).reviewed,
    1,
  );
});

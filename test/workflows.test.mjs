import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverJobs } from '../dist/discovery/discover.js';
import { buildQueryMatrix } from '../dist/discovery/google.js';
import { crawlJob } from '../dist/review/crawl.js';
import { checkLocation } from '../dist/review/location-check.js';
import { checkTech } from '../dist/review/tech-check.js';
import { SqliteStore } from '../dist/sqlite.js';
import {
  externalFixture,
  location,
  profile,
  result,
  stack,
  stream,
  uuid,
} from './fixtures/workflow.mjs';

function fixture(t, respond) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  return { store, ...externalFixture(t, respond) };
}

test('discovery canonicalizes, deduplicates and returns only discovered unfinished IDs', async (t) => {
  const f = fixture(t, ({ url }) =>
    url.hostname === 'api.autom.dev'
      ? Response.json({
          organic_results: [
            ...[1, 2, 5, 5].map((id) => ({
              link: `https://boards.greenhouse.io/example/jobs/${id}?source=google#top`,
              title: 'Engineer',
            })),
            { link: 'https://evil.test/jobs/6', title: 'Invalid' },
            {
              link: 'https://jobs.lever.co/example',
              title: 'Board, not listing',
            },
          ],
        })
      : undefined,
  );
  f.store.saveResults([1, 2, 3, 4].map(result));
  f.store.saveListingText(2, 'Saved listing');
  f.store.review(2, 'eligible', 'Saved decision');
  f.store.reviewStack(2, stack);
  const { last_seen: _beforeSeen, ...before } = f.store.getJob(2);
  assert.deepEqual(await discoverJobs(f.store, profile), {
    ids: [1, 5],
    added: 1,
    pending: 4,
    failures: [],
  });
  assert.equal(f.store.listReviewJobs('active').length, 5);
  assert.equal(f.store.getJob(5).url, result(5).url);
  const { last_seen: _afterSeen, ...after } = f.store.getJob(2);
  assert.deepEqual(after, before);
  assert.equal(f.requests.length, 1);
  const search = f.requests[0];
  assert.equal(
    search.url.searchParams.get('query'),
    buildQueryMatrix(profile)[0].query,
  );
  assert.equal(search.url.searchParams.has('gl'), false);
  assert.equal(search.init.headers['x-api-key'], 'fixture-key');
});

test('partial discovery returns completed pages and failure without repeating paid searches', async (t) => {
  let unavailable = true;
  const f = fixture(t, ({ url }) => {
    assert.equal(url.hostname, 'api.autom.dev');
    return url.searchParams.get('page') === '1'
      ? Response.json({
          organic_results: [
            {
              link: result(1).url,
              title: 'Engineer',
              snippet: 'Valid snippet',
            },
            { link: result(2).url, title: 'Developer', snippet: 42 },
          ],
          pagination: { has_next_page: true, next: 2 },
        })
      : unavailable
        ? new Response('Unavailable', { status: 503 })
        : Response.json({ organic_results: [] });
  });
  const outcome = await discoverJobs(f.store, profile);
  assert.deepEqual(outcome.ids, [1, 2]);
  assert.equal(outcome.added, 2);
  assert.equal(outcome.pending, 2);
  assert.match(outcome.failures[0], /503/);
  assert.equal(f.store.getJob(1).url, result(1).url);
  assert.equal(f.store.getJob(1).snippet, 'Valid snippet');
  assert.equal(f.store.getJob(2).snippet, '');
  assert.equal(f.requests.length, 2);
  unavailable = false;
  assert.deepEqual(await discoverJobs(f.store, profile), {
    ids: [1, 2],
    added: 0,
    pending: 2,
    failures: [],
  });
});

test('discovery normalizes UUID casing but preserves board casing and saved decisions', async (t) => {
  const url = `https://jobs.ashbyhq.com/Example/${uuid}`;
  const f = fixture(t, () =>
    Response.json({
      organic_results: [url, url.replace(uuid, uuid.toUpperCase())].map(
        (link) => ({ link, title: 'Engineer' }),
      ),
    }),
  );
  await discoverJobs(f.store, profile);
  f.store.saveListingText(1, 'Saved listing');
  f.store.review(1, 'eligible', 'Saved decision');
  const saved = f.store.getJob(1);
  assert.equal((await discoverJobs(f.store, profile)).added, 0);
  assert.equal(f.store.listReviewJobs('active').length, 1);
  assert.equal(f.store.getJob(1).url, url);
  assert.equal(f.store.getJob(1).reason, saved.reason);
  assert.equal(f.store.getJob(1).listing_text, saved.listing_text);
});

for (const [name, url, endpoint, response] of [
  [
    'Ashby',
    `https://jobs.ashbyhq.com/example/${uuid}`,
    'https://api.ashbyhq.com/posting-api/job-board/example?includeCompensation=true',
    {
      jobs: [
        {
          jobUrl: `https://jobs.ashbyhq.com/example/${uuid}`,
          descriptionPlain: 'US Laravel role',
        },
      ],
    },
  ],
  ...['job-boards.greenhouse.io', 'boards.greenhouse.io'].map((host) => [
    host,
    `https://${host}/example/jobs/123`,
    'https://boards-api.greenhouse.io/v1/boards/example/jobs/123?pay_transparency=true',
    { id: 123, content: '&lt;p&gt;US Laravel role&lt;/p&gt;' },
  ]),
  ...['jobs.lever.co', 'jobs.eu.lever.co'].map((host) => [
    host,
    `https://${host}/example/${uuid}`,
    `https://${host.replace('jobs.', 'api.')}/v0/postings/example/${uuid}`,
    { id: uuid, descriptionPlain: 'US Laravel role', lists: [] },
  ]),
]) {
  test(`${name} checkpoints API text and both real model adapters consume it independently`, async (t) => {
    const f = fixture(t, ({ url }) =>
      url.href === endpoint ? Response.json(response) : undefined,
    );
    f.store.saveResults([{ ...result(1), url }]);
    await crawlJob(f.store, 1);
    const text = f.store.getJob(1).listing_text;
    assert.match(text, /US Laravel role/);
    assert.equal(f.requests.length, 1, 'extraction does not run assessments');
    await checkLocation(f.store, 1, f.reviewLocation);
    assert.equal(f.store.getJob(1).eligibility, 'ineligible');
    await checkTech(f.store, 1, f.reviewStack);
    const saved = f.store.getJob(1);
    for (const [key, value] of Object.entries(location))
      assert.equal(saved[key], value);
    assert.equal(saved.stack_status, stack.status);
    assert.equal(saved.stack_reason, stack.reason);
    assert.equal(saved.stack_evidence, stack.evidence);
    assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
    assert.equal(f.requests.length, 3);
    for (const { body } of f.requests.slice(1)) {
      assert.ok(body.input[0].content[0].text.includes(url));
      assert.ok(body.input[0].content[0].text.endsWith(text));
    }
    await crawlJob(f.store, 1);
    await checkLocation(f.store, 1, f.reviewLocation);
    await checkTech(f.store, 1, f.reviewStack);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.store.getJob(1), saved);
  });
}

for (const [name, url, response, terminal] of [
  [
    'missing Ashby UUID',
    `https://jobs.ashbyhq.com/example/${uuid}`,
    () => Response.json({ jobs: [] }),
    true,
  ],
  [
    'invalid Ashby response',
    `https://jobs.ashbyhq.com/example/${uuid}`,
    () => Response.json({ jobs: null }),
    false,
  ],
  [
    'Ashby entry missing its posting URL',
    `https://jobs.ashbyhq.com/example/${uuid}`,
    () => Response.json({ jobs: [{ id: uuid }] }),
    false,
  ],
  [
    'temporary Ashby failure',
    `https://jobs.ashbyhq.com/example/${uuid}`,
    () => new Response('', { status: 503 }),
    false,
  ],
  ...[404, 410].map((status) => [
    `Greenhouse ${status}`,
    result(1).url,
    () => new Response('', { status }),
    true,
  ]),
  ...[404, 410].map((status) => [
    `Lever ${status}`,
    `https://jobs.lever.co/example/${uuid}`,
    () => new Response('', { status }),
    true,
  ]),
  [
    'invalid Greenhouse response',
    result(1).url,
    () => Response.json({ id: 1, content: null }),
    false,
  ],
  [
    'invalid Lever response',
    `https://jobs.lever.co/example/${uuid}`,
    () => Response.json({ id: uuid, descriptionPlain: null, lists: [] }),
    false,
  ],
  [
    'temporary Lever failure',
    `https://jobs.lever.co/example/${uuid}`,
    () => new Response('', { status: 503 }),
    false,
  ],
  [
    'temporary ATS failure',
    result(1).url,
    () => new Response('', { status: 503 }),
    false,
  ],
]) {
  test(`${name} preserves terminal versus transient policy without fallback`, async (t) => {
    const f = fixture(t, () => response());
    f.store.saveResults([{ ...result(1), url }]);
    if (terminal) await crawlJob(f.store, 1);
    else await assert.rejects(crawlJob(f.store, 1));
    assert.equal(f.store.getJob(1).listing_text, null);
    assert.deepEqual(
      f.store.stages(1).map(({ state }) => state),
      terminal
        ? ['terminal', 'blocked', 'blocked']
        : ['pending', 'pending', 'pending'],
    );
    assert.equal(f.requests.length, 1);
    assert.ok(
      ['api.ashbyhq.com', 'boards-api.greenhouse.io', 'api.lever.co'].includes(
        f.requests[0].url.hostname,
      ),
    );
    await checkLocation(f.store, 1, f.reviewLocation);
    await checkTech(f.store, 1, f.reviewStack);
    assert.equal(f.requests.length, 1);
    if (terminal) {
      assert.ok(f.store.stages(1)[0].error);
      assert.equal(f.store.getJob(1).eligibility, 'error');
      const saved = f.store.getJob(1);
      await crawlJob(f.store, 1);
      assert.deepEqual(f.store.getJob(1), saved);
      assert.equal(f.requests.length, 1);
    }
  });
}

test('distinct listings keep their own assessment inputs and results', async (t) => {
  const f = fixture(t, ({ body }) => {
    if (!body?.text) return;
    const id = body.input[0].content[0].text.match(/Listing (\d+):/)[1];
    assert.ok(body.input[0].content[0].text.includes(result(id).url));
    return stream(
      body.text.format.name === 'job_review'
        ? { ...location, reason: `Location ${id}` }
        : { ...stack, reason: `Stack ${id}` },
    );
  });
  f.store.saveResults([result(1), result(2)]);
  for (const id of [1, 2]) {
    await crawlJob(f.store, id);
    await checkLocation(f.store, id, f.reviewLocation);
    await checkTech(f.store, id, f.reviewStack);
    assert.equal(f.store.getJob(id).reason, `Location ${id}`);
    assert.equal(f.store.getJob(id).stack_reason, `Stack ${id}`);
  }
});

test('temporary extraction errors propagate and a later call checkpoints before assessments', async (t) => {
  let offline = true;
  const f = fixture(t, ({ url }) =>
    url.hostname === 'boards-api.greenhouse.io' && offline
      ? new Response('', { status: 503 })
      : undefined,
  );
  f.store.saveResults([result(1)]);
  const saved = f.store.getJob(1);
  await assert.rejects(crawlJob(f.store, 1), /503/);
  assert.deepEqual(f.store.getJob(1), saved);
  assert.ok(f.store.stages(1).every(({ state }) => state === 'pending'));
  offline = false;
  await crawlJob(f.store, 1);
  assert.match(f.store.getJob(1).listing_text, /Listing 1/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(
    f.store.stages(1).map(({ state }) => state),
    ['complete', 'pending', 'pending'],
  );
});

test('pending location HTTP does not block stack assessment or extraction of the next listing', async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const f = fixture(t, async ({ body }) => {
    if (body?.text.format.name !== 'job_review') return;
    started.resolve();
    await gate.promise;
    return stream(location);
  });
  f.store.saveResults([result(1), result(2)]);
  await crawlJob(f.store, 1);
  const checking = checkLocation(f.store, 1, f.reviewLocation);
  try {
    await started.promise;
    await checkTech(f.store, 1, f.reviewStack);
    await crawlJob(f.store, 2);
    await checkTech(f.store, 2, f.reviewStack);
    assert.equal(f.store.getJob(1).eligibility, 'pending');
    assert.equal(f.store.getJob(1).stack_status, 'match');
    assert.equal(f.store.getJob(2).stack_status, 'match');
    assert.match(f.store.getJob(2).listing_text, /Listing 2/);
  } finally {
    gate.resolve();
    await checking;
  }
  assert.equal(f.store.getJob(1).eligibility, 'ineligible');
});

for (const failing of ['job_review', 'job_stack_review']) {
  test(`${failing} failure leaves the other result intact and a later call reuses it`, async (t) => {
    let offline = true;
    const f = fixture(t, ({ body }) =>
      body?.text.format.name === failing && offline
        ? new Response('Model unavailable', { status: 503 })
        : undefined,
    );
    f.store.saveResults([result(1)]);
    await crawlJob(f.store, 1);
    const failed = failing === 'job_review' ? checkLocation : checkTech;
    const other = failing === 'job_review' ? checkTech : checkLocation;
    const failingReview =
      failing === 'job_review' ? f.reviewLocation : f.reviewStack;
    const otherReview =
      failing === 'job_review' ? f.reviewStack : f.reviewLocation;
    await assert.rejects(failed(f.store, 1, failingReview), /503/);
    await other(f.store, 1, otherReview);
    const saved = f.store.getJob(1);
    assert.equal(
      f.store
        .stages(1)
        .find(
          (s) => s.stage === (failing === 'job_review' ? 'location' : 'stack'),
        ).state,
      'pending',
    );
    offline = false;
    await other(f.store, 1, otherReview);
    assert.equal(f.requests.length, 3, 'completed assessment is not repeated');
    await failed(f.store, 1, failingReview);
    assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
    assert.equal(f.store.getJob(1).listing_text, saved.listing_text);
    const keys =
      failing === 'job_review'
        ? ['stack_status', 'stack_reason', 'stack_evidence']
        : ['eligibility', 'reason', 'evidence', 'company', 'location', 'title'];
    for (const key of keys) assert.equal(f.store.getJob(1)[key], saved[key]);
    assert.equal(f.requests.length, 4);
  });
}

test('saved extraction and location checkpoints leave only the missing stack assessment', async (t) => {
  const f = fixture(t);
  f.store.saveResults([result(1)]);
  f.store.saveListingText(1, 'Checkpoint Laravel');
  f.store.review(1, 'eligible', 'Saved location');
  await crawlJob(f.store, 1);
  await checkLocation(f.store, 1, f.reviewLocation);
  await checkTech(f.store, 1, f.reviewStack);
  assert.equal(f.store.getJob(1).listing_text, 'Checkpoint Laravel');
  assert.equal(f.store.getJob(1).reason, 'Saved location');
  assert.equal(f.store.getJob(1).stack_status, 'match');
  assert.equal(f.requests.length, 1);
});

test('not-ready, failed, missing and inactive work makes no external calls; restored work resumes', async (t) => {
  const f = fixture(t);
  f.store.saveResults([1, 2, 3, 4].map(result));
  f.store.setReviewStatus('1', 'hidden');
  f.store.saveListingText(2, 'Inactive saved text');
  f.store.setReviewStatus('2', 'rejected');
  f.store.failStage(4, 'crawl', 'Exhausted', true);
  const saved = [1, 2, 3, 4].map((id) => ({
    job: f.store.getJob(id),
    stages: f.store.stages(id),
  }));
  for (const id of [1, 2, 3, 4, 999]) {
    if (id !== 3) await crawlJob(f.store, id);
    await checkLocation(f.store, id, f.reviewLocation);
    await checkTech(f.store, id, f.reviewStack);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(
    [1, 2, 3, 4].map((id) => ({
      job: f.store.getJob(id),
      stages: f.store.stages(id),
    })),
    saved,
  );
  f.store.setReviewStatus('1', 'active');
  await crawlJob(f.store, 1);
  await checkLocation(f.store, 1, f.reviewLocation);
  await checkTech(f.store, 1, f.reviewStack);
  assert.ok(f.store.stages(1).every(({ state }) => state === 'complete'));
  assert.deepEqual(f.store.getJob(2), saved[1].job);
});

test('exhausted assessment stages with saved text cannot call the model without reset', async (t) => {
  const f = fixture(t);
  f.store.saveResults([result(1)]);
  f.store.saveListingText(1, 'Checkpoint Laravel');
  f.store.failStage(1, 'location', 'Exhausted', true);
  f.store.failStage(1, 'stack', 'Exhausted', true);
  const saved = f.store.getJob(1);
  await checkLocation(f.store, 1, f.reviewLocation);
  await checkTech(f.store, 1, f.reviewStack);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.getJob(1), saved);
  assert.deepEqual(
    f.store.stages(1).map(({ state }) => state),
    ['complete', 'failed', 'failed'],
  );
});

for (const [operation, name] of [
  [checkLocation, 'location'],
  [checkTech, 'stack'],
]) {
  test(`${name} cancellation after the model response preserves the pending assessment`, async (t) => {
    const controller = new AbortController();
    const f = fixture(t, () => {
      controller.abort(new Error('cancelled'));
      return stream(name === 'location' ? location : stack);
    });
    f.store.saveResults([result(1)]);
    f.store.saveListingText(1, 'Checkpoint Laravel');
    const saved = f.store.getJob(1);
    await assert.rejects(
      operation(
        f.store,
        1,
        name === 'location' ? f.reviewLocation : f.reviewStack,
        controller.signal,
      ),
      /cancelled/,
    );
    assert.deepEqual(f.store.getJob(1), saved);
    assert.equal(
      f.store.stages(1).find((s) => s.stage === name).state,
      'pending',
    );
    assert.equal(f.requests.length, 1);
  });
}

test('cancellation before work and after an external response never saves a result', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, () => {
    controller.abort(new Error('cancelled'));
    return Response.json({ id: 1, content: '<p>Laravel</p>' });
  });
  f.store.saveResults([result(1)]);
  await assert.rejects(
    crawlJob(f.store, 1, undefined, controller.signal),
    /cancelled/,
  );
  assert.equal(f.store.getJob(1).listing_text, null);
  await assert.rejects(
    crawlJob(f.store, 1, undefined, controller.signal),
    /cancelled/,
  );
  await assert.rejects(
    checkLocation(f.store, 1, f.reviewLocation, controller.signal),
    /cancelled/,
  );
  await assert.rejects(
    checkTech(f.store, 1, f.reviewStack, controller.signal),
    /cancelled/,
  );
  assert.equal(f.requests.length, 1);
});

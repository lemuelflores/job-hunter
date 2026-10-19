import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageError, scrapeListing } from '../dist/review/firecrawl.js';

test('extraction rejects service HTTP errors and unsuccessful/empty responses', async () => {
  for (const response of [
    new Response('private error', { status: 500 }),
    Response.json({ success: false }),
    Response.json({ success: true, data: { markdown: '  ' } }),
    Response.json({ success: true, data: { markdown: 42 } }),
  ]) {
    await assert.rejects(
      scrapeListing('https://example.test', { fetch: async () => response }),
      /Firecrawl/,
    );
  }
});

test('page errors quote extracted messages or fall back to status and distinguish retryable failures', async () => {
  for (const status of [400, 401, 403, 404, 410, 408, 425, 429, 500, 503]) {
    for (const markdown of [
      'The job board you were viewing is no longer active.',
      '',
      undefined,
    ]) {
      await assert.rejects(
        scrapeListing('https://example.test', {
          fetch: async () =>
            Response.json({
              success: true,
              data: { markdown, metadata: { statusCode: status } },
            }),
        }),
        (error) => {
          assert.ok(error instanceof PageError);
          assert.equal(
            error.retryable,
            [408, 425, 429].includes(status) || status >= 500,
          );
          assert.equal(
            error.message,
            `Page returned ${status} status${markdown ? `: “${markdown}”` : ''}`,
          );
          return true;
        },
      );
    }
  }
  await assert.rejects(
    scrapeListing('https://example.test', {
      fetch: async () =>
        Response.json({
          success: false,
          data: { metadata: { statusCode: 404, error: 'Not Found' } },
        }),
    }),
    /“Not Found”/,
  );
});

test('extraction honors custom URL and cancellation', async (t) => {
  const original = process.env.FIRECRAWL_URL;
  process.env.FIRECRAWL_URL = 'http://localhost:3333/';
  t.after(() => {
    if (original === undefined) delete process.env.FIRECRAWL_URL;
    else process.env.FIRECRAWL_URL = original;
  });
  const controller = new AbortController();
  await assert.rejects(
    scrapeListing('https://example.test', {
      signal: controller.signal,
      fetch: async (url, init) => {
        assert.equal(url, 'http://localhost:3333/v2/scrape');
        controller.abort(new Error('interrupted'));
        init.signal.throwIfAborted();
      },
    }),
    /interrupted/,
  );
});

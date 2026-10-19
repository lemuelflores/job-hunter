import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageError, scrapeListing } from '../dist/review/firecrawl.js';

test('extraction posts the listing URL and returns Markdown', async () => {
  // Arrange: provide a listing URL and the Markdown returned by the scraper.
  const url = 'https://example.test/job';
  const markdown = '# Backend developer\nWorldwide Laravel role';
  // Act: extract the listing through a successful mocked service response.
  const text = await scrapeListing(url, {
    fetch: async (endpoint, init) => {
      // Assert: send the expected endpoint, request options and Markdown format.
      assert.ok(endpoint.endsWith('/v2/scrape'));
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), {
        url,
        formats: ['markdown'],
        timeout: 60_000,
      });
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ success: true, data: { markdown } });
    },
  });
  // Assert: return the extracted Markdown unchanged.
  assert.equal(text, markdown);
});

test('extraction rejects service HTTP errors and unsuccessful/empty responses', async () => {
  // Arrange: cover HTTP failures, unsuccessful responses and invalid Markdown.
  for (const response of [
    new Response('private error', { status: 500 }),
    Response.json({ success: false }),
    Response.json({ success: true, data: { markdown: '  ' } }),
    Response.json({ success: true, data: { markdown: 42 } }),
  ]) {
    // Act / Assert: reject extraction for each invalid service response.
    await assert.rejects(
      scrapeListing('https://example.test', { fetch: async () => response }),
      /Firecrawl/,
    );
  }
});

test('page errors quote extracted messages or fall back to status and distinguish retryable failures', async () => {
  // Arrange: cover permanent and retryable page statuses.
  for (const status of [400, 401, 403, 404, 410, 408, 425, 429, 500, 503]) {
    // Arrange: pair each status with present, empty and missing page text.
    for (const markdown of [
      'The job board you were viewing is no longer active.',
      '',
      undefined,
    ]) {
      // Act / Assert: reject the extracted page with a classified page error.
      await assert.rejects(
        scrapeListing('https://example.test', {
          fetch: async () =>
            Response.json({
              success: true,
              data: { markdown, metadata: { statusCode: status } },
            }),
        }),
        (error) => {
          // Assert: preserve retryability and quote page text only when present.
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
  // Act / Assert: use metadata error text when the service reports failure.
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
  // Arrange: override the service URL and restore the environment after the test.
  const original = process.env.FIRECRAWL_URL;
  process.env.FIRECRAWL_URL = 'http://localhost:3333/';
  t.after(() => {
    if (original === undefined) delete process.env.FIRECRAWL_URL;
    else process.env.FIRECRAWL_URL = original;
  });
  const controller = new AbortController();
  // Act / Assert: propagate cancellation during the custom-endpoint request.
  await assert.rejects(
    scrapeListing('https://example.test', {
      signal: controller.signal,
      fetch: async (url, init) => {
        // Assert: normalize the configured service URL to the scrape endpoint.
        assert.equal(url, 'http://localhost:3333/v2/scrape');
        // Act: interrupt the request through the caller's abort signal.
        controller.abort(new Error('interrupted'));
        init.signal.throwIfAborted();
      },
    }),
    /interrupted/,
  );
});

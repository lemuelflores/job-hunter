import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageError } from '../dist/review/extraction.js';
import { scrapeListing } from '../dist/review/firecrawl.js';

test('extraction returns usable Markdown unchanged', async () => {
  // Arrange: provide a listing URL and the Markdown returned by the scraper.
  const url = 'https://example.test/job';
  const markdown = '# Backend developer\nWorldwide Laravel role';
  // Act: extract the listing through a successful mocked service response.
  const text = await scrapeListing(url, {
    fetch: async () => Response.json({ success: true, data: { markdown } }),
  });
  // Assert: return the extracted Markdown unchanged.
  assert.equal(text, markdown);
});

test('extraction rejects unsuccessful and empty responses', async () => {
  for (const response of [
    Response.json({ success: false }),
    Response.json({ success: true, data: { markdown: '  ' } }),
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

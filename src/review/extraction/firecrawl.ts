import * as v from 'valibot';
import { type ExtractionOptions, PageError } from './types.js';

const PageUrl = v.pipe(
  v.string(),
  v.url(),
  v.check((url) => url.startsWith('http://') || url.startsWith('https://')),
);
const ScrapeResponse = v.object({
  success: v.boolean(),
  data: v.optional(
    v.object({
      markdown: v.optional(v.string()),
      metadata: v.optional(
        v.object({
          statusCode: v.optional(v.number()),
          error: v.optional(v.unknown()),
        }),
      ),
    }),
  ),
});

export type FirecrawlScrape = v.InferOutput<typeof ScrapeResponse>;

export async function scrapePage(
  url: string,
  options: ExtractionOptions = {},
): Promise<FirecrawlScrape> {
  const pageUrl = v.parse(PageUrl, url, {
    message: 'Invalid Firecrawl page URL',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `${(process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')}/v2/scrape`,
    {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl,
        formats: ['markdown'],
        timeout: 60_000,
      }),
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  return v.parse(ScrapeResponse, await response.json(), {
    message: 'Invalid Firecrawl scrape response',
  });
}

export async function scrapeListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<string> {
  console.info(`[firecrawl] Scraping: ${url}`);
  const scrape = await scrapePage(url, options);
  const status = scrape.data?.metadata?.statusCode ?? 200;
  if (status >= 400) {
    const message = scrape.data?.markdown?.trim()
      ? scrape.data.markdown
      : scrape.data?.metadata?.error;
    throw new PageError(status, typeof message === 'string' ? message : '');
  }
  if (!scrape.success || !scrape.data?.markdown?.trim()) {
    throw new Error(
      'Firecrawl extraction failed or returned empty/error-page Markdown',
    );
  }
  console.info(`[firecrawl] Scraped: ${url}`);
  return scrape.data.markdown;
}

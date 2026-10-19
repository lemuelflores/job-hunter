export class PageError extends Error {
  readonly retryable: boolean;

  constructor(status: number, message = '') {
    super(
      message.trim()
        ? `Page returned ${status} status: “${message.trim().slice(0, 4500)}”`
        : `Page returned ${status} status`,
    );
    this.retryable = [408, 425, 429].includes(status) || status >= 500;
  }
}

export async function scrapeListing(
  url: string,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(75_000);
  console.info(`[firecrawl] Scraping: ${url}`);
  const response = await (options.fetch ?? fetch)(
    `${(process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/$/, '')}/v2/scrape`,
    {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], timeout: 60_000 }),
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
  const scrape = (await response.json()) as {
    success?: boolean;
    data?: {
      markdown?: unknown;
      metadata?: { statusCode?: number; error?: unknown };
    };
  };
  const status = scrape.data?.metadata?.statusCode ?? 200;
  if (status >= 400) {
    const message =
      typeof scrape.data?.markdown === 'string' && scrape.data.markdown.trim()
        ? scrape.data.markdown
        : scrape.data?.metadata?.error;
    throw new PageError(status, typeof message === 'string' ? message : '');
  }
  if (
    !scrape.success ||
    typeof scrape.data?.markdown !== 'string' ||
    !scrape.data.markdown.trim()
  ) {
    throw new Error(
      'Firecrawl extraction failed or returned empty/error-page Markdown',
    );
  }
  console.info(`[firecrawl] Scraped: ${url}`);
  return scrape.data.markdown;
}

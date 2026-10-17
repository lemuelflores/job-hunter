import type { SearchBatchOptions, SearchResult } from '../types.js';

interface AutomOrganicResult {
  title?: string;
  link?: string;
  snippet?: string | null;
  source?: string | null;
  position?: number;
}

interface AutomGoogleSearchResponse {
  organic_results?: AutomOrganicResult[];
  error?: string;
  pagination?: { next?: number; has_next_page?: boolean };
}

function getAutomApiKey(): string {
  const apiKey = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.AUTOM_API_KEY;

  if (!apiKey) {
    throw new Error('AUTOM_API_KEY is not set');
  }

  return apiKey;
}

/**
 * Runs a Google search through Autom.dev's Search endpoint.
 *
 * Autom's endpoint supports Google advanced operators such as site:, inurl:,
 * and intitle:, which makes it suitable for ATS discovery queries.
 */
export async function googleSearch(
  query: string,
  options: SearchBatchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = getAutomApiKey();

  const url = new URL('https://api.autom.dev/v1/google/search');
  url.searchParams.set('query', query);
  if (options.country) url.searchParams.set('gl', options.country);
  url.searchParams.set('hl', options.language ?? 'en');

  console.error(`[google] search: ${query}`);

  const limit = Math.min(100, Math.max(1, options.num ?? 100));
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let page = 1;
  while (results.length < limit) {
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Autom.dev Google search failed: ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AutomGoogleSearchResponse;

    if (data.error) {
      throw new Error(`Autom.dev Google search failed: ${data.error}`);
    }

    const pageResults = (data.organic_results ?? [])
      .filter(
        (item): item is AutomOrganicResult & { link: string; title: string } =>
          typeof item.link === 'string' &&
          Boolean(item.link.trim()) &&
          typeof item.title === 'string' &&
          Boolean(item.title.trim()),
      )
      .map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet ?? undefined,
        position: item.position,
        query,
      }));
    const before = results.length;
    for (const result of pageResults) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
      if (results.length >= limit) break;
    }
    if (results.length === before || !data.pagination?.has_next_page) break;
    const next = data.pagination.next ?? page + 1;
    if (!Number.isSafeInteger(next) || next <= page) break;
    page = next;
  }

  const preview = results
    .slice(0, 3)
    .map((result) => `${result.title} (${result.url})`)
    .join('; ');
  console.error(
    `[google] results: ${results.length}${preview ? ` — ${preview}` : ''}`,
  );

  return results;
}

export interface GoogleSearchFailure {
  query: string;
  error: string;
}

export async function runParallelGoogleSearchesDetailed(
  queries: string[],
  options: SearchBatchOptions = {},
): Promise<{ results: SearchResult[]; failures: GoogleSearchFailure[] }> {
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const results: SearchResult[] = [];
  const failures: GoogleSearchFailure[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= queries.length) return;

      const query = queries[index];
      try {
        results.push(...(await googleSearch(query, options)));
      } catch (error) {
        failures.push({
          query,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queries.length) }, () =>
      worker(),
    ),
  );

  return { results, failures };
}

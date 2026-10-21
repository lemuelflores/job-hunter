import * as v from 'valibot';

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  query: string;
  position?: number;
}

export interface SearchBatchOptions {
  concurrency?: number;
  country?: string;
  language?: string;
  num?: number;
}

export function normalizeGoogleQuery(query: string): string {
  if (typeof query !== 'string' || !query.trim())
    throw new Error('Google query is required');
  return query.replace(/\s+/g, ' ').trim();
}

const OrganicResult = v.object({
  title: v.string(),
  link: v.string(),
  snippet: v.optional(v.unknown()),
  position: v.optional(v.unknown()),
});
const SearchResponse = v.pipe(
  v.unknown(),
  v.check((value) => !Array.isArray(value)),
  v.object({
    organic_results: v.optional(v.array(v.unknown())),
    error: v.optional(v.string()),
    pagination: v.optional(
      v.pipe(
        v.unknown(),
        v.check((value) => !Array.isArray(value)),
        v.object({
          next: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
          has_next_page: v.optional(v.boolean()),
        }),
      ),
    ),
  }),
);

class GoogleSearchError extends Error {
  constructor(
    error: unknown,
    readonly results: SearchResult[],
  ) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
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

async function searchPage(url: URL, apiKey: string) {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    });
    if (response.status === 404) return {};
    if (response.status === 200) break;

    const body = await response.json().catch(() => null);
    const parsed = v.safeParse(
      v.object({
        error: v.pipe(
          v.string(),
          v.check((value) => value.trim().length > 0),
        ),
      }),
      body,
    );
    const message = parsed.success
      ? parsed.output.error
      : `Autom.dev Google search failed (HTTP ${response.status})`;
    const rateLimited =
      response.status === 401 && message.toLowerCase().includes('rate limit');
    if (attempt >= 2 || (!rateLimited && response.status !== 500))
      throw new Error(message);

    const delay = rateLimited ? 2000 : 500 * 2 ** attempt;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  const data = v.parse(SearchResponse, await response.json(), {
    message: 'Invalid Autom.dev search response',
  });
  if (data.error) throw new Error(data.error);
  return data;
}

function pageResults(
  data: v.InferOutput<typeof SearchResponse>,
  query: string,
) {
  return (data.organic_results ?? []).flatMap((item) => {
    if (!v.is(OrganicResult, item) || !item.title.trim() || !item.link.trim())
      return [];
    return [
      {
        title: item.title,
        url: item.link,
        snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
        position:
          typeof item.position === 'number' && Number.isFinite(item.position)
            ? item.position
            : undefined,
        query,
      },
    ];
  });
}

function appendResults(
  results: SearchResult[],
  seen: Set<string>,
  page: SearchResult[],
  limit: number,
) {
  for (const result of page) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    results.push(result);
    if (results.length >= limit) break;
  }
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
  try {
    while (results.length < limit) {
      url.searchParams.set('page', String(page));
      const data = await searchPage(url, apiKey);
      const before = results.length;
      appendResults(results, seen, pageResults(data, query), limit);
      for (const result of results.slice(before))
        console.error(`[google] result: ${result.url}`);
      if (results.length === before || !data.pagination?.has_next_page) break;
      const next = data.pagination.next ?? page + 1;
      if (next <= page) break;
      page = next;
    }
  } catch (error) {
    throw new GoogleSearchError(error, results);
  }

  console.error(`[google] results: ${results.length}`);

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
        if (error instanceof GoogleSearchError) results.push(...error.results);
        failures.push({
          query,
          error: String(error),
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

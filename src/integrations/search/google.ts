import * as v from 'valibot';
import type { AtsDefinition } from '../ats/types.js';
import type { SearchDiscovery, SearchOutcome } from './types.js';

export async function searchGoogleListings(
  config: GoogleConfig,
  ats: AtsDefinition,
): Promise<SearchOutcome> {
  const searched = await runParallelGoogleSearchesDetailed(
    [scopedGoogleQuery(config.query, ats.hosts)],
    { num: 100, ats: ats.selector },
  );
  return {
    discoveries: searched.results.flatMap<SearchDiscovery>((result) => {
      const url = ats.normalizeUrl(result.url);
      return url ? [{ kind: 'url', source: 'google', ...result, url }] : [];
    }),
    failures: searched.failures.map((item) => `${item.query}: ${item.error}`),
  };
}

export interface GoogleConfig {
  enabled: boolean;
  query: string;
}

export const GoogleSchema: v.GenericSchema<unknown, GoogleConfig> = v.pipe(
  v.strictObject({
    enabled: v.boolean(),
    query: v.pipe(
      v.string(),
      v.check(isGoogleBaseQuery, 'Base query must not contain site: operators'),
    ),
  }),
  v.forward(
    v.check(
      (value) => !value.enabled || Boolean(value.query.trim()),
      'Query must not be blank when Google is enabled',
    ),
    ['query'],
  ),
);

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  query: string;
  position?: number;
}

export interface SearchBatchOptions {
  ats?: string;
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

export function isGoogleBaseQuery(query: string): boolean {
  return !/(^|[\s(+-])site\s*:/i.test(query);
}

export function scopedGoogleQuery(
  query: string,
  hosts: readonly string[],
): string {
  const base = normalizeGoogleQuery(query);
  if (!isGoogleBaseQuery(base))
    throw new Error('Google base query must not contain site: operators');
  // Keep domain restrictions first: long upstream queries can lose trailing operators.
  return `(${hosts.map((host) => `site:${host.replace(/^\*\./, '')}`).join(' OR ')}) (${base})`;
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
          next: v.nullish(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
          has_next_page: v.optional(v.boolean()),
        }),
      ),
    ),
  }),
);

class GoogleSearchError extends Error {
  readonly results: SearchResult[];

  constructor(error: unknown, results: SearchResult[]) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
    this.results = results;
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

  const label = options.ats ? `[google:${options.ats}]` : '[google]';

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
      console.error(
        [
          `${label} page ${page}: ${results.length - before} new results (${results.length} total)`,
          `  query: ${query}`,
          ...results.slice(before).map((result) => `  ${result.url}`),
        ].join('\n'),
      );
      if (results.length === before || !data.pagination?.has_next_page) break;
      const next = data.pagination.next ?? page + 1;
      if (next <= page) break;
      page = next;
    }
  } catch (error) {
    console.error(
      [
        `${label} page ${page} failed (${results.length} results retained)`,
        `  query: ${query}`,
        `  error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    );
    throw new GoogleSearchError(error, results);
  }

  console.error(`${label} complete: ${results.length} unique results`);

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

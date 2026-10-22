import * as v from 'valibot';
import type {
  NormalizeListingUrl,
  SearchDiscovery,
  SearchOutcome,
} from './types.js';

export async function searchFreehireListings(
  config: FreehireConfig,
  normalizeUrl: NormalizeListingUrl,
  options: FreehireSearchOptions = {},
): Promise<SearchOutcome> {
  const query = JSON.stringify(config);
  const searched = await searchFreehire(config, options);
  return {
    discoveries: searched.jobs.flatMap<SearchDiscovery>((job) => {
      const url = normalizeUrl(job.url);
      return url
        ? [
            {
              kind: 'url',
              source: 'freehire',
              url,
              title: job.title,
              query,
              postedAt: job.posted_at,
            },
          ]
        : [];
    }),
    failures: searched.failures,
  };
}

export interface FreehireConfig {
  [key: string]: string | string[] | number | boolean | undefined;
  enabled: boolean;
  limit?: number;
  offset?: number;
  description_format?: 'markdown';
}

const nonnegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveInteger = v.pipe(nonnegativeInteger, v.minValue(1));
export const FreehireSchema: v.GenericSchema<unknown, FreehireConfig> = v.pipe(
  v.objectWithRest(
    {
      enabled: v.boolean(),
      limit: v.optional(v.pipe(positiveInteger, v.maxValue(100))),
      offset: v.optional(nonnegativeInteger),
      description_format: v.optional(v.literal('markdown')),
    },
    v.optional(
      v.union([v.string(), v.array(v.string()), v.number(), v.boolean()]),
    ),
  ),
  v.forward(
    v.check(
      (value) => (value.offset ?? 0) + (value.limit ?? 100) <= 10000,
      'offset + limit must not exceed 10000',
    ),
    ['offset'],
  ),
);

function validateFreehire(value: unknown): asserts value is FreehireConfig {
  const parsed = v.safeParse(FreehireSchema, value);
  if (parsed.success) return;
  const issue = parsed.issues[0];
  throw new Error(
    `Invalid profile.ts: freehire.${v.getDotPath(issue) ?? 'enabled'}: ${issue.message}`,
  );
}

export interface FreehireJob {
  url: string;
  title: string;
  description: string;
  company?: string | null;
  location?: string | null;
  countries?: string[] | null;
  regions?: string[] | null;
  work_mode?: string | null;
  posted_at?: string | null;
}
export interface FreehireSearchOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface FreehireSearchResult {
  jobs: FreehireJob[];
  failures: string[];
  total: number;
}
const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ResponseSchema = v.object({
  data: v.array(v.unknown()),
  meta: v.object({
    total: integer,
    limit: v.pipe(integer, v.minValue(1), v.maxValue(100)),
    offset: integer,
    ignored_params: v.optional(v.array(v.unknown())),
    ignored_values: v.optional(v.record(v.string(), v.unknown())),
  }),
});
const JobSchema = v.object({
  url: v.string(),
  title: v.string(),
  description: v.string(),
  company: v.nullish(v.string()),
  location: v.nullish(v.string()),
  countries: v.nullish(v.array(v.string())),
  regions: v.nullish(v.array(v.string())),
  work_mode: v.nullish(v.string()),
  posted_at: v.optional(v.fallback(v.nullable(v.string()), null)),
});

function searchUrl(config: FreehireConfig): URL {
  const url = new URL('https://freehire.me/api/v1/agent/jobs/search');
  for (const [key, value] of Object.entries(config)) {
    if (key === 'enabled' || value === undefined) continue;
    url.searchParams.set(
      key,
      Array.isArray(value) ? value.join(',') : String(value),
    );
  }
  url.searchParams.set('description_format', 'markdown');
  if (!config.sort) url.searchParams.set('sort', 'created_at');
  if (!config.order) url.searchParams.set('order', 'desc');
  return url;
}

interface SearchPage {
  jobs: FreehireJob[];
  count: number;
  total: number;
  remaining: string | null;
  reset: string | null;
}

async function searchPage(
  url: URL,
  options: FreehireSearchOptions,
): Promise<SearchPage> {
  options.signal?.throwIfAborted();
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 75000)];
  if (options.signal) signals.push(options.signal);
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    headers: {
      'User-Agent':
        'lemuelflores/job-hunter (+https://github.com/lemuelflores/job-hunter)',
    },
    signal: AbortSignal.any(signals),
  });
  if (!response.ok)
    throw new Error(
      `Freehire HTTP ${response.status}; retry after ${response.headers.get('retry-after') ?? 'unknown'} seconds`,
    );
  const parsed = v.safeParse(ResponseSchema, await response.json());
  if (!parsed.success) throw new Error('Invalid Freehire search response');
  const { data, meta } = parsed.output;
  if (
    meta.ignored_params?.length ||
    Object.keys(meta.ignored_values ?? {}).length
  )
    throw new Error(
      `Freehire ignored search settings: ${JSON.stringify({ params: meta.ignored_params, values: meta.ignored_values })}`,
    );
  if (
    meta.offset !== Number(url.searchParams.get('offset')) ||
    meta.limit !== Number(url.searchParams.get('limit')) ||
    data.length > meta.limit
  )
    throw new Error('Invalid Freehire pagination response');
  const jobs = data.flatMap((entry) => {
    const job = v.safeParse(JobSchema, entry);
    if (
      !job.success ||
      !job.output.title.trim() ||
      !job.output.description.trim()
    )
      return [];
    return [job.output];
  });
  return {
    jobs,
    count: data.length,
    total: meta.total,
    remaining: response.headers.get('x-ratelimit-remaining'),
    reset: response.headers.get('x-ratelimit-reset'),
  };
}

export async function searchFreehire(
  config: FreehireConfig,
  options: FreehireSearchOptions = {},
): Promise<FreehireSearchResult> {
  validateFreehire(config);
  const result: FreehireSearchResult = { jobs: [], failures: [], total: 0 };
  const url = searchUrl(config);
  const limit = config.limit ?? 100;
  const start = config.offset ?? 0;
  let scanned = 0;
  try {
    while (true) {
      const size = Math.min(limit, 10000 - start - scanned);
      if (size <= 0)
        throw new Error(
          'Freehire pagination boundary reached (10000 rows); narrow the search filters to retrieve remaining results',
        );
      url.searchParams.set('limit', String(size));
      url.searchParams.set('offset', String(start + scanned));
      const page = await searchPage(url, options);
      result.total = page.total;
      result.jobs.push(...page.jobs);
      scanned += page.count;
      if (!page.count || start + scanned >= page.total) break;
      if (page.remaining === '0')
        throw new Error(
          `Freehire rate budget exhausted; retry after ${page.reset ?? 'unknown'} seconds`,
        );
    }
  } catch (error) {
    result.failures.push(
      error instanceof Error ? error.message : String(error),
    );
  }
  console.info(
    `[freehire] Scanned ${scanned} of ${result.total} matching results`,
  );
  return result;
}

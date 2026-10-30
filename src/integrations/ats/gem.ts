import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl } from './url.ts';

const hosts = ['jobs.gem.com'] as const;
const jobId = /^[a-z0-9_-]+$/i;

export function normalizeGemUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2 || !jobId.test(parsed.parts[1])) return null;
  return parsed.url.href;
}

export const gem = {
  selector: 'gem',
  hosts,
  normalizeUrl: normalizeGemUrl,
  extract: fetchGemListing,
} as const satisfies AtsDefinition;

const JobId = v.pipe(v.string(), v.regex(jobId));
const JobResponse = v.looseObject({
  id: JobId,
  absolute_url: v.string(),
  content_plain: v.string(),
  first_published_at: v.optional(v.nullable(v.string())),
});

export type GemJob = v.InferOutput<typeof JobResponse>;

class GemApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Gem API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchJob(
  board: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<GemJob> {
  const postId = v.parse(JobId, id, { message: 'Invalid Gem job ID' });
  const slug = v.parse(v.pipe(v.string(), v.nonEmpty()), board, {
    message: 'Gem board is required',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://api.gem.com/job_board/v0/${encodeURIComponent(slug)}/job_posts/${postId}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new GemApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid Gem job response',
  });
}

export async function fetchGemListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeGemUrl(url);
  if (!validated) throw new Error('Invalid Gem listing URL');
  const [board, id] = new URL(validated).pathname.slice(1).split('/');
  let job: GemJob;
  try {
    job = await fetchJob(decodeURIComponent(board), id, options);
  } catch (error) {
    if (error instanceof GemApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `Gem listing ${id} unavailable`);
    throw error;
  }
  if (job.id !== id || normalizeGemUrl(job.absolute_url) !== validated)
    throw new Error('Gem listing identity mismatch');
  const { content: _content, content_plain, ...metadata } = job;
  const text = content_plain.trim();
  if (!text) throw new Error('Empty Gem description');
  return {
    text: `Gem listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
    postedAt: job.first_published_at ?? null,
  };
}

import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.js';
import type { AtsDefinition } from './types.js';
import { parseListingUrl, UUID } from './url.js';

const hosts = ['ats.rippling.com'] as const;

export function normalizeRipplingUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (!parsed) return null;
  const parts = parsed.parts;
  if (parts.length === 4 && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
  if (parts.length !== 3 || parts[1] !== 'jobs' || !UUID.test(parts[2]))
    return null;
  parsed.url.pathname = `/${parts[0]}/jobs/${parts[2].toLowerCase()}`;
  return parsed.url.href;
}

export const rippling = {
  selector: 'rippling',
  hosts,
  normalizeUrl: normalizeRipplingUrl,
  extract: fetchRipplingListing,
} as const satisfies AtsDefinition;

const JobId = v.pipe(v.string(), v.regex(UUID));
const JobResponse = v.looseObject({
  uuid: JobId,
  url: v.string(),
  description: v.looseObject({
    company: v.optional(v.nullable(v.string())),
    role: v.string(),
  }),
});

export type RipplingJob = v.InferOutput<typeof JobResponse>;

class RipplingApiError extends Error {
  constructor(readonly status: number) {
    super(`Rippling API HTTP ${status}`);
  }
}

export async function fetchJob(
  board: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<RipplingJob> {
  const uuid = v.parse(JobId, id, { message: 'Invalid Rippling job ID' });
  const slug = v.parse(v.pipe(v.string(), v.nonEmpty()), board, {
    message: 'Rippling board is required',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs/${uuid.toLowerCase()}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new RipplingApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid Rippling job response',
  });
}

export async function fetchRipplingListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeRipplingUrl(url);
  if (!validated) throw new Error('Invalid Rippling listing URL');
  const [board, , id] = new URL(validated).pathname.slice(1).split('/');
  let job: RipplingJob;
  try {
    job = await fetchJob(decodeURIComponent(board), id, options);
  } catch (error) {
    if (error instanceof RipplingApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `Rippling listing ${id} unavailable`);
    throw error;
  }
  if (
    job.uuid.toLowerCase() !== id ||
    normalizeRipplingUrl(job.url) !== validated
  )
    throw new Error('Rippling listing identity mismatch');
  const { description, ...metadata } = job;
  const text = [description.company, description.role]
    .map((html) => convert(html ?? '', { wordwrap: false }).trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) throw new Error('Empty Rippling description');
  return {
    text: `Rippling listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    postedAt: null,
  };
}

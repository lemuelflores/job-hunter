import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.js';
import type { AtsDefinition } from './types.js';
import { parseListingUrl } from './url.js';

const hosts = ['jobs.polymer.co'] as const;
const numericId = /^[1-9]\d*$/;

export function normalizePolymerUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2 || !numericId.test(parsed.parts[1]))
    return null;
  return parsed.url.href;
}

export const polymer = {
  selector: 'polymer',
  hosts,
  normalizeUrl: normalizePolymerUrl,
  extract: fetchPolymerListing,
} as const satisfies AtsDefinition;

const JobResponse = v.looseObject({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  job_post_url: v.string(),
  description: v.string(),
  published_at: v.optional(v.nullable(v.string())),
});
const MissingResponse = v.looseObject({
  errors: v.looseObject({
    general: v.pipe(
      v.array(v.picklist(['no job found', 'no careers_page found'])),
      v.length(1),
    ),
  }),
});

export type PolymerJob = v.InferOutput<typeof JobResponse>;

class PolymerApiError extends Error {
  constructor(
    readonly status: number,
    readonly missing = false,
  ) {
    super(`Polymer API HTTP ${status}`);
  }
}

export async function fetchJob(
  organization: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<PolymerJob> {
  const jobId = v.parse(v.pipe(v.string(), v.regex(numericId)), id, {
    message: 'Invalid Polymer job ID',
  });
  const slug = v.parse(v.pipe(v.string(), v.nonEmpty()), organization, {
    message: 'Polymer organization is required',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://api.polymer.co/v1/hire/organizations/${encodeURIComponent(slug)}/jobs/${jobId}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (response.status === 422) {
    const body: unknown = await response.json();
    throw new PolymerApiError(422, v.safeParse(MissingResponse, body).success);
  }
  if (!response.ok) throw new PolymerApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid Polymer job response',
  });
}

export async function fetchPolymerListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizePolymerUrl(url);
  if (!validated) throw new Error('Invalid Polymer listing URL');
  const [organization, id] = new URL(validated).pathname.slice(1).split('/');
  let job: PolymerJob;
  try {
    job = await fetchJob(decodeURIComponent(organization), id, options);
  } catch (error) {
    if (
      error instanceof PolymerApiError &&
      ([404, 410].includes(error.status) || error.missing)
    )
      throw new PageError(error.status, `Polymer listing ${id} unavailable`);
    throw error;
  }
  if (
    String(job.id) !== id ||
    normalizePolymerUrl(job.job_post_url) !== validated
  )
    throw new Error('Polymer listing identity mismatch');
  const { description, ...metadata } = job;
  const text = convert(description, { wordwrap: false }).trim();
  if (!text) throw new Error('Empty Polymer description');
  return {
    text: `Polymer listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    postedAt: job.published_at ?? null,
  };
}

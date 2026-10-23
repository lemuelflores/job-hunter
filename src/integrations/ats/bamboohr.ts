import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl } from './url.ts';

const hosts = ['*.bamboohr.com'] as const;
const JobId = v.pipe(v.string(), v.regex(/^\d+$/));

export function normalizeBamboohrUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2) return null;
  const [section, value] = parsed.parts;
  const id =
    section === 'jobs' && value === 'view.php'
      ? new URL(raw).searchParams.get('id')
      : section === 'careers'
        ? value
        : null;
  if (!id || !/^\d+$/.test(id)) return null;
  parsed.url.pathname = `/careers/${id}`;
  return parsed.url.href;
}

export const bamboohr = {
  selector: 'bamboohr',
  hosts,
  normalizeUrl: normalizeBamboohrUrl,
  extract: fetchBamboohrListing,
} as const satisfies AtsDefinition;

const JobResponse = v.looseObject({
  result: v.looseObject({
    jobOpening: v.looseObject({
      jobOpeningShareUrl: v.string(),
      description: v.string(),
    }),
  }),
});

export type BamboohrJob = v.InferOutput<typeof JobResponse>;

class BamboohrApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`BambooHR API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchJob(
  host: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<BamboohrJob> {
  const jobId = v.parse(JobId, id, { message: 'Invalid BambooHR job ID' });
  const parsed = parseListingUrl(`https://${host}/careers/${jobId}`, hosts);
  if (!parsed || parsed.url.hostname !== host)
    throw new Error('Invalid BambooHR board host');
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://${host}/careers/${jobId}/detail`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new BamboohrApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid BambooHR job response',
  });
}

export async function fetchBamboohrListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeBamboohrUrl(url);
  if (!validated) throw new Error('Invalid BambooHR listing URL');
  const parsed = new URL(validated);
  const id = parsed.pathname.slice('/careers/'.length);
  let data: BamboohrJob;
  try {
    data = await fetchJob(parsed.hostname, id, options);
  } catch (error) {
    if (error instanceof BamboohrApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `BambooHR listing ${id} unavailable`);
    throw error;
  }
  const { description, ...metadata } = data.result.jobOpening;
  if (normalizeBamboohrUrl(metadata.jobOpeningShareUrl) !== validated)
    throw new Error('BambooHR listing identity mismatch');
  const text = convert(description, { wordwrap: false }).trim();
  if (!text) throw new Error('Empty BambooHR description');
  return {
    text: `BambooHR listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    postedAt:
      typeof metadata.datePosted === 'string' ? metadata.datePosted : null,
  };
}

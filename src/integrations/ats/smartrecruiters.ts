import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl } from './url.ts';

const hosts = ['jobs.smartrecruiters.com'] as const;

export function normalizeSmartrecruitersUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2) return null;
  const id = /^(\d+)(?:-[^/]+)?$/.exec(parsed.parts[1])?.[1];
  if (!id) return null;
  parsed.url.pathname = `/${parsed.parts[0]}/${id}`;
  return parsed.url.href;
}

export const smartrecruiters = {
  selector: 'smartrecruiters',
  hosts,
  normalizeUrl: normalizeSmartrecruitersUrl,
  extract: fetchSmartrecruitersListing,
} as const satisfies AtsDefinition;

const Section = v.looseObject({ title: v.string(), text: v.string() });
const JobResponse = v.looseObject({
  id: v.string(),
  jobAd: v.looseObject({ sections: v.record(v.string(), Section) }),
});
export type SmartrecruitersJob = v.InferOutput<typeof JobResponse>;

class SmartrecruitersApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`SmartRecruiters API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchJob(
  company: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<SmartrecruitersJob> {
  v.parse(v.pipe(v.string(), v.nonEmpty()), company, {
    message: 'SmartRecruiters company is required',
  });
  v.parse(v.pipe(v.string(), v.regex(/^\d+$/)), id, {
    message: 'Invalid SmartRecruiters posting ID',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${id}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new SmartrecruitersApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid SmartRecruiters job response',
  });
}

export async function fetchSmartrecruitersListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeSmartrecruitersUrl(url);
  if (!validated) throw new Error('Invalid SmartRecruiters listing URL');
  const [company, id] = new URL(validated).pathname.slice(1).split('/');
  console.info(`[smartrecruiters] Fetching: ${validated}`);
  let job: SmartrecruitersJob;
  try {
    job = await fetchJob(decodeURIComponent(company), id, options);
  } catch (error) {
    if (
      error instanceof SmartrecruitersApiError &&
      [404, 410].includes(error.status)
    )
      throw new PageError(
        error.status,
        `SmartRecruiters listing ${id} unavailable`,
      );
    throw error;
  }
  if (job.id !== id) throw new Error('SmartRecruiters listing ID mismatch');
  const { jobAd, ...metadata } = job;
  const sections = Object.values(jobAd.sections)
    .map(({ title, text }) => {
      const body = convert(text, { wordwrap: false }).trim();
      return body ? `${title}\n${body}` : '';
    })
    .filter(Boolean);
  if (!sections.length) throw new Error('Empty SmartRecruiters description');
  return {
    text: `SmartRecruiters listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${sections.join('\n\n')}`,
    postedAt:
      typeof metadata.releasedDate === 'string' ? metadata.releasedDate : null,
  };
}

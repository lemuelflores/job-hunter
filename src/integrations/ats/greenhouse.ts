import { decodeHTML } from 'entities';
import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.js';
import type { AtsDefinition } from './types.js';
import { parseListingUrl } from './url.js';

const hosts = ['job-boards.greenhouse.io', 'boards.greenhouse.io'] as const;

export function normalizeGreenhouseUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (
    parsed?.parts.length !== 3 ||
    parsed.parts[1] !== 'jobs' ||
    !/^\d+$/.test(parsed.parts[2])
  )
    return null;
  parsed.url.hostname = hosts[0];
  return parsed.url.href;
}

export const greenhouse = {
  selector: 'greenhouse',
  hosts,
  normalizeUrl: normalizeGreenhouseUrl,
  extract: fetchGreenhouseListing,
} as const satisfies AtsDefinition;

const JobResponse = v.looseObject({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  content: v.string(),
});

export type GreenhouseJob = v.InferOutput<typeof JobResponse>;

class GreenhouseApiError extends Error {
  constructor(readonly status: number) {
    super(`Greenhouse API HTTP ${status}`);
  }
}

export async function fetchJob(
  board: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<GreenhouseJob> {
  const jobId = v.parse(v.pipe(v.string(), v.regex(/^\d+$/)), id, {
    message: 'Invalid Greenhouse job ID',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${jobId}?pay_transparency=true`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new GreenhouseApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid Greenhouse job response',
  });
}

export async function fetchGreenhouseListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeGreenhouseUrl(url);
  if (!validated) throw new Error('Invalid Greenhouse listing URL');
  const parsed = new URL(validated);
  if (parsed.hostname !== 'job-boards.greenhouse.io')
    throw new Error('Invalid Greenhouse listing URL');
  const [board, , id] = parsed.pathname.slice(1).split('/');
  console.info(`[greenhouse] Fetching: ${validated}`);
  let job: GreenhouseJob;
  try {
    job = await fetchJob(decodeURIComponent(board), id, options);
  } catch (error) {
    if (
      error instanceof GreenhouseApiError &&
      [404, 410].includes(error.status)
    )
      throw new PageError(error.status, `Greenhouse listing ${id} unavailable`);
    throw error;
  }
  if (String(job.id) !== id) throw new Error('Greenhouse listing ID mismatch');
  const { content, ...metadata } = job;
  // Greenhouse entity-encodes the HTML document as well as entities within it.
  const description = convert(decodeHTML(content), { wordwrap: false }).trim();
  if (!description) throw new Error('Empty Greenhouse description');
  return {
    text: `Greenhouse listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${description}`,
    postedAt:
      typeof metadata.first_published === 'string'
        ? metadata.first_published
        : null,
  };
}

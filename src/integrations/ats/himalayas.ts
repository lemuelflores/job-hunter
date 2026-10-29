import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl } from './url.ts';

const hosts = ['himalayas.app'] as const;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeHimalayasUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (
    parsed?.parts.length !== 4 ||
    parsed.parts[0] !== 'companies' ||
    parsed.parts[2] !== 'jobs' ||
    !slug.test(parsed.parts[1]) ||
    !slug.test(parsed.parts[3])
  )
    return null;
  return parsed.url.href;
}

export const himalayas = {
  selector: 'himalayas',
  hosts,
  normalizeUrl: normalizeHimalayasUrl,
  extract: fetchHimalayasListing,
} as const satisfies AtsDefinition;

const JobResponse = v.looseObject({
  job: v.looseObject({ guid: v.string(), description: v.string() }),
});

export async function fetchHimalayasListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeHimalayasUrl(url);
  if (!validated) throw new Error('Invalid Himalayas listing URL');
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://himalayas.app/jobs/api${new URL(validated).pathname}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (response.status === 410)
    throw new PageError(410, 'Himalayas listing closed');
  if (!response.ok) throw new Error(`Himalayas API HTTP ${response.status}`);
  const { job } = v.parse(JobResponse, await response.json(), {
    message: 'Invalid Himalayas job response',
  });
  if (normalizeHimalayasUrl(job.guid) !== validated)
    throw new Error('Himalayas listing identity mismatch');
  const { description, ...metadata } = job;
  const text = convert(description, { wordwrap: false }).trim();
  if (!text) throw new Error('Empty Himalayas description');
  return {
    text: `Himalayas listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
    ...(typeof metadata.companyName === 'string'
      ? { company: metadata.companyName }
      : {}),
  };
}

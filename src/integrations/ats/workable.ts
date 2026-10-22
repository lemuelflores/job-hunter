import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.js';
import type { AtsDefinition } from './types.js';
import { parseListingUrl } from './url.js';

const hosts = ['apply.workable.com'] as const;

export function normalizeWorkableUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (
    !parsed ||
    ![2, 3].includes(parsed.parts.length) ||
    parsed.parts.at(-2) !== 'j'
  )
    return null;
  const id = parsed.parts.at(-1);
  if (!id || !/^[a-f0-9]{10}$/i.test(id)) return null;
  // shortcut: short and account-scoped URLs deduplicate separately; unify if duplicates appear.
  parsed.url.pathname = `${parsed.parts.length === 3 ? `/${parsed.parts[0]}` : ''}/j/${id.toUpperCase()}`;
  return parsed.url.href;
}

export const workable = {
  selector: 'workable',
  hosts,
  normalizeUrl: normalizeWorkableUrl,
  extract: fetchWorkableListing,
} as const satisfies AtsDefinition;

const Shortcode = v.pipe(v.string(), v.regex(/^[a-f0-9]{10}$/i));
const JobResponse = v.looseObject({
  shortcode: Shortcode,
  description: v.string(),
  requirements: v.optional(v.nullable(v.string())),
  benefits: v.optional(v.nullable(v.string())),
});

export type WorkableJob = v.InferOutput<typeof JobResponse>;

class WorkableApiError extends Error {
  constructor(readonly status: number) {
    super(`Workable API HTTP ${status}`);
  }
}

export async function fetchJob(
  account: string,
  id: string,
  options: ExtractionOptions = {},
): Promise<WorkableJob> {
  const shortcode = v.parse(Shortcode, id, {
    message: 'Invalid Workable shortcode',
  });
  const slug = v.parse(v.pipe(v.string(), v.nonEmpty()), account, {
    message: 'Workable account is required',
  });
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${shortcode.toUpperCase()}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new WorkableApiError(response.status);
  return v.parse(JobResponse, await response.json(), {
    message: 'Invalid Workable job response',
  });
}

async function resolveShortLink(
  id: string,
  options: ExtractionOptions,
): Promise<string> {
  const url = `https://apply.workable.com/j/${id}`;
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(url, {
    redirect: 'manual',
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  });
  await response.body?.cancel();
  if (![301, 302, 307, 308].includes(response.status))
    throw new WorkableApiError(response.status);
  const location = response.headers.get('location');
  const resolved = location
    ? normalizeWorkableUrl(new URL(location, url).href)
    : null;
  if (!resolved || new URL(resolved).hostname !== 'apply.workable.com')
    throw new Error('Invalid Workable short-link redirect');
  const parts = new URL(resolved).pathname.slice(1).split('/');
  if (parts.length !== 3 || parts[2] !== id)
    throw new Error('Invalid Workable short-link redirect');
  return decodeURIComponent(parts[0]);
}

export async function fetchWorkableListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeWorkableUrl(url);
  if (!validated || new URL(validated).hostname !== 'apply.workable.com')
    throw new Error('Invalid Workable listing URL');
  const parts = new URL(validated).pathname.slice(1).split('/');
  const id = parts[parts.length - 1];
  console.info(`[workable] Fetching: ${validated}`);
  let job: WorkableJob;
  try {
    const account =
      parts.length === 2
        ? await resolveShortLink(id, options)
        : decodeURIComponent(parts[0]);
    job = await fetchJob(account, id, options);
  } catch (error) {
    if (error instanceof WorkableApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `Workable listing ${id} unavailable`);
    throw error;
  }
  if (job.shortcode.toUpperCase() !== id)
    throw new Error('Workable listing shortcode mismatch');
  const { description, requirements, benefits, ...metadata } = job;
  const sections = [description, requirements, benefits].map((html) =>
    convert(html ?? '', { wordwrap: false }).trim(),
  );
  if (!sections.some(Boolean)) throw new Error('Empty Workable description');
  const text = [
    sections[0],
    sections[1] ? `Requirements\n${sections[1]}` : '',
    sections[2] ? `Benefits\n${sections[2]}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    text: `Workable listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    postedAt:
      typeof metadata.published === 'string' ? metadata.published : null,
  };
}

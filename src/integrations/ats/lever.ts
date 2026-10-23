import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl, UUID } from './url.ts';

const hosts = ['jobs.lever.co', 'jobs.eu.lever.co'] as const;

export function normalizeLeverUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2 || !UUID.test(parsed.parts[1])) return null;
  parsed.url.pathname = `/${parsed.parts[0]}/${parsed.parts[1].toLowerCase()}`;
  return parsed.url.href;
}

export const lever = {
  selector: 'lever',
  hosts,
  normalizeUrl: normalizeLeverUrl,
  extract: fetchLeverListing,
} as const satisfies AtsDefinition;

const PostingId = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
);
const PostingResponse = v.looseObject({
  id: PostingId,
  descriptionPlain: v.string(),
  lists: v.array(v.looseObject({ text: v.string(), content: v.string() })),
  additionalPlain: v.optional(v.string()),
  salaryDescriptionPlain: v.optional(v.string()),
});

export type LeverPosting = v.InferOutput<typeof PostingResponse>;

class LeverApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Lever API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchPosting(
  site: string,
  id: string,
  region: 'global' | 'eu',
  options: ExtractionOptions = {},
): Promise<LeverPosting> {
  const postingId = v.parse(PostingId, id, {
    message: 'Invalid Lever posting ID',
  });
  const instance = v.parse(v.picklist(['global', 'eu']), region);
  const host = instance === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://${host}/v0/postings/${encodeURIComponent(site)}/${postingId}`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new LeverApiError(response.status);
  return v.parse(PostingResponse, await response.json(), {
    message: 'Invalid Lever posting response',
  });
}

export async function fetchLeverListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeLeverUrl(url);
  if (!validated) throw new Error('Invalid Lever listing URL');
  const parsed = new URL(validated);
  if (!['jobs.lever.co', 'jobs.eu.lever.co'].includes(parsed.hostname))
    throw new Error('Invalid Lever listing URL');
  const [site, id] = parsed.pathname.slice(1).split('/');
  console.info(`[lever] Fetching: ${validated}`);
  let posting: LeverPosting;
  try {
    posting = await fetchPosting(
      decodeURIComponent(site),
      id,
      parsed.hostname === 'jobs.eu.lever.co' ? 'eu' : 'global',
      options,
    );
  } catch (error) {
    if (error instanceof LeverApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `Lever listing ${id} unavailable`);
    throw error;
  }
  if (posting.id.toLowerCase() !== id.toLowerCase())
    throw new Error('Lever listing ID mismatch');
  const {
    descriptionPlain,
    lists,
    additionalPlain,
    salaryDescriptionPlain,
    description: _description,
    opening: _opening,
    openingPlain: _openingPlain,
    descriptionBody: _descriptionBody,
    descriptionBodyPlain: _descriptionBodyPlain,
    additional: _additional,
    salaryDescription: _salaryDescription,
    ...metadata
  } = posting;
  const sections = lists.map(({ text, content }) => {
    const body = convert(content, { wordwrap: false }).trim();
    return body ? `${text}\n${body}` : '';
  });
  const description = [
    descriptionPlain,
    ...sections,
    additionalPlain,
    salaryDescriptionPlain,
  ]
    .filter((section) => section?.trim())
    .join('\n\n')
    .trim();
  if (!description) throw new Error('Empty Lever description');
  return {
    text: `Lever listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${description}`,
  };
}

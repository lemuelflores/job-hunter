import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.js';
import type { AtsDefinition } from './types.js';
import { parseListingUrl, UUID } from './url.js';

const hosts = ['jobs.ashbyhq.com'] as const;

export function normalizeAshbyUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2 || !UUID.test(parsed.parts[1])) return null;
  parsed.url.pathname = `/${parsed.parts[0]}/${parsed.parts[1].toLowerCase()}`;
  return parsed.url.href;
}

export const ashby = {
  selector: 'ashby',
  hosts,
  normalizeUrl: normalizeAshbyUrl,
  extract: fetchAshbyListing,
} as const satisfies AtsDefinition;

const BoardResponse = v.object({
  jobs: v.array(
    v.looseObject({
      jobUrl: v.pipe(v.string(), v.url()),
      descriptionPlain: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
  ),
});

export type AshbyBoard = v.InferOutput<typeof BoardResponse>;

export async function fetchBoard(
  board: string,
  options: ExtractionOptions = {},
): Promise<AshbyBoard> {
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new Error(`Ashby API HTTP ${response.status}`);
  return v.parse(BoardResponse, await response.json(), {
    message: 'Invalid Ashby board response',
  });
}

export async function fetchAshbyListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeAshbyUrl(url);
  if (!validated) throw new Error('Invalid Ashby listing URL');
  const parsed = new URL(validated);
  if (parsed.hostname !== 'jobs.ashbyhq.com')
    throw new Error('Invalid Ashby listing URL');
  const [board, id] = parsed.pathname.slice(1).split('/');
  console.info(`[ashby] Fetching: ${validated}`);
  const data = await fetchBoard(decodeURIComponent(board), options);
  const requestedId = id.toLowerCase();
  const matches = data.jobs.filter((candidate, index) => {
    const canonical = normalizeAshbyUrl(candidate.jobUrl);
    const postingUrl = canonical ? new URL(canonical) : null;
    const [postingBoard, postingId] =
      postingUrl?.pathname.slice(1).split('/') ?? [];
    if (postingUrl?.hostname !== 'jobs.ashbyhq.com' || postingBoard !== board)
      throw new Error(
        `Invalid Ashby posting URL at index ${index} on board ${board}`,
      );
    return postingId.toLowerCase() === requestedId;
  });
  if (matches.length === 0)
    throw new PageError(
      404,
      `Ashby listing ${id} is absent from board ${board}`,
    );
  if (matches.length > 1) throw new Error('Ambiguous Ashby listing');
  const {
    descriptionPlain,
    descriptionHtml: _descriptionHtml,
    ...metadata
  } = matches[0];
  if (!descriptionPlain?.trim())
    throw new Error('Empty or invalid Ashby description');
  return {
    text: `Ashby listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${descriptionPlain}`,
    postedAt:
      typeof metadata.publishedAt === 'string' ? metadata.publishedAt : null,
  };
}

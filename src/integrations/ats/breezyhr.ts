import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl } from './url.ts';

const hosts = ['*.breezy.hr'] as const;
const PositionId = v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/i));

export function normalizeBreezyhrUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (parsed?.parts.length !== 2 || parsed.parts[0] !== 'p') return null;
  const match = parsed.parts[1].match(/^([a-f0-9]{12})(?:-[^/]+)?$/i);
  if (!match) return null;
  parsed.url.pathname = `/p/${match[1].toLowerCase()}`;
  return parsed.url.href;
}

export const breezyhr = {
  selector: 'breezyhr',
  hosts,
  normalizeUrl: normalizeBreezyhrUrl,
  extract: fetchBreezyhrListing,
} as const satisfies AtsDefinition;

const BoardResponse = v.array(
  v.looseObject({ id: PositionId, description: v.string() }),
);

export type BreezyhrBoard = v.InferOutput<typeof BoardResponse>;

class BreezyhrApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`BreezyHR API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchBoard(
  host: string,
  options: ExtractionOptions = {},
): Promise<BreezyhrBoard> {
  const parsed = parseListingUrl(`https://${host}/json`, hosts);
  if (!parsed || parsed.url.hostname !== host)
    throw new Error('Invalid BreezyHR board host');
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://${host}/json?verbose=true`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new BreezyhrApiError(response.status);
  return v.parse(BoardResponse, await response.json(), {
    message: 'Invalid BreezyHR board response',
  });
}

export async function fetchBreezyhrListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizeBreezyhrUrl(url);
  if (!validated) throw new Error('Invalid BreezyHR listing URL');
  const parsed = new URL(validated);
  const id = parsed.pathname.slice(3);
  let board: BreezyhrBoard;
  try {
    board = await fetchBoard(parsed.hostname, options);
  } catch (error) {
    if (error instanceof BreezyhrApiError && [404, 410].includes(error.status))
      throw new PageError(error.status, `BreezyHR listing ${id} unavailable`);
    throw error;
  }
  const matches = board.filter((job) => job.id.toLowerCase() === id);
  if (!matches.length)
    throw new PageError(404, `BreezyHR listing ${id} is absent from board`);
  if (matches.length > 1) throw new Error('Ambiguous BreezyHR listing');
  const { description, ...metadata } = matches[0];
  const text = convert(description, { wordwrap: false }).trim();
  if (!text) throw new Error('Empty BreezyHR description');
  return {
    text: `BreezyHR listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${text}`,
    ...(typeof metadata.name === 'string' ? { title: metadata.name } : {}),
    postedAt:
      typeof metadata.published_date === 'string'
        ? metadata.published_date
        : null,
  };
}

import * as v from 'valibot';
import { normalizeJobUrl } from '../../discovery/job-url.js';
import { type ExtractionOptions, PageError } from './types.js';

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
): Promise<string> {
  const validated = normalizeJobUrl(url);
  if (!validated) throw new Error('Invalid Ashby listing URL');
  const parsed = new URL(validated);
  if (parsed.hostname !== 'jobs.ashbyhq.com')
    throw new Error('Invalid Ashby listing URL');
  const [board, id] = parsed.pathname.slice(1).split('/');
  console.info(`[ashby] Fetching: ${validated}`);
  const data = await fetchBoard(decodeURIComponent(board), options);
  const requestedId = id.toLowerCase();
  const matches = data.jobs.filter((candidate, index) => {
    const canonical = normalizeJobUrl(candidate.jobUrl);
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
  return `Ashby listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${descriptionPlain}`;
}

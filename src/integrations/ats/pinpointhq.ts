import { convert } from 'html-to-text';
import * as v from 'valibot';
import {
  type ExtractedListing,
  type ExtractionOptions,
  PageError,
} from '../extraction.ts';
import type { AtsDefinition } from './types.ts';
import { parseListingUrl, UUID } from './url.ts';

const hosts = ['*.pinpointhq.com'] as const;

export function normalizePinpointhqUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (!parsed || ![2, 3].includes(parsed.parts.length)) return null;
  const parts = parsed.parts;
  if (parts.length === 3 && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(parts[0]))
    return null;
  const [section, id] = parts.slice(-2);
  if (
    !(
      (section === 'postings' && UUID.test(id)) ||
      (section === 'jobs' && /^\d+$/.test(id))
    )
  )
    return null;
  parsed.url.pathname = `/${parts.length === 3 ? `${parts[0]}/` : ''}${section}/${id.toLowerCase()}`;
  return parsed.url.href;
}

export const pinpointhq = {
  selector: 'pinpointhq',
  hosts,
  normalizeUrl: normalizePinpointhqUrl,
  extract: fetchPinpointhqListing,
} as const satisfies AtsDefinition;

const Section = v.optional(v.nullable(v.string()));
const BoardResponse = v.looseObject({
  data: v.array(
    v.looseObject({
      url: v.string(),
      job: v.looseObject({ id: v.pipe(v.string(), v.regex(/^\d+$/)) }),
      description: v.string(),
      key_responsibilities: Section,
      key_responsibilities_header: Section,
      skills_knowledge_expertise: Section,
      skills_knowledge_expertise_header: Section,
      benefits: Section,
      benefits_header: Section,
    }),
  ),
});

export type PinpointhqBoard = v.InferOutput<typeof BoardResponse>;

class PinpointhqApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`PinpointHQ API HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchBoard(
  host: string,
  locale: string = '',
  options: ExtractionOptions = {},
): Promise<PinpointhqBoard> {
  if (locale && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale))
    throw new Error('Invalid PinpointHQ locale');
  const parsed = parseListingUrl(`https://${host}/postings.json`, hosts);
  if (!parsed || parsed.url.hostname !== host)
    throw new Error('Invalid PinpointHQ board host');
  const timeout = AbortSignal.timeout(75_000);
  const response = await (options.fetch ?? fetch)(
    `https://${host}/${locale ? `${locale}/` : ''}postings.json`,
    {
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    },
  );
  if (!response.ok) throw new PinpointhqApiError(response.status);
  return v.parse(BoardResponse, await response.json(), {
    message: 'Invalid PinpointHQ board response',
  });
}

export async function fetchPinpointhqListing(
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractedListing> {
  const validated = normalizePinpointhqUrl(url);
  if (!validated) throw new Error('Invalid PinpointHQ listing URL');
  const parsed = new URL(validated);
  const parts = parsed.pathname.slice(1).split('/');
  const [section, id] = parts.slice(-2);
  let board: PinpointhqBoard;
  try {
    board = await fetchBoard(
      parsed.hostname,
      parts.length === 3 ? parts[0] : '',
      options,
    );
  } catch (error) {
    if (
      error instanceof PinpointhqApiError &&
      [404, 410].includes(error.status)
    )
      throw new PageError(error.status, `PinpointHQ listing ${id} unavailable`);
    throw error;
  }
  const matches = board.data.filter((job) => {
    const canonical = normalizePinpointhqUrl(job.url);
    const candidate = canonical ? new URL(canonical) : null;
    const [candidateSection, candidateId] =
      candidate?.pathname.split('/').slice(-2) ?? [];
    if (
      candidate?.hostname !== parsed.hostname ||
      candidateSection !== 'postings'
    )
      throw new Error('Invalid PinpointHQ posting URL');
    return section === 'jobs' ? job.job.id === id : candidateId === id;
  });
  if (!matches.length)
    throw new PageError(404, `PinpointHQ listing ${id} is absent from board`);
  if (matches.length > 1) throw new Error('Ambiguous PinpointHQ listing');
  const {
    description,
    key_responsibilities,
    skills_knowledge_expertise,
    benefits,
    ...metadata
  } = matches[0];
  const sections = [
    ['', description],
    [
      metadata.key_responsibilities_header ?? 'Responsibilities',
      key_responsibilities,
    ],
    [
      metadata.skills_knowledge_expertise_header ?? 'Skills',
      skills_knowledge_expertise,
    ],
    [metadata.benefits_header ?? 'Benefits', benefits],
  ].map(([header, html]) => {
    const text = convert(html ?? '', { wordwrap: false }).trim();
    return text ? [header, text].filter(Boolean).join('\n') : '';
  });
  if (!sections.some(Boolean)) throw new Error('Empty PinpointHQ description');
  return {
    text: `PinpointHQ listing metadata:\n${JSON.stringify(metadata, null, 2)}\n\nDescription:\n${sections.filter(Boolean).join('\n\n')}`,
    ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
    postedAt: null,
  };
}

import type { AtsDefinition } from './types.js';
import { parseListingUrl } from './url.js';

const hosts = ['*.freshteam.com'] as const;

export function normalizeFreshteamUrl(raw: string): string | null {
  const parsed = parseListingUrl(raw, hosts);
  if (
    parsed?.parts.length !== 3 ||
    parsed.parts[0] !== 'jobs' ||
    !/^[a-z0-9_-]+$/i.test(parsed.parts[1]) ||
    !/^[a-z0-9_-]+$/i.test(parsed.parts[2])
  )
    return null;
  return parsed.url.href;
}

export const freshteam = {
  selector: 'freshteam',
  hosts,
  normalizeUrl: normalizeFreshteamUrl,
} as const satisfies AtsDefinition;

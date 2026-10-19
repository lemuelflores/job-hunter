import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export type SearchTerms = Record<string, string[]>[];

export interface Profile {
  location: string;
  searchLocation: string[];
  title: SearchTerms;
  skills: SearchTerms;
}

function safeTerm(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/["\\\r\n]/.test(value)
  );
}

function validSearchTerms(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every((group) => {
      if (!group || typeof group !== 'object' || Array.isArray(group))
        return false;
      const prototype = Object.getPrototypeOf(group);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const entries = Object.entries(group);
      return (
        entries.length > 0 &&
        entries.every(
          ([term, aliases]) =>
            safeTerm(term) &&
            Array.isArray(aliases) &&
            Array.from(aliases).every(safeTerm),
        )
      );
    })
  );
}

export function validateProfile(value: unknown): Profile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile.ts: expected a default-exported object');
  const profile = value as Record<string, unknown>;
  const keys = ['location', 'title', 'searchLocation', 'skills'];
  for (const key of Object.keys(profile))
    if (!keys.includes(key))
      throw new Error(`Invalid profile.ts: unknown setting ${key}`);
  if (
    typeof profile.location !== 'string' ||
    !profile.location.trim() ||
    profile.location.length > 200 ||
    /[\r\n]/.test(profile.location)
  )
    throw new Error(
      'Invalid profile.ts: location must be a nonempty single-line string (max 200 characters)',
    );
  for (const key of ['title', 'skills']) {
    if (!validSearchTerms(profile[key]))
      throw new Error(
        `Invalid profile.ts: ${key} must be a nonempty array of nonempty canonical-to-alias maps with safe terms (max 200 characters each, no quotes, backslashes or newlines); alias arrays may be empty`,
      );
  }
  const terms = profile.searchLocation;
  if (
    !Array.isArray(terms) ||
    !terms.length ||
    !Array.from(terms).every(safeTerm)
  )
    throw new Error(
      'Invalid profile.ts: searchLocation must be a nonempty array of safe terms (max 200 characters each, no quotes, backslashes or newlines)',
    );
  return profile as unknown as Profile;
}

export async function loadProfile(
  path: string | URL = new URL('../profile.ts', import.meta.url),
): Promise<Profile> {
  const url = path instanceof URL ? path : pathToFileURL(resolve(path));
  let value: unknown;
  try {
    value = (await import(url.href)).default;
  } catch (error) {
    throw new Error(
      `Cannot load profile.ts (${url.href}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return validateProfile(value);
}

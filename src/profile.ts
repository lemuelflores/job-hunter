import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TitleExpression } from './title.js';

export interface Profile {
  location: string;
  searchLocation: string[];
  title: TitleExpression;
  skills: string[];
}

function safeTerm(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/["\\\r\n]/.test(value)
  );
}

function validTitle(value: unknown, ancestors = new Set<unknown>()): boolean {
  if (typeof value === 'string') return safeTerm(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (ancestors.has(value)) return false;
  const node = value as Record<string, unknown>;
  if (
    Object.keys(node).some((key) => !['op', 'terms'].includes(key)) ||
    !['and', 'or'].includes(node.op as string) ||
    !Array.isArray(node.terms) ||
    !node.terms.length
  )
    return false;
  ancestors.add(value);
  const valid = Array.from(node.terms).every((term) =>
    validTitle(term, ancestors),
  );
  ancestors.delete(value);
  return valid;
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
  if (!validTitle(profile.title))
    throw new Error(
      'Invalid profile.ts: title must contain safe nonempty terms or and/or nodes with nonempty terms (max 200 characters per term, no quotes, backslashes or newlines)',
    );
  for (const key of ['searchLocation', 'skills']) {
    const terms = profile[key];
    if (
      !Array.isArray(terms) ||
      !terms.length ||
      !Array.from(terms).every(safeTerm)
    )
      throw new Error(
        `Invalid profile.ts: ${key} must be a nonempty array of safe terms (max 200 characters each, no quotes, backslashes or newlines)`,
      );
  }
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

import { readFileSync } from 'node:fs';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';

export interface Profile {
  location: string;
  searchLocations: string[][];
  roleGroups: string[][];
  skillGroups: string[][];
}

export function loadProfile(
  path: string | URL = new URL('../profile.jsonc', import.meta.url),
): Profile {
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(path, 'utf8'), errors, {
    allowTrailingComma: true,
  });
  if (errors.length)
    throw new Error(
      `Invalid profile.jsonc: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`,
    );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile.jsonc: expected an object');
  const profile = value as Record<string, unknown>;
  const keys = ['location', 'searchLocations', 'roleGroups', 'skillGroups'];
  for (const key of Object.keys(profile))
    if (!keys.includes(key))
      throw new Error(`Invalid profile.jsonc: unknown setting ${key}`);
  if (
    typeof profile.location !== 'string' ||
    !profile.location.trim() ||
    profile.location.length > 200 ||
    /[\r\n]/.test(profile.location)
  )
    throw new Error(
      'Invalid profile.jsonc: location must be a nonempty single-line string (max 200 characters)',
    );
  for (const key of keys.slice(1)) {
    const groups = profile[key];
    if (
      !Array.isArray(groups) ||
      !groups.length ||
      !groups.every(
        (group) =>
          Array.isArray(group) &&
          group.length > 0 &&
          group.every(
            (term) =>
              typeof term === 'string' &&
              term.trim().length > 0 &&
              term.length <= 200 &&
              !/["\r\n]/.test(term),
          ),
      )
    )
      throw new Error(
        `Invalid profile.jsonc: ${key} must contain nonempty groups of terms (max 200 characters each, no quotes or newlines)`,
      );
  }
  return profile as unknown as Profile;
}

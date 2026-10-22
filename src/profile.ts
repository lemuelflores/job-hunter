import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { type FreehireConfig, FreehireSchema } from './discovery/freehire.js';
import { isGoogleBaseQuery } from './discovery/google.js';

export interface Profile {
  review: { location: string; stack: string[] };
  google: { enabled: boolean; query: string };
  freehire: FreehireConfig;
}

const nonblank = v.pipe(
  v.string(),
  v.check((value) => Boolean(value.trim()), 'Value must not be blank'),
);
const ProfileSchema: v.GenericSchema<unknown, Profile> = v.strictObject({
  review: v.strictObject({
    location: nonblank,
    stack: v.pipe(v.array(nonblank), v.minLength(1)),
  }),
  google: v.pipe(
    v.strictObject({
      enabled: v.boolean(),
      query: v.pipe(
        v.string(),
        v.check(
          isGoogleBaseQuery,
          'Base query must not contain site: operators',
        ),
      ),
    }),
    v.forward(
      v.check(
        (value) => !value.enabled || Boolean(value.query.trim()),
        'Query must not be blank when Google is enabled',
      ),
      ['query'],
    ),
  ),
  freehire: FreehireSchema,
});

export function validateProfile(value: unknown): Profile {
  const parsed = v.safeParse(ProfileSchema, value);
  if (parsed.success) return parsed.output;
  const issue = parsed.issues[0];
  throw new Error(
    `Invalid profile.ts: ${v.getDotPath(issue) ?? 'profile'}: ${issue.message}`,
  );
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

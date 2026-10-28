import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';
import {
  type FreehireConfig,
  FreehireSchema,
} from '../integrations/search/freehire.ts';
import {
  type GoogleConfig,
  GoogleSchema,
} from '../integrations/search/google.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadEnvironment(): void {
  try {
    loadEnvFile(resolve(ROOT, '.env'));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
  }
}

export interface Profile {
  google: GoogleConfig;
  freehire: FreehireConfig;
}

const ProfileSchema: v.GenericSchema<unknown, Profile> = v.strictObject({
  google: GoogleSchema,
  freehire: FreehireSchema,
});

export function validateProfile(value: unknown): Profile {
  const parsed = v.safeParse(ProfileSchema, value);
  if (parsed.success) return parsed.output;
  const issue = parsed.issues[0];
  throw new Error(
    `Invalid discovery.ts: ${v.getDotPath(issue) ?? 'discovery'}: ${issue.message}`,
  );
}

export async function loadProfile(
  path: string | URL = new URL('../../discovery.ts', import.meta.url),
): Promise<Profile> {
  const url = path instanceof URL ? path : pathToFileURL(resolve(path));
  let value: unknown;
  try {
    value = (await import(url.href)).default;
  } catch (error) {
    throw new Error(
      `Cannot load discovery.ts (${url.href}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return validateProfile(value);
}

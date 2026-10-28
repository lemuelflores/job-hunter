import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateDocuments } from '../integrations/llm/types.ts';
import { ROOT } from './config.ts';

async function readDocument(root: string, name: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, name));
  } catch (error) {
    throw new Error(`Cannot read required candidate document ${name}`, {
      cause: error,
    });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Invalid UTF-8 in candidate document ${name}`);
  }
  if (!text.trim() || text.includes('\0'))
    throw new Error(`Invalid or empty candidate document ${name}`);
  return text;
}

export async function loadCandidateDocuments(
  root = ROOT,
): Promise<CandidateDocuments> {
  const cv = await readDocument(root, 'cv.md');
  const profile = await readDocument(root, 'candidate-profile.md');
  return { cv, profile };
}

import type { ListingExtractor } from '../extraction.js';

export interface AtsDefinition {
  selector: string;
  hosts: readonly string[];
  normalizeUrl(raw: string): string | null;
  extract?: ListingExtractor;
}

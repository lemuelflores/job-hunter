import type { ListingSource } from '../../core/listing.ts';

interface DiscoveryFields {
  source: ListingSource;
  url: string;
  title: string;
  query: string;
  postedAt?: string | null;
}

export type SearchDiscovery =
  | (DiscoveryFields & { kind: 'url'; snippet?: string })
  | (DiscoveryFields & { kind: 'full-text'; listingText: string });

export interface SearchOutcome {
  discoveries: SearchDiscovery[];
  failures: string[];
}

export type SearchListings = () => Promise<SearchOutcome>;
export type NormalizeListingUrl = (raw: string) => string | null;

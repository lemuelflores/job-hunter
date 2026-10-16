export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  query: string;
  position?: number;
}

export interface SearchBatchOptions {
  concurrency?: number;
  country?: string;
  language?: string;
  num?: number;
}

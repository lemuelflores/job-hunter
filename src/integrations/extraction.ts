export interface ExtractionOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ExtractedListing {
  text: string;
  postedAt?: string | null;
}

export type ListingExtractor = (
  url: string,
  options?: ExtractionOptions,
) => Promise<ExtractedListing>;

export class PageError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message = '') {
    super(
      message.trim()
        ? `Page returned ${status} status: “${message.trim().slice(0, 4500)}”`
        : `Page returned ${status} status`,
    );
    this.status = status;
    this.retryable = [408, 425, 429].includes(status) || status >= 500;
  }
}

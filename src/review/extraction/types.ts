export interface ExtractionOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export type ListingExtractor = (
  url: string,
  options?: ExtractionOptions,
) => Promise<string>;

export class PageError extends Error {
  readonly retryable: boolean;

  constructor(status: number, message = '') {
    super(
      message.trim()
        ? `Page returned ${status} status: “${message.trim().slice(0, 4500)}”`
        : `Page returned ${status} status`,
    );
    this.retryable = [408, 425, 429].includes(status) || status >= 500;
  }
}

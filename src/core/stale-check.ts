export type Availability =
  | { kind: 'available' }
  | { kind: 'missing' }
  | { kind: 'rate-limited'; retryAfter: string | null }
  | { kind: 'inconclusive'; error: string };

export interface StaleCheckClaim {
  id: number;
  url: string;
  startedAt: number;
  version: number;
  provider: string;
  token: string;
}

export function rateLimitDelay(
  retryAfter: string | null,
  consecutive: number,
  now: number,
): number {
  const fallback = 60_000 * 2 ** Math.min(Math.max(consecutive - 1, 0), 10);
  if (!retryAfter) return fallback;
  const value = retryAfter.trim();
  const requested = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(requested) ? Math.max(fallback, requested) : fallback;
}

const units = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
] as const;

export function relativeDate(value: string | null, now: number): string {
  if (!value?.trim()) return 'date unknown';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'date unknown';
  const seconds = (timestamp - now) / 1000;
  if (Math.abs(seconds) < 1) return 'just now';
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === 'second')
      return formatter.format(Math.trunc(seconds / size), unit);
  }
  return 'date unknown';
}

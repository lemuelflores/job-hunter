export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ListingUrl {
  url: URL;
  parts: string[];
}

export function parseListingUrl(
  raw: string,
  hosts: readonly string[],
): ListingUrl | null {
  let url: URL;
  let parts: string[];
  let decoded: string[];
  try {
    url = new URL(raw);
    parts = url.pathname.split('/').filter(Boolean);
    decoded = parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname)
  )
    return null;
  if (!parts.length || decoded.some((part) => /[/\\]/.test(part))) return null;
  parts[0] = encodeURIComponent(decoded[0]);
  url.search = '';
  url.hash = '';
  url.pathname = `/${parts.join('/')}`;
  return { url, parts };
}

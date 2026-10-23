export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ListingUrl {
  url: URL;
  parts: string[];
}

export function matchesAtsHost(
  hostname: string,
  hosts: readonly string[],
): boolean {
  return hosts.some((host) => {
    if (!host.startsWith('*.')) return hostname === host;
    const suffix = host.slice(1);
    const tenant = hostname.slice(0, -suffix.length);
    return (
      hostname.endsWith(suffix) &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenant)
    );
  });
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
    !matchesAtsHost(url.hostname, hosts)
  )
    return null;
  if (!parts.length || decoded.some((part) => /[/\\]/.test(part))) return null;
  parts[0] = encodeURIComponent(decoded[0]);
  url.search = '';
  url.hash = '';
  url.pathname = `/${parts.join('/')}`;
  return { url, parts };
}

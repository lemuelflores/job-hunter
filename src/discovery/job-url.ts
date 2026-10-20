const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Expected: jobs.ashbyhq.com/<board>/<job UUID>; parts = [board, job UUID].
function normalizeAshby(url: URL, parts: string[]): string | null {
  // A board homepage has no job ID; extra segments are not a listing path.
  if (parts.length !== 2) return null;
  // Ashby listing IDs use UUIDs, not arbitrary names or numeric IDs.
  if (!UUID.test(parts[1])) return null;
  url.pathname = `/${parts[0]}/${parts[1].toLowerCase()}`;
  return url.href;
}

// Expected: jobs[.eu].lever.co/<company>/<job UUID>; parts = [company, job UUID].
function normalizeLever(url: URL, parts: string[]): string | null {
  // Exclude company homepages and extra segments such as /<job UUID>/apply.
  if (parts.length !== 2) return null;
  // Lever listing IDs use UUIDs, not arbitrary names or numeric IDs.
  if (!UUID.test(parts[1])) return null;
  url.pathname = `/${parts[0]}/${parts[1].toLowerCase()}`;
  return url.href;
}

// Expected on either Greenhouse host: /<board>/jobs/<numeric job ID>.
// parts = [board, 'jobs', job ID]; board homepages and application paths do not match.
function normalizeGreenhouse(url: URL, parts: string[]): string | null {
  if (parts.length !== 3) return null;
  // The middle segment is the literal route name, not a board or job ID.
  if (parts[1] !== 'jobs') return null;
  // Greenhouse listing IDs contain digits only, unlike Ashby/Lever UUIDs.
  if (!/^\d+$/.test(parts[2])) return null;
  // Both Greenhouse hosts identify the same listings; store only one form.
  url.hostname = 'job-boards.greenhouse.io';
  return url.href;
}

// Return a canonical supported listing URL, or null for invalid/unsupported URLs.
export function normalizeJobUrl(raw: string): string | null {
  let url: URL;
  let parts: string[];
  let decodedParts: string[];
  try {
    url = new URL(raw);
    parts = url.pathname.split('/').filter(Boolean);
    decodedParts = parts.map((part) => decodeURIComponent(part));
  } catch {
    // URL parsing and decoding malformed percent escapes can both throw.
    return null;
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    return null;
  if (parts.length === 0) return null;

  // Reject hidden path separators: %2F decodes to / and %5C to backslash.
  // For example, ex%2Fample must not pass as a single board/company component.
  if (decodedParts.some((part) => /[/\\]/.test(part))) return null;

  // Normalize board encoding and remove tracking for URL deduplication.
  parts[0] = encodeURIComponent(decodedParts[0]);
  url.search = '';
  url.hash = '';
  url.pathname = `/${parts.join('/')}`;

  if (url.hostname === 'jobs.ashbyhq.com') {
    return normalizeAshby(url, parts);
  }
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)) {
    return normalizeLever(url, parts);
  }
  if (
    ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname)
  ) {
    return normalizeGreenhouse(url, parts);
  }
  return null;
}

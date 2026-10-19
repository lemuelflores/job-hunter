// Board homepages and application forms are not individual job listings.
export function jobUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    const valid = [
      'jobs.ashbyhq.com',
      'jobs.lever.co',
      'jobs.eu.lever.co',
    ].includes(url.hostname)
      ? parts.length === 2 && uuid.test(parts[1])
      : ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(
            url.hostname,
          )
        ? parts.length === 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2])
        : false;
    if (!valid || parts.some((part) => /[/\\]/.test(decodeURIComponent(part))))
      return null;
    parts[0] = encodeURIComponent(decodeURIComponent(parts[0]));
    url.search = '';
    url.hash = '';
    if (url.hostname === 'boards.greenhouse.io')
      url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${parts.join('/')}`;
    return url.href;
  } catch {
    return null;
  }
}

import type { Profile } from '../profile.js';

export const ATS_DOMAINS = {
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
  greenhouse: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
} as const;

function alternatives(terms: string[]): string {
  return `(${[...new Set(terms.map((term) => term.trim()))]
    .map((term) => `"${term}"`)
    .join(' OR ')})`;
}

export function buildQueryMatrix(profile: Profile) {
  const roles = alternatives(profile.roleGroups.flat());
  const result: { ats: string; query: string }[] = [];
  for (const [ats, domains] of Object.entries(ATS_DOMAINS)) {
    const sites = `(${domains.map((domain) => `site:${domain}`).join(' OR ')})`;
    for (const skills of profile.skillGroups) {
      for (const locations of profile.searchLocations) {
        result.push({
          ats,
          query: `${sites} ${roles} (developer OR engineer) ${alternatives(skills)} (remote OR "fully remote" OR "work from home") ${alternatives(locations)}`,
        });
      }
    }
  }
  return result;
}

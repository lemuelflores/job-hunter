import type { Profile, SearchTerms } from '../profile.js';

export const ATS_DOMAINS = {
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
  greenhouse: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
} as const;

function renderAlternatives(terms: string[], prefix = ''): string {
  const unique = [...new Set(terms.map((term) => term.trim()))];
  return `(${unique.map((term) => `${prefix}"${term}"`).join(' OR ')})`;
}

export function renderExpression(expression: SearchTerms, prefix = ''): string {
  return expression
    .map((group) =>
      renderAlternatives(
        Object.entries(group).flatMap(([term, aliases]) => [term, ...aliases]),
        prefix,
      ),
    )
    .join(' ');
}

export function renderTitle(expression: SearchTerms): string {
  return renderExpression(expression, 'intitle:');
}

export function buildQueryMatrix(profile: Profile) {
  const title = renderTitle(profile.title);
  const sites = `(${Object.values(ATS_DOMAINS)
    .flat()
    .map((domain) => `site:${domain}`)
    .join(' OR ')})`;
  return [
    {
      ats: 'all',
      query: `${sites} ${title} ${renderExpression(profile.skills)} ${renderAlternatives(profile.searchLocation)}`,
    },
  ];
}

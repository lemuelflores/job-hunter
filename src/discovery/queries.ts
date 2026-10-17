import type { Profile } from '../profile.js';
import { or, type TitleExpression } from '../title.js';

export const ATS_DOMAINS = {
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
  greenhouse: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
} as const;

export function renderExpression(
  expression: TitleExpression,
  prefix = '',
): string {
  if (typeof expression === 'string') return `${prefix}"${expression.trim()}"`;
  const terms = [
    ...new Set(expression.terms.map((term) => renderExpression(term, prefix))),
  ];
  return `(${terms.join(expression.op === 'or' ? ' OR ' : ' ')})`;
}

export function renderTitle(expression: TitleExpression): string {
  return renderExpression(expression, 'intitle:');
}

export function buildQueryMatrix(profile: Profile) {
  const title =
    typeof profile.title !== 'string' && profile.title.op === 'and'
      ? profile.title.terms.map(renderTitle).join(' ')
      : renderTitle(profile.title);
  const sites = `(${Object.values(ATS_DOMAINS)
    .flat()
    .map((domain) => `site:${domain}`)
    .join(' OR ')})`;
  return [
    {
      ats: 'all',
      query: `${sites} ${title} ${renderExpression(or(...profile.skills))} ${renderExpression(or(...profile.searchLocation))}`,
    },
  ];
}

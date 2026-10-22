import type { Profile } from './src/infra/config.ts';

export default {
  review: {
    location: 'Philippines',
    stack: [
      'Laravel',
      'PHP',
      'Vue',
      'Nuxt',
      'Node.js',
      'JavaScript',
      'TypeScript',
    ],
  },
  google: {
    enabled: true,
    query: `
      (intitle:"fullstack" OR intitle:"full stack" OR intitle:"full-stack" OR intitle:"backend" OR intitle:"back end" OR intitle:"back-end" OR intitle:"frontend" OR intitle:"front end" OR intitle:"front-end" OR intitle:"web")
      (intitle:"developer" OR intitle:"engineer")
      ("Laravel" OR "PHP" OR "Vue" OR "Vue.js" OR "VueJS" OR "Nuxt" OR "Nuxt.js" OR "NuxtJS" OR "Node.js" OR "NodeJS" OR "Node" OR "JavaScript" OR "TypeScript")
      ("remote" OR "remote-first" OR "fully remote" OR "global" OR "anywhere in the world" OR "work from home" OR "APAC" OR "Asia" OR "SEA" OR "Philippines")
    `,
  },
  freehire: {
    enabled: true,
    regions: ['global', 'apac', 'none'],
    work_mode: ['remote'],
    category: ['software_engineering', 'backend', 'frontend', 'fullstack'],
    skills: [
      'typescript',
      'javascript',
      'nodejs',
      'vue',
      'php',
      'laravel',
      'nuxt',
    ],
    skills_exclude: ['dotnet'],
    countries: ['ph'],
    countries_exclude: ['in'],
    reality: ['fresh'],
    sort: 'posted_at',
    posted_within_days: 14,
    limit: 100,
  },
} satisfies Profile;

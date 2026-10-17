import type { Profile } from './src/profile.ts';
import { and, or } from './src/title.ts';

export default {
  // Residence for remote hiring eligibility, not a search expression.
  location: 'Philippines',
  title: and(
    or(
      'fullstack',
      'full stack',
      'full-stack',
      'backend',
      'back end',
      'back-end',
      'frontend',
      'front end',
      'front-end',
      'web',
    ),
    or('developer', 'engineer'),
  ),
  // All location and work-arrangement alternatives form one OR group.
  searchLocation: [
    'remote',
    'remote-first',
    'fully remote',
    'global',
    'anywhere in the world',
    'work from home',
    'APAC',
    'Asia',
    'SEA',
    'Philippines',
  ],
  // Skills can occur anywhere on the indexed page, not just in its title.
  skills: [
    'Laravel',
    'PHP',
    'Vue',
    'Vue.js',
    'VueJS',
    'Nuxt',
    'Nuxt.js',
    'NuxtJS',
    'Node.js',
    'NodeJS',
    'Node',
    'JavaScript',
    'TypeScript',
  ],
} satisfies Profile;

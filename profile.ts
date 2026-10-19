import type { Profile } from './src/profile.ts';

export default {
  // Residence for remote hiring eligibility, not a search expression.
  location: 'Philippines',
  // Arrays AND their OR maps; keys and aliases both match, [] keeps the key.
  // [{ backend: ['back-end'], frontend: [] }, { engineer: [] }] => (backend OR back-end OR frontend) AND engineer.
  title: [
    {
      fullstack: ['full stack', 'full-stack'],
      backend: ['back end', 'back-end'],
      frontend: ['front end', 'front-end'],
      web: [],
    },
    { developer: [], engineer: [] },
  ],
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
    {
      Laravel: [],
      PHP: [],
      Vue: ['Vue.js', 'VueJS'],
      Nuxt: ['Nuxt.js', 'NuxtJS'],
      'Node.js': ['NodeJS', 'Node'],
      JavaScript: [],
      TypeScript: [],
    },
  ],
} satisfies Profile;

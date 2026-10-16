import { readFileSync } from 'node:fs';

export const UI_HTML = readFileSync(
  new URL('./ui.html', import.meta.url),
  'utf8',
);

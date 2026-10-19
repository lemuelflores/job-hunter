export const STAGES = ['crawl', 'location', 'stack'] as const;
export type Stage = (typeof STAGES)[number];

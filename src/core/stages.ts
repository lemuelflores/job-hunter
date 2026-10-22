export const STAGES = ['crawl', 'location', 'stack'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageState {
  stage: Stage;
  state: 'pending' | 'complete' | 'failed' | 'terminal' | 'blocked';
  error: string;
  generation: number;
}

export const STAGES = ['crawl', 'assessment'] as const;
export type Stage = (typeof STAGES)[number];
export type StoredStage = Stage | 'location' | 'stack';

export interface StageState {
  stage: StoredStage;
  state: 'pending' | 'complete' | 'failed' | 'terminal' | 'blocked';
  error: string;
  generation: number;
}

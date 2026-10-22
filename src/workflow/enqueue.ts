import { STAGES, type Stage } from '../core/stages.js';
import type { SqliteStore } from '../infra/sqlite.js';

export type EnqueueStage = (stage: Stage, listingId: number) => Promise<void>;
export type SyncListingFailures = (listingId: number) => Promise<void>;

export async function enqueueMissingStages(
  store: SqliteStore,
  id: number,
  enqueue: EnqueueStage,
  only?: Stage,
): Promise<void> {
  for (const stage of only ? [only] : STAGES)
    if (store.needsStage(id, stage)) await enqueue(stage, id);
}

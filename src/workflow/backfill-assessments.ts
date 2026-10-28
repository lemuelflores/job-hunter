import type { SqliteStore } from '../infra/sqlite.ts';
import type { EnqueueStage } from './enqueue.ts';

export async function backfillAssessments(
  store: SqliteStore,
  limit: number,
  enqueue: EnqueueStage,
  id?: number,
): Promise<number[]> {
  const ids = store.queueAssessmentBackfill(limit, id);
  try {
    for (const id of ids) await enqueue('assessment', id);
  } catch (cause) {
    throw new Error(
      'Assessment backfill was saved but delivery failed; run repair --stage assessment',
      { cause },
    );
  }
  return ids;
}

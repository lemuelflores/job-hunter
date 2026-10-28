import type { SqliteStore } from '../infra/sqlite.ts';
import type {
  AssessmentReviewer,
  CandidateDocuments,
} from '../integrations/llm/types.ts';

export async function assessJob(
  store: SqliteStore,
  id: number,
  loadDocuments: () => Promise<CandidateDocuments>,
  review: AssessmentReviewer,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!store.needsStage(id, 'assessment')) return;
  const job = store.getJob(id);
  if (job?.status !== 'active' || job.listing_text === null) return;
  const documents = await loadDocuments();
  signal?.throwIfAborted();
  const assessment = await review({
    listingText: job.listing_text,
    ...documents,
    signal,
  });
  signal?.throwIfAborted();
  store.saveAssessment(id, assessment);
}

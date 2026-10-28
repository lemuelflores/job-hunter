import type { SqliteStore } from '../infra/sqlite.ts';
import type { ReviewListing } from './review-inbox.tsx';

function processingState(
  assessment: ReviewListing['assessment'],
  failed: boolean,
  unavailable: boolean,
  notScheduled: boolean,
): ReviewListing['processing'] {
  if (assessment) return 'complete';
  if (failed) return 'failed';
  if (unavailable) return 'unavailable';
  if (notScheduled) return 'not_scheduled';
  return 'waiting';
}

export function listInbox(store: SqliteStore): ReviewListing[] {
  return (['active', 'hidden', 'rejected'] as const).flatMap((status) =>
    store.listReviewJobs(status).map((job) => {
      const crawl = job.stages.find((stage) => stage.stage === 'crawl');
      const stage = job.stages.find((stage) => stage.stage === 'assessment');
      const failed = [crawl, stage].find((item) => item?.state === 'failed');
      let assessment = null;
      let invalid = false;
      try {
        assessment = store.getAssessment(job.id)?.assessment ?? null;
      } catch {
        invalid = true;
      }
      const processing = processingState(
        assessment,
        Boolean(failed),
        invalid || crawl?.state === 'terminal',
        !stage,
      );
      return {
        id: job.id,
        company: assessment?.company || job.company,
        location: job.location,
        title: job.title,
        url: job.url,
        source: job.source,
        postedAt: job.posted_at,
        foundAt: job.first_seen,
        reviewStatus: status,
        processing,
        assessment,
        error: invalid
          ? 'The saved assessment is unavailable.'
          : failed?.error || (crawl?.state === 'terminal' ? crawl.error : null),
      };
    }),
  );
}

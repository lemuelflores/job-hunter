import type { ReviewStatus } from '../core/listing.ts';

export interface UpdateJobStatusRequest {
  reviewKey: string;
  status: ReviewStatus;
}

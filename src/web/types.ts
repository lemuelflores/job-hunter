import type { ReviewStatus } from '../core/listing.js';

export interface UpdateJobStatusRequest {
  reviewKey: string;
  status: ReviewStatus;
}

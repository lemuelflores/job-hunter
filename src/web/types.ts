import type { ReviewStatus } from '../sqlite.js';

export interface UpdateJobStatusRequest {
  reviewKey: string;
  status: ReviewStatus;
}

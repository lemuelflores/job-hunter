export const REVIEW_STATUSES = ['active', 'hidden', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface UpdateJobStatusRequest {
  reviewKey: string;
  status: ReviewStatus;
}

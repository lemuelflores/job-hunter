import type { Assessment } from '../../../core/assessment.ts';
import {
  assessmentSchema,
  assessListing as assessWithProvider,
} from '../assessment.ts';
import type { AssessmentInput } from '../types.ts';
import { type ChatgptRequest, request } from './request.ts';

export { assessmentSchema };

export async function assessListing(
  input: AssessmentInput,
  send: ChatgptRequest = request,
): Promise<Assessment> {
  return assessWithProvider(input, send);
}

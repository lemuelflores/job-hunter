import { type Assessment, parseAssessment } from '../../../core/assessment.ts';
import type { AssessmentInput } from '../types.ts';
import { assessmentInstructions } from './assessment-prompt.ts';
import { type ChatgptRequest, request } from './request.ts';

const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const strings = { type: 'array', items: text };
const eligibility = {
  type: 'object',
  properties: {
    item: text,
    jd_quote: nullableText,
    candidate_fact: nullableText,
    result: {
      type: 'string',
      enum: ['pass', 'fail', 'not_stated', 'conflicting'],
    },
  },
  required: ['item', 'jd_quote', 'candidate_fact', 'result'],
  additionalProperties: false,
};
const requirement = {
  type: 'object',
  properties: {
    requirement: text,
    priority: {
      type: 'string',
      enum: ['required', 'preferred', 'unspecified'],
    },
    jd_quote: text,
    candidate_evidence: nullableText,
    status: {
      type: 'string',
      enum: ['documented', 'transferable', 'not_documented', 'explicit_gap'],
    },
  },
  required: [
    'requirement',
    'priority',
    'jd_quote',
    'candidate_evidence',
    'status',
  ],
  additionalProperties: false,
};
const assessmentSchema = {
  type: 'object',
  properties: {
    company: nullableText,
    location: nullableText,
    role: nullableText,
    summary: text,
    schedule_manila: nullableText,
    hard_stops: strings,
    eligibility: { type: 'array', items: eligibility },
    requirements: { type: 'array', items: requirement },
    compensation: {
      type: 'object',
      properties: {
        advertised: nullableText,
        vs_profile: {
          type: 'string',
          enum: ['meets', 'below', 'unclear', 'not_stated'],
        },
      },
      required: ['advertised', 'vs_profile'],
      additionalProperties: false,
    },
    strengths: strings,
    concerns: strings,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    decision_changing_questions: strings,
    score: { type: 'number' },
    verdict_reason: text,
    verdict: { type: 'string', enum: ['Apply', 'Maybe', 'Skip'] },
  },
  required: [
    'company',
    'location',
    'role',
    'summary',
    'schedule_manila',
    'hard_stops',
    'eligibility',
    'requirements',
    'compensation',
    'strengths',
    'concerns',
    'confidence',
    'decision_changing_questions',
    'score',
    'verdict_reason',
    'verdict',
  ],
  additionalProperties: false,
};

export async function assessListing(
  input: AssessmentInput,
  send: ChatgptRequest = request,
): Promise<Assessment> {
  for (const [name, value] of Object.entries({
    listingText: input?.listingText,
    cv: input?.cv,
    profile: input?.profile,
  })) {
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${name} is required for assessment`);
  }
  const response = await send(
    input,
    assessmentInstructions,
    JSON.stringify({
      job_description: input.listingText,
      cv: input.cv,
      profile: input.profile,
    }),
    'job_assessment_v1',
    assessmentSchema,
  );
  return parseAssessment(response);
}

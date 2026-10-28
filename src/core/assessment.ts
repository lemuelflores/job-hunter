import * as v from 'valibot';

export const ASSESSMENT_VERSION = 1;

const EligibilitySchema = v.strictObject({
  item: v.string(),
  jd_quote: v.nullable(v.string()),
  candidate_fact: v.nullable(v.string()),
  result: v.picklist(['pass', 'fail', 'not_stated', 'conflicting']),
});

const RequirementSchema = v.strictObject({
  requirement: v.string(),
  priority: v.picklist(['required', 'preferred', 'unspecified']),
  jd_quote: v.string(),
  candidate_evidence: v.nullable(v.string()),
  status: v.picklist([
    'documented',
    'transferable',
    'not_documented',
    'explicit_gap',
  ]),
});

export const AssessmentSchema = v.strictObject({
  company: v.nullable(v.string()),
  location: v.optional(v.nullable(v.string())),
  role: v.nullable(v.string()),
  summary: v.string(),
  schedule_manila: v.nullable(v.string()),
  hard_stops: v.array(v.string()),
  eligibility: v.array(EligibilitySchema),
  requirements: v.array(RequirementSchema),
  compensation: v.strictObject({
    advertised: v.nullable(v.string()),
    vs_profile: v.picklist(['meets', 'below', 'unclear', 'not_stated']),
  }),
  strengths: v.array(v.string()),
  concerns: v.array(v.string()),
  confidence: v.picklist(['high', 'medium', 'low']),
  decision_changing_questions: v.pipe(v.array(v.string()), v.maxLength(3)),
  score: v.pipe(
    v.number(),
    v.finite(),
    v.minValue(1),
    v.maxValue(5),
    v.check((score) => Math.abs(score * 10 - Math.round(score * 10)) < 1e-9),
  ),
  verdict_reason: v.string(),
  verdict: v.picklist(['Apply', 'Maybe', 'Skip']),
});

export type Assessment = v.InferOutput<typeof AssessmentSchema>;

export function parseAssessment(text: string): Assessment {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid assessment JSON');
  }
  const result = v.safeParse(AssessmentSchema, value);
  if (!result.success) throw new Error('Invalid assessment');
  return result.output;
}

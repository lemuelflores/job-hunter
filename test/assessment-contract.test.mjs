import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssessment } from '../src/core/assessment.ts';

function assessment() {
  return {
    company: null,
    role: 'Developer',
    summary: 'Build software.',
    schedule_manila: null,
    hard_stops: [],
    eligibility: [
      {
        item: 'Location',
        jd_quote: null,
        candidate_fact: null,
        result: 'not_stated',
      },
    ],
    requirements: [
      {
        requirement: 'TypeScript',
        priority: 'required',
        jd_quote: 'TypeScript',
        candidate_evidence: null,
        status: 'explicit_gap',
      },
    ],
    compensation: { advertised: null, vs_profile: 'unclear' },
    strengths: [],
    concerns: [],
    confidence: 'medium',
    decision_changing_questions: [],
    score: 3.5,
    verdict_reason: 'Relevant work but an explicit gap.',
    verdict: 'Maybe',
  };
}

test('accepts a complete assessment with nulls, empty arrays and an explicit gap', () => {
  const report = assessment();
  assert.deepEqual(parseAssessment(JSON.stringify(report)), report);
});

for (const [field, values, set] of [
  [
    'eligibility',
    ['pass', 'fail', 'not_stated', 'conflicting'],
    (report, value) => {
      report.eligibility[0].result = value;
    },
  ],
  [
    'priority',
    ['required', 'preferred', 'unspecified'],
    (report, value) => {
      report.requirements[0].priority = value;
    },
  ],
  [
    'requirement',
    ['documented', 'transferable', 'not_documented', 'explicit_gap'],
    (report, value) => {
      report.requirements[0].status = value;
    },
  ],
  [
    'compensation',
    ['meets', 'below', 'unclear', 'not_stated'],
    (report, value) => {
      report.compensation.vs_profile = value;
    },
  ],
  [
    'confidence',
    ['high', 'medium', 'low'],
    (report, value) => {
      report.confidence = value;
    },
  ],
  [
    'verdict',
    ['Apply', 'Maybe', 'Skip'],
    (report, value) => {
      report.verdict = value;
    },
  ],
]) {
  for (const value of values) {
    test(`accepts ${field} value ${value}`, () => {
      const report = assessment();
      set(report, value);
      assert.deepEqual(parseAssessment(JSON.stringify(report)), report);
    });
  }
}

for (const [name, change] of [
  [
    'extra top-level key',
    (report) => {
      report.extra = true;
    },
  ],
  [
    'extra nested key',
    (report) => {
      report.compensation.extra = true;
    },
  ],
  [
    'missing field',
    (report) => {
      delete report.summary;
    },
  ],
  [
    'invalid eligibility',
    (report) => {
      report.eligibility[0].result = 'unknown';
    },
  ],
  [
    'invalid priority',
    (report) => {
      report.requirements[0].priority = 'optional';
    },
  ],
  [
    'invalid requirement status',
    (report) => {
      report.requirements[0].status = 'missing';
    },
  ],
  [
    'invalid compensation',
    (report) => {
      report.compensation.vs_profile = 'unknown';
    },
  ],
  [
    'invalid confidence',
    (report) => {
      report.confidence = 'unknown';
    },
  ],
  [
    'invalid verdict',
    (report) => {
      report.verdict = 'Yes';
    },
  ],
  [
    'score below range',
    (report) => {
      report.score = 0.9;
    },
  ],
  [
    'score above range',
    (report) => {
      report.score = 5.1;
    },
  ],
  [
    'score with excess precision',
    (report) => {
      report.score = 3.25;
    },
  ],
  [
    'too many questions',
    (report) => {
      report.decision_changing_questions = ['a', 'b', 'c', 'd'];
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const report = assessment();
    change(report);
    assert.throws(
      () => parseAssessment(JSON.stringify(report)),
      /Invalid assessment/,
    );
  });
}

test('rejects malformed JSON without exposing its contents', () => {
  assert.throws(
    () => parseAssessment('{ private candidate text'),
    /^Error: Invalid assessment/,
  );
});

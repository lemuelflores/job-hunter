import assert from 'node:assert/strict';
import { createChatgpt } from '../../src/integrations/llm/chatgpt/index.ts';

export const uuid = '12345678-abcd-abcd-abcd-123456789abc';
export const profile = {
  review: {
    location: 'Germany',
    stack: ['Laravel'],
  },
  google: {
    enabled: true,
    query: 'intitle:engineer Laravel (Europe OR worldwide)',
  },
  freehire: { enabled: false, work_mode: ['remote'] },
};
export const location = {
  eligibility: 'ineligible',
  reason: 'US only',
  evidence: 'US residents',
  company: 'Example',
  location: 'US',
  title: 'Reviewed engineer',
};
export const stack = {
  status: 'match',
  reason: 'Laravel role',
  evidence: 'Laravel',
};
export const assessment = {
  company: 'Example',
  role: 'Reviewed engineer',
  summary: 'US Laravel role',
  schedule_manila: null,
  hard_stops: ['US only'],
  eligibility: [],
  requirements: [],
  compensation: { advertised: null, vs_profile: 'not_stated' },
  strengths: [],
  concerns: [],
  confidence: 'high',
  decision_changing_questions: [],
  score: 2,
  verdict_reason: 'US only',
  verdict: 'Skip',
};
export const result = (id) => ({
  source: 'google',
  url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
  title: 'Engineer',
  query: 'remote',
});
export const stages = ['crawl', 'assessment'];

export function stream(decision) {
  return new Response(
    [
      { type: 'response.output_text.delta', delta: JSON.stringify(decision) },
      { type: 'response.completed' },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export function externalFixture(t, respond = () => undefined) {
  const requests = [];
  const unexpected = [];
  const key = process.env.AUTOM_API_KEY;
  process.env.AUTOM_API_KEY = 'fixture-key';
  const http = async (endpoint, init) => {
    const url = new URL(endpoint);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const request = { url, init, body };
    requests.push(request);
    const response = await respond(request);
    if (response !== undefined) return response;
    switch (url.hostname) {
      case 'api.autom.dev':
        return Response.json({ organic_results: [] });
      case 'boards-api.greenhouse.io': {
        const id = Number(url.pathname.split('/').at(-1));
        return Response.json({
          id,
          content: `<p>Listing ${id}: US Laravel role</p>`,
        });
      }
      case 'chatgpt.com':
        assert.equal(body.text.format.name, 'job_assessment_v1');
        return stream(assessment);
      default:
        unexpected.push(url.href);
        throw new Error(`Unexpected external request: ${url}`);
    }
  };
  t.mock.method(globalThis, 'fetch', http);
  const llm = createChatgpt({
    getCredentials: async () => ({
      access: 'fixture-token',
      refresh: 'fixture-refresh',
      expires: Date.now() + 60_000,
    }),
    fetch: http,
  });
  t.after(() => {
    if (key === undefined) delete process.env.AUTOM_API_KEY;
    else process.env.AUTOM_API_KEY = key;
    assert.deepEqual(unexpected, [], 'no unexpected network calls or fallback');
  });
  return {
    requests,
    llm,
  };
}

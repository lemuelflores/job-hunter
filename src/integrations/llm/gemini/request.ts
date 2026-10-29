import * as v from 'valibot';
import {
  AuthenticationError,
  type LlmRequest,
  RateLimitError,
} from '../types.ts';

export interface GeminiRequestDependencies {
  apiKey?: string;
  fetch?: typeof fetch;
}

export type GeminiRequest = LlmRequest;

const PartSchema = v.object({
  text: v.optional(v.string()),
  thought: v.optional(v.boolean()),
});

const CandidateSchema = v.object({
  finishReason: v.optional(v.string()),
  content: v.optional(
    v.object({
      parts: v.optional(v.array(PartSchema)),
    }),
  ),
});

const ResponseSchema = v.object({
  promptFeedback: v.optional(
    v.object({
      blockReason: v.optional(v.string()),
    }),
  ),
  candidates: v.optional(v.array(CandidateSchema)),
});

export function resolveApiKey(apiKey = process.env.GEMINI_API_KEY): string {
  const trimmed = apiKey?.trim();
  if (!trimmed)
    throw new AuthenticationError(
      'Missing GEMINI_API_KEY; set GEMINI_API_KEY in .env or the environment',
    );
  return trimmed;
}

export function createRequest({
  apiKey,
  fetch: fetchRequest = (...args) => fetch(...args),
}: GeminiRequestDependencies = {}): GeminiRequest {
  return async function request(options, instructions, input, _name, schema) {
    options.signal?.throwIfAborted();
    const effort = options.effort ?? process.env.MODEL_EFFORT ?? 'medium';
    if (!['minimal', 'low', 'medium', 'high'].includes(effort))
      throw new Error('Invalid MODEL_EFFORT');
    const model = (
      options.model ??
      process.env.MODEL_NAME ??
      'gemini-3.8-flash'
    )
      .replace(/^(?:google|gemini)\//, '')
      .split('#')[0]
      .trim();
    if (!model) throw new Error('Invalid MODEL_NAME');
    const key = resolveApiKey(apiKey);
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetchRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, timeout])
          : timeout,
        headers: {
          'x-goog-api-key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: instructions }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: input }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            thinkingConfig: {
              thinkingLevel: effort,
            },
          },
        }),
      },
    );
    if ([401, 403].includes(response.status))
      throw new AuthenticationError(
        `Gemini HTTP ${response.status}; check GEMINI_API_KEY`,
      );
    if (response.status === 429)
      throw new RateLimitError('Gemini HTTP 429; quota/rate limit reached');
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
    return readResponse(response);
  };
}

export const request = createRequest();

async function readResponse(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Invalid Gemini response', { cause: error });
  }
  const parsed = v.safeParse(ResponseSchema, payload);
  if (!parsed.success) throw new Error('Invalid Gemini response');
  const { promptFeedback, candidates } = parsed.output;
  if (promptFeedback?.blockReason)
    throw new Error(`Gemini blocked prompt: ${promptFeedback.blockReason}`);
  const candidate = candidates?.[0];
  if (!candidate) throw new Error('Empty Gemini response');
  if (candidate.finishReason !== 'STOP')
    throw new Error(
      `Gemini finishReason: ${candidate.finishReason ?? 'missing'}`,
    );
  const parts = candidate.content?.parts;
  if (!parts?.length) throw new Error('Empty Gemini response');
  const text = parts
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text.trim()) throw new Error('Empty Gemini response');
  return text;
}

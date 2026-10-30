import * as v from 'valibot';
import {
  AuthenticationError,
  type LlmRequest,
  RateLimitError,
} from '../types.ts';

export interface GroqRequestDependencies {
  apiKey?: string;
  fetch?: typeof fetch;
}

export type GroqRequest = LlmRequest;

const ChoiceSchema = v.object({
  finish_reason: v.optional(v.nullable(v.string())),
  message: v.optional(
    v.object({
      content: v.optional(v.nullable(v.string())),
      refusal: v.optional(v.nullable(v.string())),
    }),
  ),
});

const ResponseSchema = v.object({
  choices: v.optional(v.array(ChoiceSchema)),
});

export function resolveApiKey(apiKey = process.env.GROQ_API_KEY): string {
  const trimmed = apiKey?.trim();
  if (!trimmed)
    throw new AuthenticationError(
      'Missing GROQ_API_KEY; set GROQ_API_KEY in .env or the environment',
    );
  return trimmed;
}

export function createRequest({
  apiKey,
  fetch: fetchRequest = (...args) => fetch(...args),
}: GroqRequestDependencies = {}): GroqRequest {
  return async function request(options, instructions, input, name, schema) {
    options.signal?.throwIfAborted();
    const effort = options.effort ?? process.env.MODEL_EFFORT ?? 'medium';
    if (
      ![
        'none',
        'default',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ].includes(effort)
    )
      throw new Error('Invalid MODEL_EFFORT');
    const model = (
      options.model ??
      process.env.MODEL_NAME ??
      'openai/gpt-oss-120b'
    )
      .replace(/^groq\//, '')
      .split('#')[0]
      .trim();
    if (!model) throw new Error('Invalid MODEL_NAME');
    const key = resolveApiKey(apiKey);
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetchRequest(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, timeout])
          : timeout,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          reasoning_effort: effort,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: input },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name,
              strict: true,
              schema,
            },
          },
        }),
      },
    );
    if ([401, 403].includes(response.status))
      throw new AuthenticationError(
        `Groq HTTP ${response.status}; check GROQ_API_KEY`,
      );
    if (response.status === 429)
      throw new RateLimitError('Groq HTTP 429; quota/rate limit reached');
    if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);
    return readResponse(response);
  };
}

export const request = createRequest();

async function readResponse(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Invalid Groq response', { cause: error });
  }
  const parsed = v.safeParse(ResponseSchema, payload);
  if (!parsed.success) throw new Error('Invalid Groq response');
  const choice = parsed.output.choices?.[0];
  if (!choice) throw new Error('Empty Groq response');
  if (choice.message?.refusal)
    throw new Error(`Groq refused prompt: ${choice.message.refusal}`);
  if (choice.finish_reason !== 'stop')
    throw new Error(`Groq finish_reason: ${choice.finish_reason ?? 'missing'}`);
  const text = choice.message?.content;
  if (typeof text !== 'string' || !text.trim())
    throw new Error('Empty Groq response');
  return text;
}

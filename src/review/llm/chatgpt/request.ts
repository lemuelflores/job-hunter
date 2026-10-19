import {
  AuthenticationError,
  RateLimitError,
  type ReviewOptions,
} from '../types.js';
import { getCredentials } from './auth.js';

export async function request(
  options: ReviewOptions,
  instructions: string,
  input: string,
  name: string,
  schema: object,
): Promise<string> {
  const auth = await getCredentials(options);
  const effort = options.effort ?? process.env.MODEL_EFFORT ?? 'medium';
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort))
    throw new Error('Invalid MODEL_EFFORT');
  const timeout = AbortSignal.timeout(120_000);
  // shortcut: subscription backend is undocumented; recheck the contract if requests stop working.
  const response = await (options.fetch ?? fetch)(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
      },
      body: JSON.stringify({
        model: (options.model ?? process.env.MODEL_NAME ?? 'gpt-6-luna')
          .replace(/^openai\//, '')
          .split('#')[0],
        reasoning: { effort },
        instructions,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: input }],
          },
        ],
        store: false,
        stream: true,
        text: {
          format: { type: 'json_schema', name, strict: true, schema },
        },
      }),
    },
  );
  if (response.status === 401 || response.status === 403)
    throw new AuthenticationError(
      `ChatGPT HTTP ${response.status}; run job-hunter auth to sign in again`,
    );
  if (response.status === 429)
    throw new RateLimitError('ChatGPT HTTP 429; quota/rate limit reached');
  if (!response.ok) throw new Error(`ChatGPT HTTP ${response.status}`);
  return readResponse(response);
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('Empty ChatGPT response');
  let buffer = '',
    text = '';
  let completed = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (
      event.type === 'error' ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      throw new Error(`ChatGPT ${event.type}`);
    }
    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.type === 'response.completed') completed = true;
  };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  consume(buffer);
  if (!completed) throw new Error('ChatGPT did not complete response');
  return text;
}

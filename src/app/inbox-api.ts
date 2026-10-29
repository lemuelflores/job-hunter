import * as v from 'valibot';
import { REVIEW_STATUSES } from '../core/listing.ts';
import type { Stage } from '../core/stages.ts';
import type { SqliteStore } from '../infra/sqlite.ts';
import {
  addManualListing,
  InvalidListingUrl,
} from '../workflow/add-manual-listing.ts';
import { validLocalHost } from './local-access.ts';
import { listInbox } from './review-data.ts';

const id = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const statusBody = v.strictObject({ id, status: v.picklist(REVIEW_STATUSES) });
const retryBody = v.strictObject({ id });
const maxBody = 16 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function isJson(request: Request): boolean {
  const type = request.headers.get('content-type');
  return type?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBody) {
      await reader.cancel();
      throw new Error('Request too large');
    }
    chunks.push(chunk.value);
  }
  const bytes = Buffer.concat(chunks);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

interface InboxDependencies {
  store: SqliteStore;
  port: number;
  retry(stage: Stage, id: number): Promise<void>;
  enqueue(stage: Stage, id: number): Promise<void>;
}

function updateStatus(store: SqliteStore, body: unknown): Response {
  const parsed = v.safeParse(statusBody, body);
  if (!parsed.success) return json({ error: 'Invalid request payload' }, 400);
  if (!store.setReviewStatus(String(parsed.output.id), parsed.output.status))
    return json({ error: 'Job not found' }, 404);
  return json({ ok: true });
}

async function retryJob(
  { store, retry }: InboxDependencies,
  body: unknown,
): Promise<Response> {
  const parsed = v.safeParse(retryBody, body);
  if (!parsed.success) return json({ error: 'Invalid request payload' }, 400);
  const job = store.getJob(parsed.output.id);
  if (!job) return json({ error: 'Job not found' }, 404);
  if (job.status !== 'active') return json({ error: 'Job is not active' }, 409);
  const failed = store
    .stages(job.id)
    .find(
      (stage) =>
        (stage.stage === 'crawl' || stage.stage === 'assessment') &&
        stage.state === 'failed',
    );
  if (!failed || (failed.stage !== 'crawl' && failed.stage !== 'assessment'))
    return json({ error: 'No failed stage to retry' }, 409);
  try {
    await retry(failed.stage, job.id);
  } catch {
    return json({ error: 'Retry could not be queued' }, 503);
  }
  return json({ ok: true });
}

async function mutation(
  request: Request,
  path: string,
  deps: InboxDependencies,
): Promise<Response> {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  if (origin && origin !== `http://${host}`)
    return json({ error: 'Origin is not allowed' }, 403);
  if (!isJson(request))
    return json({ error: 'Content-Type must be application/json' }, 400);
  let body: unknown;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (path === '/api/inbox/status') return updateStatus(deps.store, body);
  if (path === '/api/inbox/add') {
    const parsed = v.safeParse(v.strictObject({ url: v.string() }), body);
    if (!parsed.success) return json({ error: 'Invalid request payload' }, 400);
    try {
      return json(
        await addManualListing(deps.store, parsed.output.url, deps.enqueue),
      );
    } catch (error) {
      if (error instanceof InvalidListingUrl)
        return json({ error: error.message }, 400);
      return json(
        {
          error:
            'Listing could not be queued. Run repair to recover saved work.',
        },
        503,
      );
    }
  }
  return retryJob(deps, body);
}

export function createInboxHandler(deps: InboxDependencies) {
  return async (request: Request): Promise<Response> => {
    const host = request.headers.get('host');
    if (!validLocalHost(host, deps.port))
      return json({ error: 'Host is not allowed' }, 403);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/api/inbox')
      return json({ listings: listInbox(deps.store) });
    if (
      request.method !== 'POST' ||
      !['/api/inbox/status', '/api/inbox/retry', '/api/inbox/add'].includes(
        path,
      )
    )
      return json({ error: 'Not found' }, 404);
    return mutation(request, path, deps);
  };
}

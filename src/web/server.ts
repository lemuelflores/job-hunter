import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  REVIEW_STATUSES,
  type ReviewStatus,
  type SqliteStore,
} from '../sqlite.js';
import type { UpdateJobStatusRequest } from './types.js';

export const UI_HTML = readFileSync(
  new URL('./index.html', import.meta.url),
  'utf8',
);

const MAX_BODY_BYTES = 16 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function validStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === 'string' &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

function validLocalHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const address = request.socket.address();
  if (!host || typeof address === 'string' || !('port' in address))
    return false;
  try {
    const parsed = new URL(`http://${host}`);
    return (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port === String(address.port)
    );
  } catch {
    return false;
  }
}

async function updateJobStatus(
  store: SqliteStore,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = (await readJson(
    request,
  )) as Partial<UpdateJobStatusRequest> | null;
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.reviewKey !== 'string' ||
    !body.reviewKey.trim() ||
    !validStatus(body.status)
  )
    return json(response, 400, { error: 'Invalid request payload' });
  if (!store.setReviewStatus(body.reviewKey, body.status))
    return json(response, 404, { error: 'Job not found' });
  return json(response, 200, { ok: true });
}

async function routeRequest(
  store: SqliteStore,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(UI_HTML);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    const rawStatus = url.searchParams.get('status') ?? 'active';
    if (!validStatus(rawStatus))
      return json(response, 400, { error: 'Invalid status' });
    return json(response, 200, { jobs: store.listReviewJobs(rawStatus) });
  }
  if (request.method !== 'POST' || url.pathname !== '/api/jobs/status')
    return json(response, 404, { error: 'Not found' });
  if (!sameOrigin(request))
    return json(response, 403, { error: 'Origin is not allowed' });
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    return json(response, 400, {
      error: 'Content-Type must be application/json',
    });
  return updateJobStatus(store, request, response);
}

export function createReviewServer(store: SqliteStore): Server {
  return createServer(async (request, response) => {
    try {
      if (!validLocalHost(request))
        return json(response, 403, { error: 'Host is not allowed' });
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? '127.0.0.1'}`,
      );
      await routeRequest(store, request, response, url);
    } catch (error) {
      json(
        response,
        error instanceof Error && error.message.includes('too large')
          ? 413
          : 400,
        {
          error: error instanceof Error ? error.message : 'Invalid request',
        },
      );
    }
  });
}

export async function listenReviewServer(
  store: SqliteStore,
  port = 3000,
  host = '127.0.0.1',
): Promise<Server> {
  const server = createReviewServer(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export async function serveReviewServer(store: SqliteStore, port: number) {
  const server = await listenReviewServer(
    store,
    port,
    process.env.JOB_HUNTER_HOST || '127.0.0.1',
  );
  console.log(
    `Review UI: http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  await new Promise<void>((done) => {
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      server.close(() => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        done();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

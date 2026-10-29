import { resolve } from 'node:path';
import { ReviewQueues } from '../../../../infra/bullmq.ts';
import { SqliteStore } from '../../../../infra/sqlite.ts';
import { createInboxHandler } from '../../../inbox-api.ts';
import { validLocalHost, webPort } from '../../../local-access.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const port = webPort();
  if (!validLocalHost(request.headers.get('host'), port))
    return Response.json({ error: 'Host is not allowed' }, { status: 403 });
  const store = new SqliteStore(
    resolve(process.env.JOB_HUNTER_DB_PATH ?? 'jobs.sqlite'),
  );
  try {
    return await createInboxHandler({
      store,
      port,
      enqueue: async (stage, id) => {
        const queues = new ReviewQueues();
        try {
          await queues.enqueue(stage, id);
        } finally {
          await queues.close();
        }
      },
      retry: async (stage, id) => {
        const queues = new ReviewQueues();
        try {
          await queues.retry(store, stage, id);
        } finally {
          await queues.close();
        }
      },
    })(request);
  } finally {
    store.close();
  }
}

export const GET = handle;
export const POST = handle;

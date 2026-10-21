import cron from 'node-cron';
import type { FetchQueue } from '../bullmq.js';

export async function startFetchScheduler(
  queue: FetchQueue,
  expression = process.env.FETCH_CRON || '0 * * * *',
): Promise<void> {
  if (!cron.validate(expression))
    throw new Error('Invalid FETCH_CRON schedule');
  let active: Promise<void> | undefined;
  const run = async () => {
    try {
      await queue.enqueue();
    } catch (error) {
      console.error('[scheduler] Enqueue failed:', error);
    }
  };
  const task = cron.schedule(
    expression,
    () => {
      active = run();
      return active;
    },
    { noOverlap: true, timezone: 'UTC' },
  );
  console.error(`[scheduler] Scheduled ${expression} (UTC)`);
  try {
    await new Promise<void>((done) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        done();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await task.destroy();
    await active;
  }
}

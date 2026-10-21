import cron from 'node-cron';

export async function scheduleFetch(
  enqueue: () => Promise<void>,
  expression = process.env.FETCH_CRON || '0 * * * *',
): Promise<void> {
  if (!cron.validate(expression))
    throw new Error('Invalid FETCH_CRON schedule');
  let active: Promise<void> | undefined;
  const run = async () => {
    try {
      await enqueue();
    } catch (error) {
      console.error('[fetch-scheduler] Enqueue failed:', error);
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
  console.error(`[fetch-scheduler] Scheduled ${expression} (UTC)`);
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

import cron, { type ScheduledTask } from 'node-cron';
import type { DiscoveryQueue } from '../bullmq.js';

export interface DiscoverySchedules {
  google?: DiscoveryQueue;
  freehire?: DiscoveryQueue;
  googleCron?: string;
  freehireCron?: string;
}

export async function startDiscoveryScheduler(
  options: DiscoverySchedules,
): Promise<void> {
  const googleCron =
    options.googleCron ?? process.env.GOOGLE_CRON ?? '0 * * * *';
  const freehireCron =
    options.freehireCron ?? process.env.FREEHIRE_CRON ?? '*/15 * * * *';
  if (options.google && !cron.validate(googleCron))
    throw new Error('Invalid GOOGLE_CRON schedule');
  if (options.freehire && !cron.validate(freehireCron))
    throw new Error('Invalid FREEHIRE_CRON schedule');
  const tasks: ScheduledTask[] = [];
  const active = new Set<Promise<void>>();
  const stopController = new AbortController();
  const stop = () => stopController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const [queue, expression] of [
      [options.google, googleCron],
      [options.freehire, freehireCron],
    ] as const) {
      if (!queue) continue;
      const task = cron.schedule(
        expression,
        () => {
          const work = queue.enqueue().then(
            () => {},
            (error) => {
              console.error(
                `[scheduler] ${queue.source} enqueue failed:`,
                error,
              );
            },
          );
          active.add(work);
          void work.finally(() => active.delete(work));
          return work;
        },
        { noOverlap: true, timezone: 'UTC' },
      );
      tasks.push(task);
      console.error(
        `[scheduler] ${queue.source} scheduled ${expression} (UTC)`,
      );
    }
    if (!tasks.length) throw new Error('No discovery sources enabled');
    if (!stopController.signal.aborted)
      await new Promise<void>((done) =>
        stopController.signal.addEventListener('abort', () => done(), {
          once: true,
        }),
      );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.all(tasks.map((task) => task.destroy()));
    await Promise.all(active);
  }
}

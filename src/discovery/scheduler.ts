import cron, { type ScheduledTask } from 'node-cron';
import type { DiscoveryQueue } from '../bullmq.js';
import { deliveryEvent, diagnosticError } from '../worker-diagnostics.js';

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
        (context) => {
          const identity = {
            source: queue.source,
            scheduled_at: context.date.toISOString(),
          };
          const started = performance.now();
          deliveryEvent({ event: 'scheduler_enqueue_started', ...identity });
          const work = queue.enqueue().then(
            (task) => {
              deliveryEvent({
                event: 'scheduler_enqueue_finished',
                ...identity,
                elapsed_ms: Math.round(performance.now() - started),
                outcome: 'submitted',
                delivery_id: task.id,
              });
            },
            (error) => {
              deliveryEvent({
                event: 'scheduler_enqueue_finished',
                ...identity,
                elapsed_ms: Math.round(performance.now() - started),
                outcome: 'failed',
                recovery: 'next_scheduled_tick',
                error: diagnosticError(error),
              });
            },
          );
          active.add(work);
          void work.finally(() => active.delete(work));
          return work;
        },
        { noOverlap: true, timezone: 'UTC' },
      );
      tasks.push(task);
      task.on('execution:overlap', (context) => {
        deliveryEvent({
          event: 'scheduler_tick_skipped',
          source: queue.source,
          scheduled_at: context.date.toISOString(),
          reason: 'enqueue_in_progress',
        });
      });
      deliveryEvent({
        event: 'scheduler_scheduled',
        source: queue.source,
        cron: expression,
        timezone: 'UTC',
      });
    }
    if (!tasks.length) throw new Error('No discovery sources enabled');
    deliveryEvent({ event: 'scheduler_ready', source_count: tasks.length });
    if (!stopController.signal.aborted)
      await new Promise<void>((done) =>
        stopController.signal.addEventListener('abort', () => done(), {
          once: true,
        }),
      );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    deliveryEvent({
      event: 'scheduler_draining',
      active_enqueues: active.size,
    });
    await Promise.all(tasks.map((task) => task.destroy()));
    await Promise.all(active);
    deliveryEvent({ event: 'scheduler_stopped' });
  }
}

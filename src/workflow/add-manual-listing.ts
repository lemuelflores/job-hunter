import type { SqliteStore } from '../infra/sqlite.ts';
import type { EnqueueStage } from './enqueue.ts';

export class InvalidListingUrl extends Error {}

export async function addManualListing(
  store: SqliteStore,
  input: string,
  enqueue: EnqueueStage,
): Promise<{ id: number; added: boolean }> {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidListingUrl('Invalid listing URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new InvalidListingUrl(
      'Listing URL must be HTTP or HTTPS without credentials',
    );
  const added =
    store.saveResults([
      { source: 'user', url: raw, title: '', query: 'user' },
    ]) > 0;
  const id = store.listingIdForUrl(raw);
  if (id === undefined) throw new Error('Listing could not be saved');
  if (added) await enqueue('crawl', id);
  return { id, added };
}

import type { DiscoveredListing } from '../core/listing.ts';
import type { SqliteStore } from '../infra/sqlite.ts';
import type {
  SearchListings,
  SearchOutcome,
} from '../integrations/search/types.ts';
import {
  type EnqueueStage,
  enqueueMissingStages,
  type SyncListingFailures,
} from './enqueue.ts';

export interface DiscoveryResult {
  ids: number[];
  added: number;
  pending: number;
  failures: string[];
}

export interface DiscoveryDeliveryResult {
  added: number;
  pending: number;
  failure_count: number;
}

export class DiscoveryPartialFailure extends Error {
  readonly result: DiscoveryDeliveryResult;

  readonly outcome: DiscoveryResult;

  constructor(outcome: DiscoveryResult) {
    super(outcome.failures.join('; '));
    this.outcome = outcome;
    this.name = 'DiscoveryPartialFailure';
    this.result = {
      added: outcome.added,
      pending: outcome.pending,
      failure_count: outcome.failures.length,
    };
  }
}

async function saveDiscoveries(
  store: SqliteStore,
  searched: SearchOutcome,
  enqueue: EnqueueStage,
  syncFailures: SyncListingFailures,
): Promise<DiscoveryResult> {
  const results: DiscoveredListing[] = searched.discoveries.map(
    ({ kind: _kind, ...listing }) => listing,
  );
  const added = store.saveResults(results);
  const urls = new Set(results.map((listing) => listing.url));
  const ids = store
    .unfinished()
    .filter((job) => urls.has(job.url))
    .map((job) => job.id);
  for (const id of ids) {
    await syncFailures(id);
    await enqueueMissingStages(store, id, enqueue);
  }
  const outcome = {
    ids,
    added,
    pending: store.pendingCount(),
    failures: searched.failures,
  };
  if (outcome.failures.length) throw new DiscoveryPartialFailure(outcome);
  return outcome;
}

export async function discoverGoogleJobs(
  store: SqliteStore,
  search: SearchListings,
  enqueue: EnqueueStage,
  syncFailures: SyncListingFailures,
): Promise<DiscoveryResult> {
  return saveDiscoveries(store, await search(), enqueue, syncFailures);
}

export async function discoverFreehireJobs(
  store: SqliteStore,
  search: SearchListings,
  enqueue: EnqueueStage,
  syncFailures: SyncListingFailures,
): Promise<DiscoveryResult> {
  return saveDiscoveries(store, await search(), enqueue, syncFailures);
}

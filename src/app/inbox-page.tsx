import { resolve } from 'node:path';
import { notFound, redirect } from 'next/navigation.js';
import { SqliteStore } from '../infra/sqlite.ts';
import { LiveInbox } from './live-inbox.tsx';
import { listInbox } from './review-data.ts';
import type { ReviewLoadState } from './review-inbox.tsx';

export function InboxPage({ id }: { id: number | null }) {
  let state: ReviewLoadState;
  try {
    const store = new SqliteStore(
      resolve(process.env.JOB_HUNTER_DB_PATH ?? 'jobs.sqlite'),
    );
    try {
      state = { status: 'ready', listings: listInbox(store) };
    } finally {
      store.close();
    }
  } catch {
    state = { status: 'error' };
  }
  if (
    id !== null &&
    state.status === 'ready' &&
    !state.listings.some((item) => item.id === id)
  )
    notFound();
  if (id === null && state.status === 'ready') {
    const first = state.listings.find((item) => item.reviewStatus === 'active');
    if (first) redirect(`/${first.id}`);
  }
  return <LiveInbox initialState={state} initialNow={Date.now()} />;
}

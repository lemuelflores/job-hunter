'use client';

import { usePathname } from 'next/navigation.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as v from 'valibot';
import { AssessmentSchema } from '../core/assessment.ts';
import {
  type ReviewLoadState,
  ReviewScreen,
  type ReviewStatus,
} from './review-inbox.tsx';

const listingSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  company: v.string(),
  location: v.string(),
  title: v.string(),
  url: v.string(),
  source: v.string(),
  postedAt: v.nullable(v.string()),
  foundAt: v.nullable(v.string()),
  reviewStatus: v.picklist(['active', 'hidden', 'rejected']),
  processing: v.picklist([
    'waiting',
    'complete',
    'failed',
    'unavailable',
    'not_scheduled',
  ]),
  assessment: v.nullable(AssessmentSchema),
  error: v.nullable(v.string()),
});
const inboxSchema = v.object({ listings: v.array(listingSchema) });

async function fetchInbox(signal: AbortSignal) {
  const response = await fetch('/api/inbox', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load listings');
  const result = v.safeParse(inboxSchema, await response.json());
  if (!result.success) throw new Error('Invalid listings response');
  return result.output.listings;
}

export function LiveInbox({
  initialState,
  initialNow,
}: {
  initialState: ReviewLoadState;
  initialNow: number;
}) {
  const [state, setState] = useState<ReviewLoadState>(initialState);
  const [now, setNow] = useState(initialNow);
  const pathname = usePathname();
  const selectedId = /^\/[1-9]\d*$/.test(pathname)
    ? Number(pathname.slice(1))
    : null;
  const [refreshError, setRefreshError] = useState(false);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!active.current) return;
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => active.current && !controller.signal.aborted;
    try {
      const listings = await fetchInbox(controller.signal);
      if (!isCurrent()) return;
      setState({ status: 'ready', listings });
      setNow(Date.now());
      setRefreshError(false);
    } catch {
      if (!isCurrent()) return;
      setState((current) =>
        current.status === 'ready' ? current : { status: 'error' },
      );
      setRefreshError(true);
    } finally {
      if (isCurrent()) timer.current = setTimeout(() => void load(), 5000);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  async function mutate(path: string, body: object, onSuccess?: () => void) {
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Action failed');
      onSuccess?.();
    } finally {
      await load();
    }
  }

  return (
    <>
      {refreshError && state.status === 'ready' && (
        <p role="alert">Could not refresh listings. Retrying…</p>
      )}
      <ReviewScreen
        state={state}
        now={now}
        selectedId={selectedId}
        onSelect={(id, mode = 'push') => {
          const path = id === null ? '/' : `/${id}`;
          if (window.location.pathname === path) return;
          if (mode === 'replace') window.history.replaceState(null, '', path);
          else window.history.pushState(null, '', path);
        }}
        onReload={() => void load()}
        onStatusChange={(id: number, status: ReviewStatus) =>
          mutate('/api/inbox/status', { id, status }, () => {
            setState((current) =>
              current.status === 'ready'
                ? {
                    status: 'ready',
                    listings: current.listings.map((listing) =>
                      listing.id === id
                        ? { ...listing, reviewStatus: status }
                        : listing,
                    ),
                  }
                : current,
            );
          })
        }
        onRetry={(id: number) => mutate('/api/inbox/retry', { id })}
      />
    </>
  );
}

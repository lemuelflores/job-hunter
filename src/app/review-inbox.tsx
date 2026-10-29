'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Assessment } from '../core/assessment.ts';
import { relativeDate } from './relative-date.ts';

export type ReviewStatus = 'active' | 'hidden' | 'rejected' | 'stale';
export interface ReviewListing {
  id: number;
  company: string;
  location: string;
  title: string;
  url: string;
  source: string;
  postedAt: string | null;
  foundAt: string | null;
  reviewStatus: ReviewStatus;
  processing:
    | 'waiting'
    | 'complete'
    | 'failed'
    | 'unavailable'
    | 'not_scheduled';
  assessment: Assessment | null;
  error: string | null;
}

interface ReviewInboxProps {
  listings: ReviewListing[];
  onStatusChange: (id: number, status: ReviewStatus) => Promise<void>;
  onRetry: (id: number) => Promise<void>;
  addControl?: ReactNode;
  now?: number;
  selectedId?: number | null;
  onSelect?: (id: number | null, mode?: 'push' | 'replace') => void;
}

export type ReviewLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; listings: ReviewListing[] };

export function ReviewScreen({
  state,
  onStatusChange,
  onRetry,
  onReload,
  now,
  selectedId,
  onSelect,
  addControl,
}: {
  state: ReviewLoadState;
  onStatusChange: ReviewInboxProps['onStatusChange'];
  onRetry: ReviewInboxProps['onRetry'];
  onReload: () => void;
  now?: number;
  selectedId?: number | null;
  onSelect?: (id: number | null, mode?: 'push' | 'replace') => void;
  addControl?: ReactNode;
}) {
  if (state.status === 'loading')
    return (
      <main className="review">
        <h1>Job Hunter</h1>
        <p role="status">Loading listings…</p>
      </main>
    );
  if (state.status === 'error')
    return (
      <main className="review">
        <h1>Job Hunter</h1>
        <p role="alert">Could not load listings.</p>
        <button type="button" className="button" onClick={onReload}>
          Try again
        </button>
      </main>
    );
  return (
    <ReviewInbox
      listings={state.listings}
      onStatusChange={onStatusChange}
      onRetry={onRetry}
      addControl={addControl}
      now={now}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

function label(value: string | null): string {
  return value ? value.replaceAll('_', ' ') : 'Not stated';
}

const processingLabels: Record<ReviewListing['processing'], string> = {
  waiting: 'Queued',
  complete: 'Evaluated',
  failed: 'Failed',
  unavailable: 'Unavailable',
  not_scheduled: 'Not evaluated',
};

const processingColors: Record<ReviewListing['processing'], string> = {
  waiting: 'neutral',
  complete: 'good',
  failed: 'bad',
  unavailable: 'bad',
  not_scheduled: 'neutral',
};

const assessmentColors = {
  pass: 'good',
  documented: 'good',
  conflicting: 'warning',
  transferable: 'warning',
  fail: 'bad',
  not_documented: 'warning',
  required: 'info',
  preferred: 'neutral',
  unspecified: 'neutral',
  not_stated: 'neutral',
  explicit_gap: 'neutral',
} as const;

function AssessmentBadge({ value }: { value: keyof typeof assessmentColors }) {
  return (
    <span className={`badge badge--${assessmentColors[value]}`}>
      {label(value)}
    </span>
  );
}

function sourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function Points({ items }: { items: string[] }) {
  if (!items.length) return <p className="report__muted">None recorded.</p>;
  return (
    <ul className="report__points">
      {items.map((item, index) => (
        <li className="report__point" key={`${index}-${item}`}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Brief({
  title,
  children,
  kind = 'confidence',
}: {
  title: string;
  children: ReactNode;
  kind?:
    | 'confidence'
    | 'verdict'
    | 'hard-stops'
    | 'questions'
    | 'concerns'
    | 'strengths';
}) {
  return (
    <section
      className={`report__section report__section--brief report__section--${kind}`}
    >
      <h3 className="report__section-title">{title}</h3>
      {children}
    </section>
  );
}

function EvaluationState({ listing }: { listing: ReviewListing }) {
  const message =
    listing.error ||
    {
      waiting: 'This evaluation is waiting to start.',
      not_scheduled: 'This evaluation has not been queued.',
      failed: 'The evaluation could not be completed.',
      unavailable: 'The evaluation could not be completed.',
      complete: 'The evaluation could not be completed.',
    }[listing.processing];
  const kind =
    listing.processing === 'failed' || listing.processing === 'unavailable'
      ? 'hard-stops'
      : 'confidence';
  return (
    <div className="report__body">
      <Brief title="Evaluation" kind={kind}>
        <p className="report__verdict">{message}</p>
      </Brief>
    </div>
  );
}

function Report({
  listing,
  onStatusChange,
  onRetry,
  now,
}: {
  listing: ReviewListing;
  onStatusChange: ReviewInboxProps['onStatusChange'];
  onRetry: ReviewInboxProps['onRetry'];
  now: number;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const report = listing.assessment;
  const url = sourceUrl(listing.url);
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError('Action failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="report__header">
        <div className="report__identity">
          <p className="report__eyebrow">
            {listing.company || 'Company not stated'} ·{' '}
            {listing.location?.trim() || 'Location unknown'}
          </p>
          <h2 id="report-heading" tabIndex={-1} className="report__title">
            {listing.title || 'Role not stated'}
          </h2>
        </div>
        <div className="report__dates">
          <span>Source: {label(listing.source)}</span>
          <span>Posted: {relativeDate(listing.postedAt, now)}</span>
          <span>Found: {relativeDate(listing.foundAt, now)}</span>
        </div>
        <div className="report__labels">
          <span
            className={`badge badge--${processingColors[listing.processing]}`}
          >
            {processingLabels[listing.processing]}
          </span>
          {report && (
            <>
              <span className={`badge badge--${report.verdict.toLowerCase()}`}>
                Recommendation: {report.verdict}
              </span>
              <span className="badge">Evaluation score: {report.score}</span>
              <span className="badge badge--evidence">
                Confidence: {report.confidence}
              </span>
            </>
          )}
        </div>
      </header>
      <div className="report__toolbar">
        <div className="report__actions">
          {url ? (
            <a
              className="button button--primary"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View
            </a>
          ) : (
            <span>Source link unavailable</span>
          )}
          {listing.reviewStatus === 'active' ? (
            <>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(() => onStatusChange(listing.id, 'hidden'))
                }
              >
                Hide
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(() => onStatusChange(listing.id, 'rejected'))
                }
              >
                Reject
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(() => onStatusChange(listing.id, 'stale'))
                }
              >
                Stale
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void action(() => onStatusChange(listing.id, 'active'))
              }
            >
              Restore
            </button>
          )}
          {listing.reviewStatus === 'active' &&
            listing.processing === 'failed' && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void action(() => onRetry(listing.id))}
              >
                Retry
              </button>
            )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {!report ? (
        <EvaluationState listing={listing} />
      ) : (
        <section className="report__body" aria-label="Evaluation brief">
          <Brief title="Verdict" kind="verdict">
            <p className="report__verdict">{report.verdict_reason}</p>
          </Brief>
          <Brief title="Hard stops" kind="hard-stops">
            <Points items={report.hard_stops} />
          </Brief>
          <Brief title="Decision-changing questions" kind="questions">
            <Points items={report.decision_changing_questions} />
          </Brief>
          <div className="report__comparison">
            <Brief title="Concerns to weigh" kind="concerns">
              <Points items={report.concerns} />
            </Brief>
            <Brief title="Strengths" kind="strengths">
              <Points items={report.strengths} />
            </Brief>
          </div>
          <Brief title="Role summary">
            <div>
              <p className="report__verdict">{report.summary}</p>
              <p className="report__detail">
                Company: {label(report.company)} · Role: {label(report.role)}
              </p>
            </div>
          </Brief>
          <Brief title="Compensation">
            <div>
              <p className="report__verdict">
                {label(report.compensation.advertised)}
              </p>
              <p className="report__detail">
                Compared with profile: {label(report.compensation.vs_profile)}
              </p>
            </div>
          </Brief>
          <Brief title="Schedule">
            <p className="report__verdict">
              Manila time: {label(report.schedule_manila)}
            </p>
          </Brief>
          <details className="report__section report__disclosure" open>
            <summary className="report__section-title">
              Eligibility · {report.eligibility.length} checks
            </summary>
            <div className="report__table-scroll">
              <table className="report__table">
                <thead>
                  <tr>
                    {[
                      'Check',
                      'Result',
                      'Job description',
                      'Candidate fact',
                    ].map((name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.eligibility.map((item, index) => (
                    <tr key={index}>
                      <th scope="row">{item.item}</th>
                      <td>
                        <AssessmentBadge value={item.result} />
                      </td>
                      <td>{label(item.jd_quote)}</td>
                      <td>{label(item.candidate_fact)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details className="report__section report__disclosure" open>
            <summary className="report__section-title">
              Requirements · {report.requirements.length}
            </summary>
            <div className="report__table-scroll">
              <table className="report__table">
                <thead>
                  <tr>
                    {[
                      'Requirement',
                      'Priority',
                      'Status',
                      'Job description',
                      'Candidate evidence',
                    ].map((name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.requirements.map((item, index) => (
                    <tr key={index}>
                      <th scope="row">{item.requirement}</th>
                      <td>
                        <AssessmentBadge value={item.priority} />
                      </td>
                      <td>
                        <AssessmentBadge value={item.status} />
                      </td>
                      <td>{label(item.jd_quote)}</td>
                      <td>{label(item.candidate_evidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </>
  );
}

export function ReviewInbox({
  listings,
  onStatusChange,
  onRetry,
  now,
  selectedId,
  onSelect,
  addControl,
}: ReviewInboxProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ReviewStatus>(
    () =>
      listings.find((item) => item.id === selectedId)?.reviewStatus ?? 'active',
  );
  const [verdicts, setVerdicts] = useState<Assessment['verdict'][]>([]);
  const [localSelected, setLocalSelected] = useState<number | null>(null);
  const previousSelectedId = useRef(selectedId);
  const selected = selectedId === undefined ? localSelected : selectedId;
  const currentTime = now ?? Date.now();
  function select(id: number | null, mode: 'push' | 'replace' = 'push') {
    if (onSelect) onSelect(id, mode);
    else setLocalSelected(id);
  }
  useEffect(() => {
    if (previousSelectedId.current === selectedId) return;
    previousSelectedId.current = selectedId;
    if (selectedId == null) return;
    const selectedListing = listings.find((item) => item.id === selectedId);
    if (!selectedListing) return;
    setStatus(selectedListing.reviewStatus);
    const searchable = [
      selectedListing.company,
      selectedListing.title,
      selectedListing.processing,
      selectedListing.assessment?.verdict ?? '',
    ];
    if (
      !searchable.some((value) =>
        value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      )
    )
      setQuery('');
    if (
      verdicts.length &&
      (!selectedListing.assessment ||
        !verdicts.includes(selectedListing.assessment.verdict))
    )
      setVerdicts([]);
  }, [selectedId, listings, query, verdicts]);
  const filtered = listings.filter(
    (item) =>
      item.reviewStatus === status &&
      (!verdicts.length ||
        (item.assessment && verdicts.includes(item.assessment.verdict))) &&
      [
        item.company,
        item.title,
        item.processing,
        item.assessment?.verdict ?? '',
      ].some((value) =>
        value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
  );
  const current = filtered.find((item) => item.id === selected) ?? filtered[0];
  useEffect(() => {
    if (!onSelect) return;
    const selectedListing = listings.find((item) => item.id === selected);
    if (selectedListing && selectedListing.reviewStatus !== status) return;
    if (selectedListing && !filtered.some((item) => item.id === selected))
      return;
    const currentId = current?.id ?? null;
    if (selected !== currentId) onSelect(currentId, 'replace');
  }, [current?.id, filtered, listings, onSelect, selected, status]);
  return (
    <main className="review">
      <header className="review__header">
        <h1 className="review__title">Job Hunter</h1>
        {addControl}
      </header>
      <div className="review__columns">
        <aside className="inbox" aria-label="Evaluations">
          <div className="inbox__header">
            <label className="inbox__label" htmlFor="search">
              Find an evaluation
            </label>
            <div className="search-box">
              <input
                className="inbox__search"
                id="search"
                type="search"
                placeholder="Company, role or verdict"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (selected !== null) select(null, 'replace');
                }}
              />
              <details className="filters">
                <summary
                  className="filters__toggle"
                  aria-label="Filters"
                  title="Filters"
                >
                  ☰
                </summary>
                <div className="filters__panel">
                  <div className="filters__heading">Filter listings</div>
                  <label className="filters__field">
                    Review status{' '}
                    <select
                      className="filters__select"
                      aria-label="Review status"
                      value={status}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (
                          value === 'active' ||
                          value === 'hidden' ||
                          value === 'rejected' ||
                          value === 'stale'
                        ) {
                          setStatus(value);
                          if (selected !== null) select(null, 'replace');
                        }
                      }}
                    >
                      <option value="active">Active</option>
                      <option value="hidden">Hidden</option>
                      <option value="rejected">Rejected</option>
                      <option value="stale">Stale</option>
                    </select>
                  </label>
                  <fieldset className="filters__group">
                    <legend>Recommendation</legend>
                    {(['Apply', 'Maybe', 'Skip'] as const).map((verdict) => (
                      <label key={verdict}>
                        <input
                          type="checkbox"
                          checked={verdicts.includes(verdict)}
                          onChange={(event) => {
                            if (selected !== null) select(null, 'replace');
                            setVerdicts(
                              event.target.checked
                                ? [...verdicts, verdict]
                                : verdicts.filter((item) => item !== verdict),
                            );
                          }}
                        />{' '}
                        {verdict}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setVerdicts([]);
                      setStatus('active');
                      if (selected !== null) select(null, 'replace');
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              </details>
            </div>
            <p className="inbox__notice" role="status">
              {filtered.length.toLocaleString('en-US')} of{' '}
              {listings
                .filter((item) => item.reviewStatus === status)
                .length.toLocaleString('en-US')}{' '}
              listings
            </p>
          </div>
          <ul className="inbox__list" aria-label="Job evaluations">
            {filtered.length ? (
              filtered.map((item) => (
                <li className="inbox__item" key={item.id}>
                  <a
                    className="report-row"
                    href={`/${item.id}`}
                    aria-current={item.id === current?.id ? 'page' : undefined}
                    aria-controls="report-details"
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      select(item.id);
                    }}
                  >
                    <span className="report-row__company">
                      {item.company || 'Company not stated'} ·{' '}
                      {item.location?.trim() || 'Location unknown'}
                    </span>
                    <span className="report-row__role">
                      {item.title || 'Role not stated'}
                    </span>
                    <span className="report-row__dates">
                      Posted: {relativeDate(item.postedAt, currentTime)} ·
                      Found: {relativeDate(item.foundAt, currentTime)}
                    </span>
                    <span className="report-row__badges">
                      <span
                        className={`badge badge--${processingColors[item.processing]}`}
                      >
                        {processingLabels[item.processing]}
                      </span>
                      {item.assessment && (
                        <>
                          <span
                            className={`badge badge--${item.assessment.verdict.toLowerCase()}`}
                          >
                            Recommendation: {item.assessment.verdict}
                          </span>
                          <span className="badge">
                            Score: {item.assessment.score}
                          </span>
                        </>
                      )}
                    </span>
                  </a>
                </li>
              ))
            ) : (
              <li className="empty">No listings match your search.</li>
            )}
          </ul>
        </aside>
        <section
          className="report"
          id="report-details"
          aria-label="Selected evaluation"
        >
          {current ? (
            <Report
              key={current.id}
              listing={current}
              onStatusChange={async (id, nextStatus) => {
                await onStatusChange(id, nextStatus);
                if (selected !== null) select(null, 'replace');
              }}
              onRetry={onRetry}
              now={currentTime}
            />
          ) : (
            <p className="empty">No listing selected.</p>
          )}
        </section>
      </div>
    </main>
  );
}

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type ReviewListing,
  ReviewScreen,
} from '../../src/app/review-inbox.tsx';
import '../../src/app/inbox.css';

const assessment = {
  company: null,
  role: null,
  summary: 'A role building software.',
  schedule_manila: null,
  hard_stops: [],
  eligibility: [
    {
      item: 'Location',
      jd_quote: null,
      candidate_fact: null,
      result: 'not_stated' as const,
    },
  ],
  requirements: [
    {
      requirement: 'Rust',
      priority: 'required' as const,
      jd_quote: 'Rust required',
      candidate_evidence: null,
      status: 'explicit_gap' as const,
    },
  ],
  compensation: { advertised: null, vs_profile: 'not_stated' as const },
  strengths: [],
  concerns: [],
  confidence: 'medium' as const,
  decision_changing_questions: [],
  score: 4,
  verdict_reason: 'Strong match for the role.',
  verdict: 'Apply' as const,
};

const initial: ReviewListing[] = [
  {
    id: 1,
    company: 'Alpha',
    location: 'Remote in Germany',
    title: 'Software engineer',
    url: 'https://example.test/1',
    source: 'google',
    postedAt: null,
    foundAt: '2026-01-01',
    reviewStatus: 'active',
    processing: 'complete',
    assessment,
    error: null,
  },
  {
    id: 2,
    company: 'Beta',
    location: '',
    title: 'Platform engineer',
    url: 'https://example.test/2',
    source: 'google',
    postedAt: null,
    foundAt: '2026-01-02',
    reviewStatus: 'active',
    processing: 'complete',
    assessment: { ...assessment, verdict: 'Maybe' },
    error: null,
  },
  {
    id: 3,
    company: 'Gamma',
    location: '',
    title: 'Engineer',
    url: 'https://example.test/3',
    source: 'freehire',
    postedAt: null,
    foundAt: '2026-01-03',
    reviewStatus: 'active',
    processing: 'failed',
    assessment: null,
    error: 'Assessment unavailable',
  },
  {
    id: 4,
    company: 'Unsafe',
    location: '',
    title: 'Reviewer',
    url: 'javascript:alert(1)',
    source: 'google',
    postedAt: null,
    foundAt: null,
    reviewStatus: 'active',
    processing: 'complete',
    assessment: { ...assessment, summary: '<img src=x onerror=alert(1)>' },
    error: null,
  },
  {
    id: 1005,
    company: 'Credential link',
    location: '',
    title: 'Reviewer',
    url: 'https://user:password@example.test/job',
    source: 'google',
    postedAt: null,
    foundAt: null,
    reviewStatus: 'active',
    processing: 'complete',
    assessment,
    error: null,
  },
  {
    id: 1006,
    company: 'Historical listing',
    location: '',
    title: 'Engineer',
    url: 'https://example.test/historical',
    source: 'freehire',
    postedAt: null,
    foundAt: null,
    reviewStatus: 'active',
    processing: 'not_scheduled',
    assessment: null,
    error: null,
  },
];

function Fixture() {
  const [listings, setListings] = useState(() => {
    if (
      new URLSearchParams(window.location.search).get('identity') === 'missing'
    )
      return [
        {
          ...initial[0],
          company: '',
          title: '',
          processing: 'waiting' as const,
          assessment: null,
        },
        {
          ...initial[1],
          company: '',
          title: '',
          processing: 'failed' as const,
          assessment: null,
        },
        {
          ...initial[2],
          company: '',
          title: '',
          processing: 'complete' as const,
          assessment: {
            ...assessment,
            company: 'Report company',
            role: 'Report role',
          },
        },
      ];
    if (new URLSearchParams(window.location.search).get('volume') !== '1000')
      return initial;
    return initial.concat(
      Array.from({ length: 1000 }, (_, index) => ({
        id: index + 5,
        company: `Company ${index}`,
        location: '',
        title: `Role ${index}`,
        url: `https://example.test/${index + 5}`,
        source: 'google',
        postedAt: null,
        foundAt: null,
        reviewStatus: 'active' as const,
        processing: 'complete' as const,
        assessment: {
          ...assessment,
          summary: 'A lengthy responsibility '.repeat(200),
        },
        error: null,
      })),
    );
  });
  const mode = new URLSearchParams(window.location.search).get('state');
  return (
    <ReviewScreen
      state={
        mode === 'loading'
          ? { status: 'loading' }
          : mode === 'error'
            ? { status: 'error' }
            : { status: 'ready', listings: mode === 'empty' ? [] : listings }
      }
      onReload={() => {
        window.location.href = '/';
      }}
      onStatusChange={async (id, reviewStatus) => {
        setListings((current) =>
          current.map((listing) =>
            listing.id === id ? { ...listing, reviewStatus } : listing,
          ),
        );
      }}
      onRetry={async (id) => {
        setListings((current) =>
          current.map((listing) =>
            listing.id === id
              ? { ...listing, processing: 'waiting', error: null }
              : listing,
          ),
        );
      }}
    />
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<Fixture />);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relativeDate } from '../src/app/relative-date.ts';

test('relative dates use the previous inbox time-ago boundaries', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(relativeDate('2026-01-01T00:00:00Z', now), '1 day ago');
  assert.equal(relativeDate('2026-01-01T23:59:00Z', now), '1 minute ago');
  assert.equal(relativeDate('2026-01-02T00:00:00Z', now), 'just now');
  assert.equal(relativeDate('2026-01-03T00:00:00Z', now), 'in 1 day');
  assert.equal(relativeDate(null, now), 'date unknown');
  assert.equal(relativeDate('invalid', now), 'date unknown');
});

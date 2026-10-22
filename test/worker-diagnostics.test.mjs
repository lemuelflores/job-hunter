import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deliveryEvent,
  diagnosticError,
  safeUrl,
} from '../dist/infra/worker-diagnostics.js';

test('diagnostics bound causes and strip URL secrets and common credentials', () => {
  const cause = new Error('Bearer secret access_token=hidden');
  cause.code = 'ETIMEDOUT';
  cause.cause = cause;
  const error = new Error(
    'fetch https://user:password@example.com/job?token=secret#secret',
    { cause },
  );
  error.payload = 'listing body';
  const result = diagnosticError(error);
  const text = JSON.stringify(result);
  assert.equal(result.cause.code, 'ETIMEDOUT');
  assert.ok(result.stack);
  assert.doesNotMatch(text, /secret|hidden|password|listing body/);
  assert.equal(result.cause.cause.cause, undefined);
  assert.equal(
    safeUrl('https://a:b@example.com/job?key=x#x'),
    'https://example.com/job',
  );
  assert.equal(
    diagnosticError({ payload: 'private' }).message,
    '[non-Error thrown]',
  );
});

test('diagnostic output failure does not fail delivery', (t) => {
  t.mock.method(console, 'log', () => {
    throw new Error('closed output');
  });
  assert.doesNotThrow(() => deliveryEvent({ event: 'delivery_started' }));
});

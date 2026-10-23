import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATS_DEFINITIONS,
  normalizeJobUrl,
} from '../dist/entrypoints/compose.js';

const url = 'https://example.freshteam.com/jobs/RoJQGWitKVLI/growth-manager';

test('Freshteam accepts tenant listing URLs, preserves opaque ID casing and strips tracking', () => {
  assert.equal(normalizeJobUrl(`${url}/?tracking=x#details`), url);
  assert.equal(
    ATS_DEFINITIONS.find((ats) => ats.selector === 'freshteam').extract,
    undefined,
  );
});

test('Freshteam rejects board roots, application paths, spoofed hosts and unsafe components', () => {
  for (const invalid of [
    'https://example.freshteam.com/jobs',
    'https://example.freshteam.com/jobs/123',
    `${url}/apply`,
    url.replace('https:', 'http:'),
    url.replace('example.freshteam.com', 'freshteam.com'),
    url.replace('example.freshteam.com', 'nested.example.freshteam.com'),
    url.replace('example.freshteam.com', 'example.freshteam.com.evil.test'),
    url.replace('example.freshteam.com', 'user:pass@example.freshteam.com'),
    url.replace('example.freshteam.com', 'example.freshteam.com:8443'),
    url.replace('RoJQGWitKVLI', 'id%2Fother'),
    url.replace('growth-manager', '%ZZ'),
  ])
    assert.equal(normalizeJobUrl(invalid), null, invalid);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  authenticate,
  getCredentials,
} from '../dist/review/llm/chatgpt/auth.js';
import { createRequest } from '../dist/review/llm/chatgpt/request.js';
import {
  AuthenticationError,
  createChatgpt,
} from '../dist/review/llm/index.js';

// Shared Arrange: synthetic tokens carry only the claims needed by OAuth tests.
const jwt = (data) =>
  `header.${Buffer.from(JSON.stringify(data)).toString('base64url')}.signature`;
const tokenResponse = () => ({
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  id_token: jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
  }),
});

// Shared Arrange: isolate credential files and remove them after each test.
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, authPath: join(root, 'credentials', 'auth.json') };
}

// Shared helper: start the callback server, expose its authorized callback and abort on cleanup.
async function startLogin(t, options, login = authenticate) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let authorize;
  const ready = new Promise((resolve) => {
    authorize = resolve;
  });
  const completed = login({
    ...options,
    signal: controller.signal,
    onAuthorize: authorize,
  });
  completed.catch(() => {});
  const url = new URL(await Promise.race([ready, completed]));
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state'));
  callback.searchParams.set('code', 'authorization-code');
  return { url, callback, completed, controller };
}

test('default login and reviews share app-root .auth.json', async (t) => {
  // Arrange: copy the provider into an isolated app root without an auth path override.
  const { root } = await setup(t);
  const directory = join(root, 'dist', 'review', 'llm', 'chatgpt');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(
    new URL('../dist/review/llm/chatgpt/auth.js', import.meta.url),
    join(directory, 'auth.js'),
  );
  await copyFile(
    new URL('../dist/review/llm/types.js', import.meta.url),
    join(directory, '..', 'types.js'),
  );
  const provider = await import(pathToFileURL(join(directory, 'auth.js')).href);
  // Act: sign in through the copied provider's default credential location.
  const login = await startLogin(
    t,
    { fetch: async () => Response.json(tokenResponse()) },
    provider.authenticate,
  );
  // Act / Assert: complete the callback successfully.
  assert.equal((await fetch(login.callback)).status, 200);
  await login.completed;
  // Assert: login persists app-root credentials that default review loading can reuse.
  assert.equal(
    JSON.parse(await readFile(join(root, '.auth.json'), 'utf8')).openai.access,
    'access',
  );
  assert.equal((await provider.getCredentials()).access, 'access');
});

test('browser callback exchanges PKCE code and atomically saves private reusable credentials', async (t) => {
  const output = t.mock.method(console, 'log', () => {});
  // Arrange: isolate storage and observe the token exchange without contacting OpenAI.
  const { root, authPath } = await setup(t);
  let authorize,
    calls = 0;
  const provider = createChatgpt({
    authPath,
    fetch: async (url, init) => {
      calls++;
      // Assert: the exchange matches the authorization URL and verifies the PKCE challenge.
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert.equal(init.redirect, 'error');
      assert.equal(
        init.headers['Content-Type'],
        'application/x-www-form-urlencoded',
      );
      const body = new URLSearchParams(init.body);
      assert.equal(
        body.get('client_id'),
        authorize.searchParams.get('client_id'),
      );
      assert.equal(body.get('code'), 'authorization-code');
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(
        body.get('redirect_uri'),
        'http://127.0.0.1:1455/auth/callback',
      );
      assert.equal(
        createHash('sha256')
          .update(body.get('code_verifier'))
          .digest('base64url'),
        authorize.searchParams.get('code_challenge'),
      );
      return Response.json(tokenResponse());
    },
  });
  const login = await startLogin(t, {}, provider.authenticate);
  // Act: inspect the authorization URL emitted when login starts.
  authorize = login.url;
  // Assert: authorization requests a state-protected PKCE flow with offline access.
  assert.equal(authorize.origin, 'https://auth.openai.com');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('scope'), /offline_access/);
  assert.ok(authorize.searchParams.get('state').length >= 32);
  // Act: complete the browser callback.
  const response = await fetch(login.callback);
  // Assert: the callback succeeds and leaves only private, atomically saved credentials.
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Signed in/);
  await login.completed;
  assert.equal(calls, 1);
  assert.equal(
    output.mock.calls.length,
    0,
    'provider leaves presentation to its callback',
  );
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'credentials'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(root, 'credentials')), ['auth.json']);
  // Act: reload the saved credentials without allowing a refresh request.
  const credentials = await getCredentials({
    authPath,
    fetch: async () => assert.fail('no refresh needed'),
  });
  // Assert: all reusable token fields and the expiry survive persistence.
  assert.equal(credentials.access, 'access');
  assert.equal(credentials.refresh, 'refresh');
  assert.equal(credentials.accountId, 'account');
  assert.ok(credentials.expires > Date.now() + 3500_000);
});

test('wrong state, unknown routes and duplicate callbacks cannot exchange tokens', async (t) => {
  // Arrange: hold a valid exchange open so duplicate callbacks can race against it.
  const { authPath } = await setup(t);
  let release, requested;
  const waiting = new Promise((resolve) => {
    requested = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const login = await startLogin(t, {
    authPath,
    fetch: async () => {
      calls++;
      requested();
      await gate;
      return Response.json(tokenResponse());
    },
  });
  // Arrange: create a callback with an invalid state.
  const wrong = new URL(login.callback);
  wrong.searchParams.set('state', 'wrong');
  // Act / Assert: invalid state and unknown routes never start a token exchange.
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal((await fetch(new URL('/favicon.ico', wrong))).status, 404);
  assert.equal(calls, 0);
  // Act: start one valid exchange and wait until its token request is blocked.
  const success = fetch(login.callback);
  await waiting;
  // Act / Assert: a duplicate callback is rejected while that exchange is pending.
  assert.equal((await fetch(login.callback)).status, 409);
  // Act: allow the original exchange to finish.
  release();
  // Assert: only the original callback succeeds and only one token request occurs.
  assert.equal((await success).status, 200);
  await login.completed;
  assert.equal(calls, 1);
});

test('OAuth denial, missing code, token rejection and malformed responses never save credentials', async (t) => {
  // Arrange: reuse an initially absent credential path across all failure cases.
  const { authPath } = await setup(t);
  for (const kind of [
    'denied',
    'missing-code',
    'http',
    'invalid',
    'invalid-json',
  ]) {
    // Arrange: configure this case's callback or token-response failure.
    const login = await startLogin(t, {
      authPath,
      fetch: async () => {
        if (kind === 'http') return new Response('SECRET', { status: 400 });
        if (kind === 'invalid-json') return new Response('SECRET');
        assert.equal(kind, 'invalid');
        return Response.json({ access_token: 'secret' });
      },
    });
    if (kind === 'denied' || kind === 'missing-code')
      login.callback.searchParams.delete('code');
    if (kind === 'denied') login.callback.searchParams.set('error', 'SECRET');
    // Act: submit the failing OAuth callback.
    const response = await fetch(login.callback);
    // Assert: failures redact provider secrets and never persist credentials.
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /SECRET/);
    await assert.rejects(
      login.completed,
      (error) =>
        error instanceof AuthenticationError &&
        !error.message.includes('SECRET'),
    );
    await assert.rejects(readFile(authPath), { code: 'ENOENT' });
  }
});

test('cancellation releases callback port; occupied port fails without contacting OpenAI', async (t) => {
  // Arrange: start a login whose token endpoint must never be contacted.
  const { authPath } = await setup(t);
  const login = await startLogin(t, {
    authPath,
    fetch: async () => assert.fail('network'),
  });
  // Act: cancel while awaiting the callback.
  login.controller.abort(new Error('cancelled'));
  // Assert: login reports the caller's cancellation.
  await assert.rejects(login.completed, /cancelled/);
  // Arrange: bind the released callback port to simulate another application using it.
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(1455, '127.0.0.1', resolve);
  });
  try {
    // Act / Assert: a second login fails at bind time, before authorization or exchange.
    await assert.rejects(
      authenticate({
        authPath,
        onAuthorize: () => assert.fail('URL before listen'),
      }),
      { code: 'EADDRINUSE' },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('authorization callback failures reject login and release the callback listener', async () => {
  const error = new Error('presentation failed');
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      authenticate({
        onAuthorize: () => {
          throw error;
        },
        fetch: async () => assert.fail('network'),
      }),
      (actual) => actual === error,
    );
});

test('refresh persists rotated tokens while preserving unrelated credentials and account ID', async (t) => {
  // Arrange: save expired tokens alongside unrelated credentials and an account ID.
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      another: { key: 'preserve' },
      openai: {
        type: 'oauth',
        access: 'old',
        refresh: 'old-refresh',
        expires: 1,
        accountId: 'account',
      },
    }),
  );
  let calls = 0;
  const options = {
    authPath,
    fetch: async (url, init) => {
      calls++;
      // Assert: refresh sends the saved refresh token to the OAuth endpoint.
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
      });
      return Response.json({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'rotated',
      });
    },
  };
  // Act: request the same expired credentials concurrently.
  const [refreshed, concurrent] = await Promise.all([
    getCredentials(options),
    getCredentials(options),
  ]);
  // Assert: one exchange serves both callers and preserves unrelated saved data.
  assert.deepEqual(concurrent, refreshed);
  assert.equal(calls, 1);
  assert.equal(refreshed.refresh, 'rotated');
  assert.equal(refreshed.accountId, 'account');
  const saved = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(saved.another, { key: 'preserve' });
  assert.deepEqual(saved.openai, refreshed);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  // Act / Assert: a subsequent read reuses the refreshed token without network access.
  await getCredentials({
    authPath,
    fetch: async () => assert.fail('already refreshed'),
  });
});

test('failed refresh preserves old credentials and redacts provider response', async (t) => {
  // Arrange: keep the original expired credential bytes for a persistence comparison.
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  const original = JSON.stringify({
    openai: { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 },
  });
  await writeFile(authPath, original);
  // Act / Assert: a rejected refresh gives an actionable error without leaking the response.
  await assert.rejects(
    getCredentials({
      authPath,
      fetch: async () => new Response('SECRET', { status: 401 }),
    }),
    (error) => {
      assert.ok(error instanceof AuthenticationError);
      assert.match(error.message, /job-hunter auth/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    },
  );
  // Assert: failure leaves the previous credentials byte-for-byte intact.
  assert.equal(await readFile(authPath, 'utf8'), original);
});

test('model transport uses the access token returned by a real credential refresh', async (t) => {
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 },
    }),
  );
  const calls = [];
  const request = createRequest({
    authPath,
    fetch: async (url, init) => {
      calls.push(url);
      if (url === 'https://auth.openai.com/oauth/token')
        return Response.json({
          access_token: 'new',
          refresh_token: 'rotated',
          expires_in: 3600,
        });
      assert.equal(init.headers.Authorization, 'Bearer new');
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n',
      );
    },
  });
  assert.equal(
    await request({}, 'instructions', 'listing text', 'test', {}),
    'ok',
  );
  assert.deepEqual(calls, [
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/codex/responses',
  ]);
});

test('expired credentials without a refresh token fail before network access', async (t) => {
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      openai: { type: 'oauth', access: 'test', expires: 1 },
    }),
  );
  await assert.rejects(
    getCredentials({
      authPath,
      fetch: async () => assert.fail('network'),
    }),
    /expired/,
  );
});

test('missing or corrupt credentials give actionable errors without network calls', async (t) => {
  // Arrange: start with an absent file and forbid all network requests.
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  const options = { authPath, fetch: async () => assert.fail('network') };
  // Act / Assert: missing credentials explain how to sign in.
  await assert.rejects(getCredentials(options), /job-hunter auth/);
  for (const value of [
    'not-json',
    'null',
    '[]',
    '{"openai":{"type":"oauth","access":42}}',
  ]) {
    // Arrange: replace the file with this malformed credential case.
    await writeFile(authPath, value);
    // Act / Assert: malformed credentials fail locally with the authentication error type.
    await assert.rejects(getCredentials(options), AuthenticationError);
  }
});

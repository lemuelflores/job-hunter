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
import { main } from '../dist/cli.js';
import { authenticate, getCredentials } from '../dist/llm/chatgpt/auth.js';
import { AuthenticationError, llm } from '../dist/llm/index.js';

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

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-hunter-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, authPath: join(root, 'credentials', 'auth.json') };
}

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

test('default login and reviews share app-root .auth.json regardless of cwd or environment', async (t) => {
  const { root } = await setup(t);
  const directory = join(root, 'dist', 'llm', 'chatgpt');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(
    new URL('../dist/llm/chatgpt/auth.js', import.meta.url),
    join(directory, 'auth.js'),
  );
  await copyFile(
    new URL('../dist/llm/types.js', import.meta.url),
    join(directory, '..', 'types.js'),
  );
  const provider = await import(pathToFileURL(join(directory, 'auth.js')).href);
  const original = process.env;
  process.env = {
    ...original,
    CHATGPT_AUTH_FILE: join(root, 'ignored.json'),
    XDG_DATA_HOME: root,
  };
  t.after(() => {
    process.env = original;
  });
  const login = await startLogin(
    t,
    { fetch: async () => Response.json(tokenResponse()) },
    provider.authenticate,
  );
  assert.equal((await fetch(login.callback)).status, 200);
  await login.completed;
  assert.equal(
    JSON.parse(await readFile(join(root, '.auth.json'), 'utf8')).openai.access,
    'access',
  );
  assert.equal((await provider.getCredentials()).access, 'access');
  await assert.rejects(readFile(join(root, 'ignored.json')), {
    code: 'ENOENT',
  });
});

test('browser callback exchanges PKCE code and atomically saves private reusable credentials', async (t) => {
  const { root, authPath } = await setup(t);
  let authorize,
    calls = 0;
  const login = await startLogin(t, {
    authPath,
    fetch: async (url, init) => {
      calls++;
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
  authorize = login.url;
  assert.equal(authorize.origin, 'https://auth.openai.com');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('scope'), /offline_access/);
  assert.ok(authorize.searchParams.get('state').length >= 32);
  const response = await fetch(login.callback);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Signed in/);
  await login.completed;
  assert.equal(calls, 1);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'credentials'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(root, 'credentials')), ['auth.json']);
  const credentials = await getCredentials({
    authPath,
    fetch: async () => assert.fail('no refresh needed'),
  });
  assert.equal(credentials.access, 'access');
  assert.equal(credentials.refresh, 'refresh');
  assert.equal(credentials.accountId, 'account');
  assert.ok(credentials.expires > Date.now() + 3500_000);
});

test('wrong state, unknown routes and duplicate callbacks cannot exchange tokens', async (t) => {
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
  const wrong = new URL(login.callback);
  wrong.searchParams.set('state', 'wrong');
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal((await fetch(new URL('/favicon.ico', wrong))).status, 404);
  assert.equal(calls, 0);
  const success = fetch(login.callback);
  await waiting;
  assert.equal((await fetch(login.callback)).status, 409);
  release();
  assert.equal((await success).status, 200);
  await login.completed;
  assert.equal(calls, 1);
});

test('OAuth denial, missing code, token rejection and malformed responses never save credentials', async (t) => {
  const { authPath } = await setup(t);
  for (const kind of [
    'denied',
    'missing-code',
    'http',
    'invalid',
    'invalid-json',
  ]) {
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
    const response = await fetch(login.callback);
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
  const { authPath } = await setup(t);
  const login = await startLogin(t, {
    authPath,
    fetch: async () => assert.fail('network'),
  });
  login.controller.abort(new Error('cancelled'));
  await assert.rejects(login.completed, /cancelled/);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(1455, '127.0.0.1', resolve);
  });
  try {
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

test('refresh persists rotated tokens while preserving unrelated credentials and account ID', async (t) => {
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
  const [refreshed, concurrent] = await Promise.all([
    getCredentials(options),
    getCredentials(options),
  ]);
  assert.deepEqual(concurrent, refreshed);
  assert.equal(calls, 1);
  assert.equal(refreshed.refresh, 'rotated');
  assert.equal(refreshed.accountId, 'account');
  const saved = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(saved.another, { key: 'preserve' });
  assert.deepEqual(saved.openai, refreshed);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  await getCredentials({
    authPath,
    fetch: async () => assert.fail('already refreshed'),
  });
});

test('failed refresh preserves old credentials and redacts provider response', async (t) => {
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  const original = JSON.stringify({
    openai: { type: 'oauth', access: 'old', refresh: 'refresh', expires: 1 },
  });
  await writeFile(authPath, original);
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
  assert.equal(await readFile(authPath, 'utf8'), original);
});

test('missing or corrupt credentials give actionable errors without network calls', async (t) => {
  const { root } = await setup(t);
  const authPath = join(root, 'auth.json');
  const options = { authPath, fetch: async () => assert.fail('network') };
  await assert.rejects(getCredentials(options), /job-hunter auth/);
  for (const value of [
    'not-json',
    'null',
    '[]',
    '{"openai":{"type":"oauth","access":42}}',
  ]) {
    await writeFile(authPath, value);
    await assert.rejects(getCredentials(options), AuthenticationError);
  }
});

test('CLI auth routes through default provider interface and removes signal listeners', async (t) => {
  const original = llm.authenticate;
  const log = console.log;
  let calls = 0;
  const before = ['SIGINT', 'SIGTERM'].map((event) =>
    process.listenerCount(event),
  );
  t.after(() => {
    llm.authenticate = original;
    console.log = log;
  });
  console.log = () => {};
  llm.authenticate = async (options) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
  };
  assert.equal(await main(['auth']), 0);
  assert.equal(calls, 1);
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
    before,
  );
  const errorLog = console.error;
  console.error = () => {};
  try {
    llm.authenticate = async () => {
      throw new Error('denied');
    };
    assert.equal(await main(['auth']), 1);
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((event) => process.listenerCount(event)),
      before,
    );
    assert.equal(await main(['auth', '--limit', '1']), 1);
  } finally {
    console.error = errorLog;
  }
});

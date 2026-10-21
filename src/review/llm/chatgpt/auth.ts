import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthenticationError, type AuthOptions } from '../types.js';

// shortcut: uses the public Codex OAuth client; recheck upstream if OpenAI changes third-party access.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const SIGN_IN = 'Run job-hunter auth to sign in with ChatGPT';

export interface Credentials {
  type: 'oauth';
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface CredentialOptions extends AuthOptions {
  fetch?: typeof fetch;
  authPath?: string;
}

const AUTH_PATH = fileURLToPath(
  new URL('../../../../.auth.json', import.meta.url),
);

async function readAuth(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AuthenticationError(
      `Cannot read ChatGPT credentials at ${path}. ${SIGN_IN}`,
    );
  }
}

async function saveAuth(path: string, credentials: Credentials): Promise<void> {
  const saved = await readAuth(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...saved, openai: credentials })}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function claims(token: unknown): {
  exp?: number;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
} {
  try {
    return (
      JSON.parse(
        Buffer.from((token as string).split('.')[1], 'base64url').toString(),
      ) ?? {}
    );
  } catch {
    return {};
  }
}

async function exchange(
  parameters: Record<string, string>,
  options: CredentialOptions,
  previous?: Credentials,
): Promise<Credentials> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await (options.fetch ?? fetch)(`${ISSUER}/oauth/token`, {
    method: 'POST',
    redirect: 'error',
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...parameters }),
  });
  if (!response.ok)
    throw new AuthenticationError(
      `ChatGPT token exchange HTTP ${response.status}. ${SIGN_IN}`,
    );
  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  } | null;
  try {
    data = await response.json();
  } catch {
    throw new AuthenticationError('Invalid ChatGPT token response');
  }
  const accessClaims = claims(data?.access_token);
  const expires =
    typeof data?.expires_in === 'number' && data.expires_in > 0
      ? Date.now() + data.expires_in * 1000
      : (accessClaims.exp ?? Number.NaN) * 1000;
  const refresh = data?.refresh_token ?? previous?.refresh;
  const accountId =
    claims(data?.id_token)['https://api.openai.com/auth']?.chatgpt_account_id ??
    accessClaims['https://api.openai.com/auth']?.chatgpt_account_id ??
    previous?.accountId;
  if (
    typeof data?.access_token !== 'string' ||
    !data.access_token ||
    typeof refresh !== 'string' ||
    !refresh ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    (accountId !== undefined && typeof accountId !== 'string')
  ) {
    throw new AuthenticationError('Invalid ChatGPT token response');
  }
  return {
    type: 'oauth',
    access: data.access_token,
    refresh,
    expires,
    accountId,
  };
}

const credentialRequests = new Map<string, Promise<Credentials>>();

export async function getCredentials(
  options: CredentialOptions = {},
): Promise<Credentials> {
  const path = options.authPath ?? AUTH_PATH;
  const pending = credentialRequests.get(path);
  if (pending) return pending;
  const request = loadCredentials(options);
  credentialRequests.set(path, request);
  try {
    return await request;
  } finally {
    credentialRequests.delete(path);
  }
}

async function loadCredentials(
  options: CredentialOptions = {},
): Promise<Credentials> {
  const path = options.authPath ?? AUTH_PATH;
  const auth = (await readAuth(path)).openai as Credentials | undefined;
  if (
    auth?.type !== 'oauth' ||
    typeof auth.access !== 'string' ||
    !auth.access ||
    (auth.expires !== undefined &&
      (!Number.isFinite(auth.expires) || auth.expires < 0)) ||
    (auth.accountId !== undefined && typeof auth.accountId !== 'string')
  ) {
    throw new AuthenticationError(`No valid saved ChatGPT login. ${SIGN_IN}`);
  }
  if (auth.expires !== undefined && auth.expires <= Date.now() + 30_000) {
    if (typeof auth.refresh !== 'string' || !auth.refresh)
      throw new AuthenticationError(`ChatGPT login expired. ${SIGN_IN}`);
    const refreshed = await exchange(
      { grant_type: 'refresh_token', refresh_token: auth.refresh },
      options,
      auth,
    );
    await saveAuth(path, refreshed);
    return refreshed;
  }
  return auth;
}

export async function authenticate(
  options: CredentialOptions = {},
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(5 * 60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'job-hunter',
  }).toString();
  let resolveLogin!: () => void, rejectLogin!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });
  let exchanging = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    let callback: URL;
    try {
      callback = new URL(request.url ?? '/', REDIRECT_URI);
    } catch {
      response.writeHead(400).end('Invalid URL');
      return;
    }
    if (callback.pathname !== '/auth/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (
      request.method !== 'GET' ||
      callback.searchParams.get('state') !== state
    ) {
      response.writeHead(400).end('Invalid OAuth callback');
      return;
    }
    if (exchanging) {
      response.writeHead(409).end('Sign-in already in progress');
      return;
    }
    const code = callback.searchParams.get('code');
    if (callback.searchParams.has('error') || !code) {
      response
        .writeHead(400)
        .end(
          'Sign-in was denied or no authorization code was returned. Retry job-hunter auth.',
        );
      rejectLogin(
        new AuthenticationError(
          'ChatGPT sign-in was denied or returned no authorization code',
        ),
      );
      return;
    }
    exchanging = true;
    void (async () => {
      try {
        const credentials = await exchange(
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          },
          { ...options, signal },
        );
        signal.throwIfAborted();
        await saveAuth(options.authPath ?? AUTH_PATH, credentials);
        response.end('Signed in to Job Hunter. You can close this window.');
        resolveLogin();
      } catch (error) {
        response
          .writeHead(500)
          .end('Sign-in failed. See the Job Hunter terminal.');
        rejectLogin(error);
      }
    })();
  });
  const abort = () => rejectLogin(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  server.on('error', rejectLogin);
  try {
    server.listen(1455, '127.0.0.1', () => {
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        options.onAuthorize?.(url.toString());
      } catch (error) {
        rejectLogin(error);
      }
    });
    await completed;
  } finally {
    signal.removeEventListener('abort', abort);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

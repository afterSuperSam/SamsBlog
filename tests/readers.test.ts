import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpile } from 'typescript';
import type { APIContext } from 'astro';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readerConfig } from '../src/config/readers';
import { siteConfig } from '../src/config/site';
import { getDatabase } from '../src/lib/db';
import { verifyAdminSession } from '../src/lib/admin-auth';
import { blogsClubCallback, finishBlogsClubLogin, startBlogsClubLogin, finishReaderOAuth, startReaderOAuth } from '../src/lib/reader-oauth';
import { createReaderCodeEmail, readReaderEmail, sendReaderEmailCode, verifyReaderEmailCode } from '../src/lib/reader-email';
import { readerUpstreamRequest } from '../src/lib/reader-transport';
import { endReaderSession, getReaderAuthOptions, readReaderSession, readerCookieName, readerFlowCookieName,
  readerPrivateHash, readerTokenHash, resolveReaderIdentity, startReaderSession, takeReaderAllowance, type ReaderCookies } from '../src/lib/readers';
import { POST as requestCode } from '../src/pages/api/reader/email-code.json';
import { POST as emailLogin } from '../src/pages/api/reader/email-login.json';
import { POST as oauthStart } from '../src/pages/api/reader/oauth/blogsclub.json';
import { POST as logout } from '../src/pages/api/reader/logout.json';
import { GET as session } from '../src/pages/api/reader/session.json';

beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(join(tmpdir(), 'samsblog-readers-'))); });
beforeEach(() => {
  vi.stubEnv('READER_BLOGSCLUB_CLIENT_ID', 'fixture-app');
  vi.stubEnv('READER_BLOGSCLUB_CLIENT_SECRET', 'fixture-client-secret');
  vi.stubEnv('READER_GITHUB_CLIENT_ID', 'fixture-github-app');
  vi.stubEnv('READER_GITHUB_CLIENT_SECRET', 'fixture-github-secret');
  vi.stubEnv('READER_GOOGLE_CLIENT_ID', 'fixture-google-app');
  vi.stubEnv('READER_GOOGLE_CLIENT_SECRET', 'fixture-google-secret');
  vi.stubEnv('BLOG_SECRET', 'fixture-reader-secret-with-at-least-32-characters');
  vi.stubEnv('RESEND_API_KEY', 'fixture-email-key');
  vi.stubEnv('MAIL_FROM', 'sender@example.com');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external request')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getDatabase().exec('DELETE FROM reader_sessions; DELETE FROM reader_passkey_challenges; DELETE FROM reader_passkeys; DELETE FROM reader_oauth_states; DELETE FROM reader_email_codes; DELETE FROM reader_auth_limits; DELETE FROM reader_identities; DELETE FROM readers;');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

function cookieJar() {
  const values = new Map<string, string>();
  const cookies = { get: (name: string) => values.has(name) ? { value: values.get(name)! } : undefined,
    set: vi.fn((name: string, value: string) => { values.set(name, value); }),
    delete: vi.fn((name: string) => { values.delete(name); }),
  } as unknown as ReaderCookies;
  return { cookies, values };
}

function oauthFlow(cookies: ReaderCookies, source = 'oauth-source') {
  const authorization = new URL(startBlogsClubLogin(cookies, source));
  const callback = new URL('/', siteConfig.siteUrl);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('code', 'fixture-authorization-code');
  return { authorization, callback };
}

function successfulOAuth(subject = '123') {
  const fetchRequest = vi.fn().mockResolvedValueOnce(Response.json({ status: 200, access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', openid: subject }))
    .mockResolvedValueOnce(Response.json({ status: 200, data: { openid: subject, blog_name: '测试博客', blogger_avatar: 'https://example.com/avatar.png', verified: 1, email: 'untrusted@example.com' } }));
  vi.stubGlobal('fetch', fetchRequest);
  return fetchRequest;
}

function captureEmail() {
  let code = '';
  const fetchRequest = vi.fn(async (_url: URL, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    code = String(body.text).match(/\d{3}/)![0];
    return Response.json({ id: 'fixture-mail-id' });
  });
  vi.stubGlobal('fetch', fetchRequest);
  return { fetchRequest, code: () => code };
}

function context(path: string, body: unknown, cookies: ReaderCookies, origin: string | undefined = siteConfig.siteUrl.replace(/\/$/, '')) {
  const url = new URL(path, siteConfig.siteUrl);
  return { url, request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }),
    cookies, clientAddress: '198.51.100.77' } as unknown as APIContext;
}

describe('reader identities and sessions', () => {
  it('creates the migration and nullable foreign keys without changing old messages', () => {
    expect(getDatabase().prepare("SELECT 1 FROM schema_migrations WHERE id='20261107-reader-accounts'").get()).toBeTruthy();
    for (const table of ['messages', 'confirmed_site_visitors']) {
      const fields = getDatabase().pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
      expect(fields.find((field) => field.name === 'reader_id')?.notnull).toBe(0);
    }
  });

  it('keeps provider identities separate and normalizes profile names and unsafe avatars', () => {
    const first = resolveReaderIdentity('blogsclub', '123', '😀'.repeat(30), 'javascript:alert(1)');
    const second = resolveReaderIdentity('email', '123', '邮箱读者', null);
    expect(Array.from(first.displayName)).toHaveLength(12);
    expect(first.avatarUrl).toBeNull();
    expect(first.id).not.toBe(second.id);
    expect(resolveReaderIdentity('blogsclub', '123', '其他昵称', null).id).toBe(first.id);
  });

  it('stores only session hashes, rotates old sessions, enforces expiry and revokes on logout', () => {
    const { cookies, values } = cookieJar();
    const reader = resolveReaderIdentity('blogsclub', '123', '测试读者', null);
    startReaderSession(cookies, reader, 'blogsclub');
    const previous = values.get(readerCookieName)!;
    expect(verifyAdminSession(previous)).toBe(false);
    expect(readReaderSession(cookies)).toEqual(reader);
    expect(getDatabase().prepare('SELECT token_hash FROM reader_sessions').get()).toEqual({ token_hash: readerTokenHash(previous) });
    expect(cookies.set).toHaveBeenCalledWith(readerCookieName, expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' }));
    expect(readerCookieName.startsWith('__Host-')).toBe(true);
    expect(readerFlowCookieName.startsWith('__Host-')).toBe(true);
    startReaderSession(cookies, reader, 'blogsclub');
    const current = values.get(readerCookieName)!;
    expect(current).not.toBe(previous);
    values.set(readerCookieName, previous);
    expect(readReaderSession(cookies)).toBeNull();
    values.set(readerCookieName, current);
    endReaderSession(cookies);
    values.set(readerCookieName, current);
    expect(readReaderSession(cookies)).toBeNull();
    startReaderSession(cookies, reader, 'blogsclub');
    getDatabase().prepare('UPDATE reader_sessions SET expires_at=?').run(Date.now());
    expect(readReaderSession(cookies)).toBeNull();
  });

  it('marks missing credentials independently unavailable and never exposes secrets in public options', () => {
    vi.stubEnv('READER_BLOGSCLUB_CLIENT_SECRET', '');
    const options = getReaderAuthOptions();
    expect(options.email).toBe(true);
    expect(options.providers.map((provider) => provider.id)).toEqual(['blogsclub', 'github', 'google']);
    expect(options.providers[0]!.enabled).toBe(false);
    expect(JSON.stringify(options)).not.toContain('fixture-email-key');
    vi.stubEnv('RESEND_API_KEY', '');
    expect(getReaderAuthOptions().email).toBe(false);
  });
});

describe('GitHub App user OAuth and Google OIDC', () => {
  const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = { ...signingKeys.publicKey.export({ format: 'jwk' }), kid: 'fixture-google-key', alg: 'RS256', use: 'sig' };

  function begin(provider: 'github' | 'google', cookies: ReaderCookies) {
    const authorization = new URL(startReaderOAuth(provider, cookies, `fixture-${provider}`));
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    return { authorization, callback };
  }

  function googleToken(nonce: string, claims: Record<string, unknown> = {}, invalidSignature = false) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: publicKey.kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: 'google-subject-123', aud: 'fixture-google-app',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, name: 'Google 测试读者', email: 'untrusted@example.com', email_verified: false, ...claims })).toString('base64url');
    const message = `${header}.${payload}`;
    return `${message}.${sign('RSA-SHA256', Buffer.from(message), invalidSignature ? wrongKeys.privateKey : signingKeys.privateKey).toString('base64url')}`;
  }

  function googleFetch(token: string) {
    const mocked = vi.fn(async (url: URL) => {
      if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ token_type: 'Bearer', access_token: 'fixture-google-access-token', id_token: token });
      if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicKey] });
      throw new Error('Unexpected mock destination');
    });
    vi.stubGlobal('fetch', mocked);
    return mocked;
  }

  it('uses GitHub App client credentials plus S256 PKCE, then immutable /user id without email merging', async () => {
    const { cookies } = cookieJar();
    const { authorization, callback } = begin('github', cookies);
    expect(authorization.origin + authorization.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorization.searchParams.get('scope')).toBeNull();
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const state = getDatabase().prepare("SELECT pkce_verifier FROM reader_oauth_states WHERE provider='github'").get() as { pkce_verifier: string };
    expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(state.pkce_verifier).digest('base64url'));
    const fetched = vi.fn().mockResolvedValueOnce(Response.json({ token_type: 'bearer', access_token: 'fixture-github-user-token' }))
      .mockResolvedValueOnce(Response.json({ id: 123, login: 'fixture-login', name: 'GitHub 读者', email: 'untrusted@example.com' }));
    vi.stubGlobal('fetch', fetched);
    const reader = await finishReaderOAuth('github', callback, cookies);
    expect(reader.loginMethod).toBe('github');
    expect(readReaderSession(cookies)?.loginMethod).toBe('github');
    const request = fetched.mock.calls[0]![1] as RequestInit;
    expect((request.body as URLSearchParams).get('client_secret')).toBe('fixture-github-secret');
    expect((request.body as URLSearchParams).get('code_verifier')).toBe(state.pkce_verifier);
    expect(String(fetched.mock.calls[1]![0])).toBe('https://api.github.com/user');
    expect(getDatabase().prepare('SELECT provider,subject FROM reader_identities').all()).toEqual([{ provider: 'github', subject: '123' }]);
    getDatabase().prepare('UPDATE readers SET display_name=? WHERE id=?').run('自定义昵称', reader.id);
    expect(resolveReaderIdentity('github', '123', '提供方新昵称', null).displayName).toBe('自定义昵称');
    await expect(finishReaderOAuth('github', callback, cookies)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects provider mix-up and wrong callback paths without consuming another provider state', async () => {
    const { cookies } = cookieJar();
    const { callback } = begin('github', cookies);
    callback.pathname = '/api/reader/oauth/google/callback.json';
    await expect(finishReaderOAuth('google', callback, cookies)).rejects.toMatchObject({ status: 400 });
    expect(getDatabase().prepare('SELECT count(*) AS count FROM reader_oauth_states').get()).toEqual({ count: 1 });
    await expect(finishReaderOAuth('github', callback, cookies)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies a signed Google ID token with nonce and PKCE and uses only sub for identity', async () => {
    const { cookies } = cookieJar();
    const { authorization, callback } = begin('google', cookies);
    expect(authorization.searchParams.get('scope')).toBe('openid profile');
    expect(authorization.searchParams.get('nonce')).toHaveLength(43);
    const mocked = googleFetch(googleToken(authorization.searchParams.get('nonce')!));
    const reader = await finishReaderOAuth('google', callback, cookies);
    expect(reader.loginMethod).toBe('google');
    expect(readReaderSession(cookies)).toEqual(reader);
    expect(getDatabase().prepare('SELECT provider,subject FROM reader_identities').all()).toEqual([{ provider: 'google', subject: 'google-subject-123' }]);
    const request = mocked.mock.calls[0] as unknown as [URL, RequestInit];
    expect((request[1].body as URLSearchParams).get('code_verifier')).toHaveLength(43);
    expect(mocked.mock.calls.every(([url]) => ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs'].includes(url.href))).toBe(true);
  });

  it.each(['signature', 'nonce', 'issuer', 'audience', 'expiry'])('rejects invalid Google %s through the real OIDC library', async (invalid) => {
    const { cookies } = cookieJar();
    const { authorization, callback } = begin('google', cookies);
    const claims: Record<string, unknown> = {};
    if (invalid === 'issuer') claims.iss = 'https://attacker.example';
    if (invalid === 'audience') claims.aud = 'wrong-client';
    if (invalid === 'expiry') claims.exp = Math.floor(Date.now() / 1000) - 600;
    googleFetch(googleToken(invalid === 'nonce' ? 'wrong-nonce' : authorization.searchParams.get('nonce')!, claims, invalid === 'signature'));
    await expect(finishReaderOAuth('google', callback, cookies)).rejects.toMatchObject({ status: 502 });
    expect(readReaderSession(cookies)).toBeNull();
    expect(getDatabase().prepare('SELECT count(*) AS count FROM readers').get()).toEqual({ count: 0 });
    await expect(finishReaderOAuth('google', callback, cookies)).rejects.toMatchObject({ status: 400 });
  });
});

describe('BlogsClub OAuth boundary', () => {
  it('redirects verified OAuth only to the clean completion page and reports the new session timestamp', async () => {
    const { cookies } = cookieJar();
    const before = await session({ cookies } as APIContext);
    expect((await before.json()).authenticatedAt).toBeNull();
    const { callback } = oauthFlow(cookies);
    successfulOAuth();
    const response = await blogsClubCallback({ url: callback, cookies });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/reader/oauth-complete?result=success');
    expect(await response.text()).toBe('');
    const signedIn = await (await session({ cookies } as APIContext)).json();
    expect(signedIn.authenticatedAt).toEqual(expect.any(Number));
    expect(signedIn.reader.loginMethod).toBe('blogsclub');
    vi.spyOn(Date, 'now').mockReturnValue(signedIn.authenticatedAt + 1000);
    startReaderSession(cookies, signedIn.reader, 'blogsclub');
    expect((await (await session({ cookies } as APIContext)).json()).authenticatedAt).toBe(signedIn.authenticatedAt + 1000);
  });

  it('binds random persistent state to the browser and consumes it once before exchanging tokens', async () => {
    const { cookies, values } = cookieJar();
    const { authorization, callback } = oauthFlow(cookies);
    expect(authorization.origin + authorization.pathname).toBe('https://www.blogsclub.org/Oauth/Login');
    expect(authorization.searchParams.get('redirect_uri')).toBe(new URL('/', siteConfig.siteUrl).href);
    expect(authorization.searchParams.get('scope')).toBe('basic');
    expect(authorization.searchParams.get('state')).toHaveLength(43);
    const row = getDatabase().prepare('SELECT state_hash,browser_hash FROM reader_oauth_states').get() as { state_hash: string; browser_hash: string };
    expect(row.state_hash).toBe(readerTokenHash(authorization.searchParams.get('state')!));
    expect(row.browser_hash).toBe(readerTokenHash(values.get(readerFlowCookieName)!));
    const fetchRequest = successfulOAuth();
    const reader = await finishBlogsClubLogin(callback, cookies);
    expect(readReaderSession(cookies)?.id).toBe(reader.id);
    expect(Object.keys(reader).sort()).toEqual(['avatarUrl', 'displayName', 'id', 'loginMethod']);
    const identities = getDatabase().prepare('SELECT provider,subject FROM reader_identities').all();
    expect(identities).toEqual([{ provider: 'blogsclub', subject: '123' }]);
    const requestOptions = fetchRequest.mock.calls[0]![1] as RequestInit;
    expect((requestOptions.body as URLSearchParams).get('client_secret')).toBe('fixture-client-secret');
    expect(requestOptions.redirect).toBe('error');
    await expect(finishBlogsClubLogin(callback, cookies)).rejects.toMatchObject({ status: 400 });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    const stored = JSON.stringify(getDatabase().prepare('SELECT * FROM readers').all()) + JSON.stringify(identities);
    for (const secret of ['fixture-access-token', 'fixture-refresh-token', 'untrusted@example.com']) expect(stored.includes(secret)).toBe(false);
  });

  it('rejects mismatched browsers, duplicate state, wrong origin and expired states before any network request', async () => {
    const { cookies } = cookieJar();
    const { callback } = oauthFlow(cookies);
    await expect(finishBlogsClubLogin(callback, cookieJar().cookies)).rejects.toMatchObject({ status: 400 });
    const duplicate = new URL(callback); duplicate.searchParams.append('state', duplicate.searchParams.get('state')!);
    await expect(finishBlogsClubLogin(duplicate, cookies)).rejects.toMatchObject({ status: 400 });
    const foreign = new URL(callback); foreign.hostname = 'attacker.example';
    await expect(finishBlogsClubLogin(foreign, cookies)).rejects.toMatchObject({ status: 400 });
    getDatabase().prepare('UPDATE reader_oauth_states SET expires_at=?').run(Date.now());
    await expect(finishBlogsClubLogin(callback, cookies)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects userinfo subject mismatch and sanitizes callback redirects and logs', async () => {
    const { cookies, values } = cookieJar();
    const { callback } = oauthFlow(cookies);
    const fetchRequest = successfulOAuth();
    fetchRequest.mockReset().mockResolvedValueOnce(Response.json({ status: 200, access_token: 'secret-must-not-log', token_type: 'Bearer', openid: '123' }))
      .mockResolvedValueOnce(Response.json({ status: 200, data: { openid: '456', blog_name: '错误身份' } }));
    const response = await blogsClubCallback({ url: callback, cookies });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/reader/oauth-complete?result=error');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(values.has(readerFlowCookieName)).toBe(false);
    expect(readReaderSession(cookies)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith('Reader OAuth callback rejected');
    expect(getDatabase().prepare('SELECT count(*) AS count FROM readers').get()).toEqual({ count: 0 });
  });
});

describe('OAuth completion window', () => {
  const source = readFileSync(new URL('../src/pages/reader/oauth-complete.astro', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('OAuth completion script missing');
  const compiled = transpile(script, { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 });

  it.each(['success', 'error', 'untrusted'])('posts only a bounded %s result to the current origin', (result) => {
    const postMessage = vi.fn();
    const close = vi.fn();
    const button = { hidden: true, addEventListener: vi.fn() };
    const root = { dataset: { result }, querySelector: () => button };
    runInNewContext(compiled, { document: { querySelector: () => root }, window: { opener: { postMessage }, close, location: { origin: 'https://blog.example.com' } } });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'samsblog-reader-oauth', status: result === 'success' ? 'success' : 'error' }, 'https://blog.example.com');
    expect(close).toHaveBeenCalledOnce();
    expect(button.hidden).toBe(false);
  });

  it('leaves a usable account link without an opener and handles blocked opener communication', () => {
    const close = vi.fn();
    const button = { hidden: true, addEventListener: vi.fn() };
    const help = { textContent: '' };
    const root = { dataset: { result: 'success' }, querySelector: (selector: string) => selector === '[data-oauth-close]' ? button : help };
    const window = { opener: null as { postMessage: () => void } | null, close, location: { origin: 'https://blog.example.com' } };
    runInNewContext(compiled, { document: { querySelector: () => root }, window });
    expect(close).not.toHaveBeenCalled();
    expect(source).toContain('href="/reader"');
    window.opener = { postMessage: () => { throw new DOMException('Blocked', 'SecurityError'); } };
    runInNewContext(compiled, { document: { querySelector: () => root }, window });
    expect(close).not.toHaveBeenCalled();
    expect(help.textContent).toContain('浏览器限制');
    expect(source).toContain('Boolean(readReaderSession(Astro.cookies))');
    expect(source).toContain("'Cache-Control', 'private, no-store'");
  });
});

describe('email login codes', () => {
  it('keeps three-digit leading zeros and rejects the old six-digit protocol', async () => {
    const { cookies } = cookieJar(); const mailbox = captureEmail();
    const email = 'leading@example.com';
    await sendReaderEmailCode(email, 'leading-source');
    expect(mailbox.code()).toMatch(/^\d{3}$/);
    const address = readerPrivateHash('email', email);
    getDatabase().prepare('UPDATE reader_email_codes SET code_hash=? WHERE email_hash=?').run(readerPrivateHash('email-code', `${address}:003`), address);
    expect(() => verifyReaderEmailCode(email, '000003', 'leading-source', cookies)).toThrow('三位');
    const reader = verifyReaderEmailCode(email, '003', 'leading-source', cookies);
    expect(readReaderSession(cookies)?.id).toBe(reader.id);
    expect(() => verifyReaderEmailCode(email, '003', 'leading-source', cookies)).toThrow('验证码无效');
    expect(readerConfig.codeAttempts).toBe(3);
  });
  it('renders a compact HTML email with a copyable code, configured validity and text fallback', () => {
    const message = createReaderCodeEmail('003', 120);
    expect(message.text).toContain('003'); expect(message.text).toContain('2 分钟');
    expect(message.html).toContain('>003</td>'); expect(message.html).toContain('2 分钟');
    expect(message.html).toContain('SamsBlog'); expect(message.html).toContain('role="presentation"');
    expect(message.html).not.toMatch(/<script|<img|url\(|https?:/i);
    expect(() => createReaderCodeEmail('<script>')).toThrow('Invalid');
    expect(() => createReaderCodeEmail('003', Number.NaN)).toThrow('Invalid');
  });
  it('sends only through mocked Resend, stores hashes and accepts a code exactly once', async () => {
    const { cookies } = cookieJar();
    const mailbox = captureEmail();
    const email = readReaderEmail('  Reader@Example.com ');
    await sendReaderEmailCode(email, 'email-source');
    const stored = getDatabase().prepare('SELECT * FROM reader_email_codes').get() as Record<string, unknown>;
    expect(Object.values(stored)).not.toContain(email);
    expect(Object.values(stored)).not.toContain(mailbox.code());
    const reader = verifyReaderEmailCode(email, mailbox.code(), 'email-source', cookies);
    expect(reader.displayName).not.toContain('@');
    expect(reader.displayName).toMatch(/^读者[A-Za-z0-9_-]{8}$/);
    expect(readReaderSession(cookies)).toEqual(reader);
    expect(() => verifyReaderEmailCode(email, mailbox.code(), 'email-source', cookies)).toThrow('验证码无效');
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(1);
    expect(mailbox.fetchRequest.mock.calls[0]![0].href).toBe('https://api.resend.com/emails');
    expect(JSON.stringify(getDatabase().prepare('SELECT * FROM reader_identities').all())).not.toContain(email);
    getDatabase().prepare('UPDATE reader_auth_limits SET expires_at=0').run();
    await sendReaderEmailCode(email, 'email-source');
    expect(verifyReaderEmailCode(email, mailbox.code(), 'email-source', cookies)).toEqual(reader);
  });

  it('persists wrong-code attempts, rejects exact expiry and binds codes to their email', async () => {
    const { cookies } = cookieJar();
    const mailbox = captureEmail();
    await sendReaderEmailCode('reader@example.com', 'email-source');
    expect(() => verifyReaderEmailCode('other@example.com', mailbox.code(), 'email-source', cookies)).toThrow('验证码无效');
    const wrong = String((Number(mailbox.code()) + 1) % 1000).padStart(3, '0');
    for (let index = 0; index < readerConfig.codeAttempts; index++) {
      expect(() => verifyReaderEmailCode('reader@example.com', wrong, 'email-source', cookies)).toThrow('验证码无效');
    }
    expect(() => verifyReaderEmailCode('reader@example.com', mailbox.code(), 'expiry-source', cookies)).toThrow('验证码无效');
    expect(getDatabase().prepare('SELECT attempts FROM reader_email_codes').get()).toEqual({ attempts: readerConfig.codeAttempts });
    getDatabase().prepare('UPDATE reader_email_codes SET attempts=0,expires_at=?').run(Date.now());
    expect(() => verifyReaderEmailCode('reader@example.com', mailbox.code(), 'email-source', cookies)).toThrow('验证码无效');
  });

  it('enforces five rolling source attempts across email and cookie changes, with exact per-attempt expiry', () => {
    const now = vi.spyOn(Date, 'now'); const start = 200000;
    for (let index = 0; index < 5; index++) {
      now.mockReturnValue(start + index * 10000);
      expect(() => verifyReaderEmailCode(`reader${index}@example.com`, '003', 'rolling-source', cookieJar().cookies)).toThrow('验证码无效');
    }
    now.mockReturnValue(start + 59999);
    expect(() => verifyReaderEmailCode('new@example.com', '003', 'rolling-source', cookieJar().cookies)).toThrow('每分钟最多 5 次');
    expect(getDatabase().prepare("SELECT count(*) AS count FROM reader_auth_limits WHERE key LIKE 'verify-minute-source:rolling-source:%'").get()).toEqual({ count: 5 });
    now.mockReturnValue(start + 60000);
    expect(() => verifyReaderEmailCode('new@example.com', '003', 'rolling-source', cookieJar().cookies)).toThrow('验证码无效');
    expect(() => verifyReaderEmailCode('next@example.com', '003', 'rolling-source', cookieJar().cookies)).toThrow('每分钟最多 5 次');
    now.mockReturnValue(start + 70000);
    expect(() => verifyReaderEmailCode('next@example.com', '003', 'rolling-source', cookieJar().cookies)).toThrow('验证码无效');
  });

  it('retains the email minute quota across sources and a newly sent challenge without weakening its three-attempt limit', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100000); const mailbox = captureEmail();
    const email = 'rolling@example.com'; const { cookies } = cookieJar();
    await sendReaderEmailCode(email, 'send-source');
    const wrong = String((Number(mailbox.code()) + 1) % 1000).padStart(3, '0');
    now.mockReturnValue(160000);
    for (let index = 0; index < 5; index++) {
      expect(() => verifyReaderEmailCode(email, wrong, `source-${index}`, cookieJar().cookies)).toThrow('验证码无效');
    }
    expect(getDatabase().prepare('SELECT attempts FROM reader_email_codes').get()).toEqual({ attempts: 3 });
    await sendReaderEmailCode(email, 'send-source');
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(2);
    expect(getDatabase().prepare('SELECT attempts FROM reader_email_codes').get()).toEqual({ attempts: 0 });
    expect(() => verifyReaderEmailCode(email, mailbox.code(), 'fresh-source', cookies)).toThrow('每分钟最多 5 次');
    expect(cookies.set).not.toHaveBeenCalled();
    now.mockReturnValue(220000);
    expect(verifyReaderEmailCode(email, mailbox.code(), 'fresh-source', cookies).loginMethod).toBe('email');
    expect(readerConfig.verifyMinuteLimit).toBe(5); expect(readerConfig.verifyMinuteSeconds).toBe(60);
  });

  it('returns HTTP 429 for the sixth verification request even across refreshed cookie jars', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => emailLogin(context('/api/reader/email-login.json', { email: 'reader@example.com', code: '003' }, cookieJar().cookies))));
    expect(responses.map((response) => response.status).sort()).toEqual([400, 400, 400, 400, 400, 429]);
    const denied = responses.find((response) => response.status === 429)!;
    expect((await denied.json()).error).toContain('每分钟最多 5 次');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares persistent source/global send quotas and suppresses concurrent same-email requests', async () => {
    const mailbox = captureEmail();
    await Promise.all(Array.from({ length: 4 }, () => sendReaderEmailCode('reader@example.com', 'email-source')));
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(1);
    for (let index = 1; index < readerConfig.emailSourceLimit; index++) await sendReaderEmailCode(`reader${index}@example.com`, 'email-source');
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(readerConfig.emailSourceLimit);
    await sendReaderEmailCode('another@example.com', 'email-source');
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(readerConfig.emailSourceLimit);
    getDatabase().prepare("UPDATE reader_auth_limits SET count=? WHERE key='email-global'").run(readerConfig.emailGlobalLimit);
    await sendReaderEmailCode('new@example.com', 'another-source');
    expect(mailbox.fetchRequest).toHaveBeenCalledTimes(readerConfig.emailSourceLimit);
  });

  it('returns the same sending response for delivery failure and cooldown and never logs mail or code', async () => {
    const { cookies } = cookieJar();
    const call = () => requestCode(context('/api/reader/email-code.json', { email: 'reader@example.com' }, cookies));
    const first = await call();
    const second = await call();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(getDatabase().prepare('SELECT count(*) AS count FROM reader_email_codes').get()).toEqual({ count: 0 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('Reader email delivery unavailable');
  });
});

describe('reader transport and API guards', () => {
  it('fails closed on oversize upstream data and never follows redirects', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(new Response('x'.repeat(readerConfig.upstreamMaximumBytes + 1)));
    vi.stubGlobal('fetch', fetchRequest);
    await expect(readerUpstreamRequest('token', { method: 'POST' })).rejects.toMatchObject({ status: 502 });
    expect(fetchRequest.mock.calls[0]![1].redirect).toBe('error');
    fetchRequest.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }));
    await expect(readerUpstreamRequest('token', { method: 'POST' })).rejects.toMatchObject({ status: 502 });
  });

  it('bounds stalled upstream bodies and clears its timeout', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const result = readerUpstreamRequest('token', { method: 'POST' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(readerConfig.upstreamTimeoutMilliseconds);
    expect(await result).toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires same-origin mutations and limits request bytes before parsing', async () => {
    const { cookies } = cookieJar();
    for (const handler of [requestCode, emailLogin, oauthStart, logout]) {
      expect((await handler(context('/api/reader/test.json', {}, cookies, 'https://foreign.example'))).status).toBe(403);
    }
    expect((await requestCode(context('/api/reader/email-code.json', { email: 'x'.repeat(readerConfig.requestMaximumBytes) }, cookies))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    const response = await session({ cookies } as APIContext);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.reader).toBeNull();
    expect(body.authenticatedAt).toBeNull();
    expect(Object.keys(body).sort()).toEqual(['authenticatedAt', 'options', 'reader']);
  });

  it('expires persistent allowance windows exactly at their deadline', () => {
    const limit = [{ key: 'fixture', maximum: 1, seconds: 1 }];
    expect(takeReaderAllowance(limit, 10000)).toBe(true);
    expect(takeReaderAllowance(limit, 10999)).toBe(false);
    expect(takeReaderAllowance(limit, 11000)).toBe(true);
  });
});

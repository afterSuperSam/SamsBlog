import { createHash } from 'node:crypto';
import * as openid from 'openid-client';
import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError } from './http';
import { readerUpstreamRequest } from './reader-transport';
import { getReaderAuthOptions, getReaderProviderSettings, readerCookieOptions, readerFlowCookieName,
  readerSecret, readerToken, readerTokenHash, resolveReaderIdentity, startReaderSession, takeReaderAllowance,
  validReaderToken, type ReaderCookies, type ReaderProvider } from './readers';

// BlogsClub 是 OAuth 2 提供方；站点认证和提供方邮箱都不参与本地邮箱身份判定。
export function startBlogsClubLogin(cookies: ReaderCookies, sourceHash: string) {
  return startReaderOAuth('blogsclub', cookies, sourceHash);
}

export function startReaderOAuth(provider: ReaderProvider, cookies: ReaderCookies, sourceHash: string) {
  readerSecret();
  if (!getReaderAuthOptions().providers.find((item) => item.id === provider)?.enabled) throw new HttpError(503, '该登录方式尚未配置');
  if (!takeReaderAllowance([
    { key: `oauth-source:${sourceHash}`, maximum: readerConfig.oauthSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'oauth-global', maximum: readerConfig.oauthGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '登录尝试过于频繁，请稍后重试');
  const settings = getReaderProviderSettings(provider);
  const state = readerToken();
  const browser = readerToken();
  const verifier = provider !== 'blogsclub' ? readerToken() : null;
  const nonce = provider === 'google' ? readerToken() : null;
  const previous = cookies.get(readerFlowCookieName)?.value;
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_oauth_states WHERE expires_at<=?').run(now);
    if (validReaderToken(previous)) database.prepare('DELETE FROM reader_oauth_states WHERE browser_hash=?').run(readerTokenHash(previous));
    database.prepare('INSERT INTO reader_oauth_states(state_hash,browser_hash,created_at,expires_at,provider,pkce_verifier,nonce) VALUES (?,?,?,?,?,?,?)')
      .run(readerTokenHash(state), readerTokenHash(browser), now, now + readerConfig.oauthSeconds * 1000, provider, verifier, nonce);
  }).immediate();
  cookies.set(readerFlowCookieName, browser, { ...readerCookieOptions(), maxAge: readerConfig.oauthSeconds });
  const url = new URL({ github: 'https://github.com/login/oauth/authorize', google: 'https://accounts.google.com/o/oauth2/v2/auth', blogsclub: 'https://www.blogsclub.org/Oauth/Login' }[provider]);
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri,
    response_type: 'code', state }).toString();
  if (verifier) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  } else url.searchParams.set('scope', 'basic');
  if (nonce) { url.searchParams.set('nonce', nonce); url.searchParams.set('scope', 'openid profile'); }
  return url.href;
}

export async function finishBlogsClubLogin(url: URL, cookies: ReaderCookies) {
  return finishReaderOAuth('blogsclub', url, cookies);
}

export async function finishReaderOAuth(provider: ReaderProvider, url: URL, cookies: ReaderCookies) {
  const settings = getReaderProviderSettings(provider);
  const state = url.searchParams.get('state');
  const browser = cookies.get(readerFlowCookieName)?.value;
  if (url.origin !== new URL(settings.redirectUri).origin || url.pathname !== new URL(settings.redirectUri).pathname
    || url.searchParams.getAll('state').length !== 1 || !validReaderToken(state) || !validReaderToken(browser)) {
    throw new HttpError(400, '登录状态无效，请重新开始');
  }
  const consumed = getDatabase().prepare('DELETE FROM reader_oauth_states WHERE state_hash=? AND browser_hash=? AND provider=? AND expires_at>? RETURNING pkce_verifier,nonce')
    .get(readerTokenHash(state), readerTokenHash(browser), provider, Date.now()) as { pkce_verifier: string | null; nonce: string | null } | undefined;
  if (!consumed) throw new HttpError(400, '登录已过期或已使用，请重新开始');
  const code = url.searchParams.get('code');
  if (!getReaderAuthOptions().providers.find((item) => item.id === provider)?.enabled || url.searchParams.has('error')
    || url.searchParams.getAll('code').length !== 1 || !code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new HttpError(400, '授权未完成，请重新登录');
  }
  if (provider === 'github') {
    if (!validReaderToken(consumed.pkce_verifier)) throw new HttpError(400, '登录状态无效，请重新开始');
    const token = await readerUpstreamRequest('githubToken', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, code,
        redirect_uri: settings.redirectUri, code_verifier: consumed.pkce_verifier }),
    });
    if (token.error || typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(token.access_token)
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new HttpError(502, '登录服务响应格式不正确');
    const identity = await readerUpstreamRequest('githubProfile', { method: 'GET', headers: {
      Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'SamsBlog-reader-login',
    } });
    if (typeof identity.id !== 'number' || !Number.isSafeInteger(identity.id) || identity.id < 1 || typeof identity.login !== 'string') {
      throw new HttpError(502, '登录身份无法验证');
    }
    const reader = resolveReaderIdentity('github', String(identity.id), typeof identity.name === 'string' && identity.name.trim() ? identity.name : identity.login,
      typeof identity.avatar_url === 'string' ? identity.avatar_url : null);
    startReaderSession(cookies, reader, 'github');
    return reader;
  }
  if (provider === 'google') {
    if (!validReaderToken(consumed.pkce_verifier) || !validReaderToken(consumed.nonce)) throw new HttpError(400, '登录状态无效，请重新开始');
    try {
      const tokens = await openid.authorizationCodeGrant(googleConfiguration(), url, {
        expectedState: state, expectedNonce: consumed.nonce, pkceCodeVerifier: consumed.pkce_verifier, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new HttpError(502, '登录身份无法验证');
      const reader = resolveReaderIdentity('google', claims.sub, typeof claims.name === 'string' ? claims.name : 'Google 读者', typeof claims.picture === 'string' ? claims.picture : null);
      startReaderSession(cookies, reader, 'google');
      return reader;
    } catch { throw new HttpError(502, 'Google 登录验证未通过，请重新尝试'); }
  }
  const token = await readerUpstreamRequest('token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri,
      client_id: settings.clientId, client_secret: settings.clientSecret }),
  });
  if (token.status !== 200 || typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(token.access_token)
    || typeof token.openid !== 'string' || !/^\d{1,128}$/.test(token.openid)
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new HttpError(502, '登录服务响应格式不正确');
  const profile = await readerUpstreamRequest('profile', { method: 'GET', headers: { Accept: 'application/json' } }, token.access_token);
  const user = profile.data;
  if (profile.status !== 200 || !user || typeof user !== 'object' || Array.isArray(user)) throw new HttpError(502, '登录身份无法验证');
  const identity = user as Record<string, unknown>;
  if (identity.openid !== token.openid || typeof identity.blog_name !== 'string') throw new HttpError(502, '登录身份无法验证');
  const reader = resolveReaderIdentity('blogsclub', token.openid, identity.blog_name, typeof identity.blogger_avatar === 'string' ? identity.blogger_avatar : null);
  startReaderSession(cookies, reader, 'blogsclub');
  return reader;
}

let cachedGoogle: { clientId: string; clientSecret: string; configuration: openid.Configuration } | undefined;

// Google 固定元数据和密钥地址；库同时校验标准声明与 JWS 签名，不自行解码 JWT 作为身份。
function googleConfiguration() {
  const { clientId, clientSecret } = getReaderProviderSettings('google');
  if (cachedGoogle?.clientId === clientId && cachedGoogle.clientSecret === clientSecret) return cachedGoogle.configuration;
  const configuration = new openid.Configuration({
    issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    id_token_signing_alg_values_supported: ['RS256'],
  }, clientId, { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' });
  configuration[openid.customFetch] = async (input, options) => {
    const address = String(input);
    const endpoint = address === 'https://oauth2.googleapis.com/token' ? 'googleToken'
      : address === 'https://www.googleapis.com/oauth2/v3/certs' ? 'googleKeys' : null;
    if (!endpoint) throw new HttpError(502, '登录服务响应格式不正确');
    const body = options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body;
    return Response.json(await readerUpstreamRequest(endpoint, { ...options, body }));
  };
  openid.enableNonRepudiationChecks(configuration);
  cachedGoogle = { clientId, clientSecret, configuration };
  return configuration;
}

export async function blogsClubCallback(context: { url: URL; cookies: ReaderCookies }) {
  return readerOAuthCallback('blogsclub', context);
}

export async function readerOAuthCallback(provider: ReaderProvider, context: { url: URL; cookies: ReaderCookies }) {
  let location = '/reader';
  try { await finishReaderOAuth(provider, context.url, context.cookies); }
  catch { location = '/reader?error=oauth'; console.warn('Reader OAuth callback rejected'); }
  finally { context.cookies.delete(readerFlowCookieName, readerCookieOptions()); }
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}

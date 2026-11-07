import { createHash } from 'node:crypto';
import * as openid from 'openid-client';
import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError } from './http';
import { readerUpstreamRequest } from './reader-transport';
import { getReaderAuthOptions, getReaderProviderSettings, linkReaderIdentity, readReaderBindingToken, readReaderSession, readerCookieName, readerCookieOptions, readerFlowCookieName,
  readerSecret, readerToken, readerTokenHash, resolveReaderIdentity, startReaderSession, takeReaderAllowance,
  requireReaderIdentityLink, requireReaderReauthenticationIdentity, validReaderToken, type ReaderCookies, type ReaderProvider } from './readers';

type OAuthIntent = 'login' | 'link' | 'reauthenticate';
interface OAuthFlow { flow_id: string; intent: OAuthIntent; link_hash: string | null; status: string; pkce_verifier: string | null; nonce: string | null; completed_session_hash: string | null }

// BlogsClub 是 OAuth 2 提供方；站点认证和提供方邮箱都不参与本地邮箱身份判定。
export function startBlogsClubLogin(cookies: ReaderCookies, sourceHash: string) {
  return startReaderOAuth('blogsclub', cookies, sourceHash);
}

export function startReaderOAuth(provider: ReaderProvider, cookies: ReaderCookies, sourceHash: string, action: Record<string, unknown> = {}) {
  readerSecret();
  if (!getReaderAuthOptions().providers.find((item) => item.id === provider)?.enabled) throw new HttpError(503, '该登录方式尚未配置');
  if (!takeReaderAllowance([
    { key: `oauth-source:${sourceHash}`, maximum: readerConfig.oauthSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'oauth-global', maximum: readerConfig.oauthGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '登录尝试过于频繁，请稍后重试');
  const settings = getReaderProviderSettings(provider);
  const intent = action.intent ?? 'login';
  if (!['login', 'link', 'reauthenticate'].includes(String(intent))) throw new HttpError(400, '登录操作无效');
  let linkHash: string | null = null;
  if (intent === 'link') {
    linkHash = readReaderBindingToken(action.bindingToken);
    requireReaderIdentityLink(cookies, linkHash, provider);
  } else if (intent === 'reauthenticate') {
    if (!readReaderSession(cookies)) throw new HttpError(401, '请先登录读者账号');
    linkHash = readerTokenHash(cookies.get(readerCookieName)!.value);
  } else if (action.bindingToken !== undefined) throw new HttpError(400, '请从账号页开始绑定');
  const state = readerToken();
  if (action.flowId !== undefined && !validReaderToken(action.flowId)) throw new HttpError(400, '登录流程编号无效');
  const flowId = action.flowId === undefined ? readerToken() : action.flowId as string;
  const browser = readerToken();
  const verifier = provider !== 'blogsclub' ? readerToken() : null;
  const nonce = provider === 'google' ? readerToken() : null;
  const previous = cookies.get(readerFlowCookieName)?.value;
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_oauth_states WHERE expires_at<=?').run(now);
    if (database.prepare('SELECT 1 FROM reader_oauth_states WHERE flow_id=?').get(flowId)) throw new HttpError(409, '登录流程已存在，请重新开始');
    if (validReaderToken(previous)) database.prepare('DELETE FROM reader_oauth_states WHERE browser_hash=?').run(readerTokenHash(previous));
    if (intent === 'link') database.prepare("UPDATE reader_oauth_states SET status='cancelled',pkce_verifier=NULL,nonce=NULL WHERE link_hash=? AND status IN ('pending','processing')").run(linkHash);
    database.prepare('INSERT INTO reader_oauth_states(state_hash,browser_hash,created_at,expires_at,provider,pkce_verifier,nonce,flow_id,intent,link_hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(readerTokenHash(state), readerTokenHash(browser), now, now + readerConfig.oauthSeconds * 1000, provider, verifier, nonce, flowId, intent, linkHash);
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

export function startReaderOAuthFlow(provider: ReaderProvider, cookies: ReaderCookies, sourceHash: string, action: Record<string, unknown>) {
  const url = startReaderOAuth(provider, cookies, sourceHash, action);
  const flow = getDatabase().prepare('SELECT flow_id FROM reader_oauth_states WHERE browser_hash=?').get(readerTokenHash(cookies.get(readerFlowCookieName)!.value)) as { flow_id: string };
  return { url, flowId: flow.flow_id };
}

// 完成编号仅定位本次流程；浏览器证明和对应会话必须同时匹配。
export function readReaderOAuthFlow(cookies: ReaderCookies, flowId: unknown) {
  const browser = cookies.get(readerFlowCookieName)?.value;
  if (!validReaderToken(flowId) || !validReaderToken(browser)) return { status: 'expired' };
  const flow = getDatabase().prepare('SELECT status,completed_session_hash FROM reader_oauth_states WHERE flow_id=? AND browser_hash=? AND expires_at>?')
    .get(flowId, readerTokenHash(browser), Date.now()) as Pick<OAuthFlow, 'status' | 'completed_session_hash'> | undefined;
  if (!flow) return { status: 'expired' };
  if (flow.status === 'completed') {
    const session = cookies.get(readerCookieName)?.value;
    if (!validReaderToken(session) || flow.completed_session_hash !== readerTokenHash(session) || !readReaderSession(cookies)) return { status: 'expired' };
  }
  return { status: flow.status };
}

export function cancelReaderOAuthFlow(cookies: ReaderCookies, flowId: unknown) {
  const browser = cookies.get(readerFlowCookieName)?.value;
  if (!validReaderToken(flowId) || !validReaderToken(browser)) return { status: 'expired' };
  return getDatabase().transaction(() => {
    const cancelled = getDatabase().prepare("UPDATE reader_oauth_states SET status='cancelled',pkce_verifier=NULL,nonce=NULL WHERE flow_id=? AND browser_hash=? AND status IN ('pending','processing') RETURNING intent,link_hash")
      .get(flowId, readerTokenHash(browser)) as Pick<OAuthFlow, 'intent' | 'link_hash'> | undefined;
    if (cancelled?.intent === 'link') getDatabase().prepare('DELETE FROM reader_identity_links WHERE token_hash=?').run(cancelled.link_hash);
    return readReaderOAuthFlow(cookies, flowId);
  }).immediate();
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
  const consumed = getDatabase().prepare("UPDATE reader_oauth_states SET status='processing' WHERE state_hash=? AND browser_hash=? AND provider=? AND status='pending' AND expires_at>? RETURNING *")
    .get(readerTokenHash(state), readerTokenHash(browser), provider, Date.now()) as OAuthFlow | undefined;
  if (!consumed) throw new HttpError(400, '登录已过期或已使用，请重新开始');
  const complete = (subject: string, name: string, avatar: string | null) => getDatabase().transaction(() => {
    const active = getDatabase().prepare("SELECT 1 FROM reader_oauth_states WHERE flow_id=? AND browser_hash=? AND status='processing' AND expires_at>?").get(consumed.flow_id, readerTokenHash(browser), Date.now());
    if (!active) throw new HttpError(400, '授权已取消或过期，请重新开始');
    if (consumed.intent === 'reauthenticate') {
      const session = cookies.get(readerCookieName)?.value;
      if (!validReaderToken(session) || readerTokenHash(session) !== consumed.link_hash) throw new HttpError(400, '登录状态已变化，请重新验证');
      requireReaderReauthenticationIdentity(cookies, provider, subject);
    }
    const reader = consumed.intent === 'link'
      ? linkReaderIdentity(cookies, consumed.link_hash!, provider, subject)
      : resolveReaderIdentity(provider, subject, name, avatar);
    if (consumed.intent !== 'link') startReaderSession(cookies, reader, provider);
    getDatabase().prepare("UPDATE reader_oauth_states SET status='completed',pkce_verifier=NULL,nonce=NULL,completed_session_hash=? WHERE flow_id=?")
      .run(readerTokenHash(cookies.get(readerCookieName)!.value), consumed.flow_id);
    return reader;
  }).immediate();
  try {
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
      return complete(String(identity.id), typeof identity.name === 'string' && identity.name.trim() ? identity.name : identity.login,
        typeof identity.avatar_url === 'string' ? identity.avatar_url : null);
    }
    if (provider === 'google') {
      if (!validReaderToken(consumed.pkce_verifier) || !validReaderToken(consumed.nonce)) throw new HttpError(400, '登录状态无效，请重新开始');
      try {
        const tokens = await openid.authorizationCodeGrant(googleConfiguration(), url, {
          expectedState: state, expectedNonce: consumed.nonce, pkceCodeVerifier: consumed.pkce_verifier, idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new HttpError(502, '登录身份无法验证');
        return complete(claims.sub, typeof claims.name === 'string' ? claims.name : 'Google 读者', typeof claims.picture === 'string' ? claims.picture : null);
      } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'Google 登录验证未通过，请重新尝试'); }
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
    return complete(token.openid, identity.blog_name, typeof identity.blogger_avatar === 'string' ? identity.blogger_avatar : null);
  } catch (error) {
    getDatabase().prepare("UPDATE reader_oauth_states SET status='failed',pkce_verifier=NULL,nonce=NULL WHERE flow_id=? AND status='processing'").run(consumed.flow_id);
    throw error;
  }
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
  const state = context.url.searchParams.get('state');
  const browser = context.cookies.get(readerFlowCookieName)?.value;
  const flow = validReaderToken(state) && validReaderToken(browser)
    ? getDatabase().prepare('SELECT flow_id FROM reader_oauth_states WHERE state_hash=? AND browser_hash=? AND provider=?')
      .get(readerTokenHash(state), readerTokenHash(browser), provider) as { flow_id: string } | undefined
    : undefined;
  let location = '/reader/oauth-complete?result=success';
  try { await finishReaderOAuth(provider, context.url, context.cookies); }
  catch { location = '/reader/oauth-complete?result=error'; console.warn('Reader OAuth callback rejected'); }
  if (flow?.flow_id) location += `&flow=${encodeURIComponent(flow.flow_id)}`;
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}

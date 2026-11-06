import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError } from './http';
import { readerUpstreamRequest } from './reader-transport';
import { getReaderAuthOptions, getReaderProviderSettings, readerCookieOptions, readerFlowCookieName,
  readerSecret, readerToken, readerTokenHash, resolveReaderIdentity, startReaderSession, takeReaderAllowance,
  validReaderToken, type ReaderCookies } from './readers';

// BlogsClub 是 OAuth 2 提供方；站点认证和提供方邮箱都不参与本地邮箱身份判定。
export function startBlogsClubLogin(cookies: ReaderCookies, sourceHash: string) {
  readerSecret();
  if (!getReaderAuthOptions().providers[0]!.enabled) throw new HttpError(503, 'BlogsClub 登录尚未配置');
  if (!takeReaderAllowance([
    { key: `oauth-source:${sourceHash}`, maximum: readerConfig.oauthSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'oauth-global', maximum: readerConfig.oauthGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '登录尝试过于频繁，请稍后重试');
  const settings = getReaderProviderSettings('blogsclub');
  const state = readerToken();
  const browser = readerToken();
  const previous = cookies.get(readerFlowCookieName)?.value;
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_oauth_states WHERE expires_at<=?').run(now);
    if (validReaderToken(previous)) database.prepare('DELETE FROM reader_oauth_states WHERE browser_hash=?').run(readerTokenHash(previous));
    database.prepare('INSERT INTO reader_oauth_states(state_hash,browser_hash,created_at,expires_at) VALUES (?,?,?,?)')
      .run(readerTokenHash(state), readerTokenHash(browser), now, now + readerConfig.oauthSeconds * 1000);
  }).immediate();
  cookies.set(readerFlowCookieName, browser, { ...readerCookieOptions(), maxAge: readerConfig.oauthSeconds });
  const url = new URL('https://www.blogsclub.org/Oauth/Login');
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri,
    response_type: 'code', scope: 'basic', state }).toString();
  return url.href;
}

export async function finishBlogsClubLogin(url: URL, cookies: ReaderCookies) {
  const settings = getReaderProviderSettings('blogsclub');
  const state = url.searchParams.get('state');
  const browser = cookies.get(readerFlowCookieName)?.value;
  if (url.origin !== new URL(settings.redirectUri).origin || url.pathname !== '/'
    || url.searchParams.getAll('state').length !== 1 || !validReaderToken(state) || !validReaderToken(browser)) {
    throw new HttpError(400, '登录状态无效，请重新开始');
  }
  const consumed = getDatabase().prepare('DELETE FROM reader_oauth_states WHERE state_hash=? AND browser_hash=? AND expires_at>?')
    .run(readerTokenHash(state), readerTokenHash(browser), Date.now()).changes;
  if (!consumed) throw new HttpError(400, '登录已过期或已使用，请重新开始');
  const code = url.searchParams.get('code');
  if (!getReaderAuthOptions().providers[0]!.enabled || url.searchParams.has('error')
    || url.searchParams.getAll('code').length !== 1 || !code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new HttpError(400, '授权未完成，请重新登录');
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
  startReaderSession(cookies, reader);
  return reader;
}

export async function blogsClubCallback(context: { url: URL; cookies: ReaderCookies }) {
  let location = '/reader';
  try { await finishBlogsClubLogin(context.url, context.cookies); }
  catch { location = '/reader?error=oauth'; console.warn('Reader OAuth callback rejected'); }
  finally { context.cookies.delete(readerFlowCookieName, readerCookieOptions()); }
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}

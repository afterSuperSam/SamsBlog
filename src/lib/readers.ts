import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { readerConfig } from '../config/readers';
import { siteConfig } from '../config/site';
import { getDatabase } from './db';
import { HttpError, readJsonObject } from './http';

export type ReaderLoginMethod = 'email' | 'blogsclub' | 'github' | 'google' | 'passkey';
export interface ReaderPublic { id: number; displayName: string; avatarUrl: string | null; loginMethod: ReaderLoginMethod }
export type ReaderProvider = 'blogsclub' | 'github' | 'google';
export type ReaderCookies = Pick<AstroCookies, 'get' | 'set' | 'delete'>;
const secureCookies = () => import.meta.env.PROD || process.env.NODE_ENV === 'production' || new URL(siteConfig.siteUrl).protocol === 'https:';
export const readerCookieName = secureCookies() ? '__Host-samsblog_reader' : 'samsblog_reader';
export const readerFlowCookieName = secureCookies() ? '__Host-samsblog_reader_flow' : 'samsblog_reader_flow';
export const readerPasskeyCookieName = secureCookies() ? '__Host-samsblog_reader_passkey' : 'samsblog_reader_passkey';
export const readerCookieOptions = () => ({ path: '/', httpOnly: true, secure: secureCookies(), sameSite: 'lax' as const });
export const readerToken = () => randomBytes(32).toString('base64url');
export const readerTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const validReaderToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function readerSecret() {
  const secret = process.env.BLOG_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, '读者登录尚未完成配置');
  return secret;
}

export const readerPrivateHash = (purpose: string, value: string) => createHmac('sha256', readerSecret()).update(`${purpose}:${value}`).digest('hex');

export function getReaderProviderSettings(provider: ReaderProvider) {
  const prefix = `READER_${provider.toUpperCase()}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim() || '';
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim() || '';
  const redirectUri = new URL(provider === 'blogsclub' ? '/' : `/api/reader/oauth/${provider}/callback.json`, siteConfig.siteUrl).href;
  return { clientId, clientSecret, redirectUri };
}

export function getReaderAuthOptions() {
  const validSecret = Boolean(process.env.BLOG_SECRET && process.env.BLOG_SECRET.length >= 32);
  return {
    email: Boolean(validSecret && process.env.RESEND_API_KEY && process.env.MAIL_FROM),
    passkey: validSecret && readerPasskeysAvailable(),
    providers: (['blogsclub', 'github', 'google'] as const).map((id) => {
      const settings = getReaderProviderSettings(id);
      return { id, name: { github: 'GitHub', google: 'Google', blogsclub: 'BlogsClub' }[id],
        enabled: Boolean(validSecret && settings.clientId && settings.clientSecret), startUrl: `/api/reader/oauth/${id}.json` };
    }),
  };
}

export function readerPasskeysAvailable() {
  const origin = new URL(siteConfig.siteUrl);
  return origin.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
}

export async function readReaderJson(request: Request) {
  return readJsonObject(request, readerConfig.requestMaximumBytes);
}

// 会话仅存不可逆摘要；退出和再次登录都撤销当前浏览器的旧会话。
export function readReaderSession(cookies: Pick<AstroCookies, 'get'>): ReaderPublic | null {
  const token = cookies.get(readerCookieName)?.value;
  if (!validReaderToken(token)) return null;
  const reader = getDatabase().prepare(`SELECT r.id,r.display_name AS displayName,r.avatar_url AS avatarUrl,
      COALESCE(s.login_method,(SELECT provider FROM reader_identities WHERE reader_id=r.id
        GROUP BY reader_id HAVING count(*)=1)) AS loginMethod
    FROM reader_sessions s JOIN readers r ON r.id=s.reader_id
    WHERE s.token_hash=? AND s.expires_at>? AND r.deleted_at IS NULL`)
    .get(readerTokenHash(token), Date.now()) as ReaderPublic | undefined;
  return reader && reader.loginMethod ? reader : null;
}

export function requireRecentReaderSession(cookies: Pick<AstroCookies, 'get'>): ReaderPublic {
  const reader = readReaderSession(cookies);
  const token = cookies.get(readerCookieName)?.value;
  if (!reader || !validReaderToken(token)) throw new HttpError(401, '请先登录读者账号', 'reauth_required');
  const session = getDatabase().prepare('SELECT created_at FROM reader_sessions WHERE token_hash=?').get(readerTokenHash(token)) as { created_at: number };
  if (session.created_at <= Date.now() - readerConfig.recentAuthenticationSeconds * 1000 || session.created_at > Date.now()) {
    throw new HttpError(401, '请重新验证身份后管理通行密钥', 'reauth_required');
  }
  return reader;
}

export function readerAuthenticatedAt(cookies: Pick<AstroCookies, 'get'>): number | null {
  const token = cookies.get(readerCookieName)?.value;
  if (!validReaderToken(token)) return null;
  const session = getDatabase().prepare(`SELECT s.created_at FROM reader_sessions s JOIN readers r ON r.id=s.reader_id
    WHERE s.token_hash=? AND s.expires_at>? AND r.deleted_at IS NULL`).get(readerTokenHash(token), Date.now()) as { created_at: number } | undefined;
  return session?.created_at ?? null;
}

export function listReaderPasskeys(readerId: number) {
  return getDatabase().prepare(`SELECT id,label,created_at AS createdAt,last_used_at AS lastUsedAt FROM reader_passkeys
    WHERE reader_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC`).all(readerId) as Array<{ id: number; label: string; createdAt: string; lastUsedAt: string | null }>;
}

export function endReaderSession(cookies: ReaderCookies) {
  const token = cookies.get(readerCookieName)?.value;
  if (validReaderToken(token)) getDatabase().prepare('DELETE FROM reader_sessions WHERE token_hash=?').run(readerTokenHash(token));
  cookies.delete(readerCookieName, readerCookieOptions());
}

export function startReaderSession(cookies: ReaderCookies, reader: Pick<ReaderPublic, 'id'>, loginMethod: ReaderLoginMethod, passkeyId: number | null = null) {
  const database = getDatabase();
  const token = readerToken();
  const previous = cookies.get(readerCookieName)?.value;
  const now = Date.now();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_sessions WHERE expires_at<=?').run(now);
    if (validReaderToken(previous)) database.prepare('DELETE FROM reader_sessions WHERE token_hash=?').run(readerTokenHash(previous));
    database.prepare('INSERT INTO reader_sessions(token_hash,reader_id,created_at,expires_at,login_method,passkey_id) VALUES (?,?,?,?,?,?)')
      .run(readerTokenHash(token), reader.id, now, now + readerConfig.sessionSeconds * 1000, loginMethod, passkeyId);
  }).immediate();
  cookies.set(readerCookieName, token, { ...readerCookieOptions(), maxAge: readerConfig.sessionSeconds });
}

export function resolveReaderIdentity(provider: ReaderProvider | 'email', subject: string, displayName: string, avatarUrl: string | null): ReaderPublic {
  if (!subject || subject.length > 255) throw new HttpError(400, '登录身份无效');
  const cleanedName = Array.from(displayName.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, readerConfig.displayNameMaximumLength).join('');
  const name = Array.from(cleanedName).length >= 2 ? cleanedName : '博客读者';
  let avatar: string | null = null;
  if (avatarUrl && avatarUrl.length <= 2048) {
    try { const url = new URL(avatarUrl); if (url.protocol === 'https:' && !url.username && !url.password) avatar = url.href; }
    catch { avatar = null; }
  }
  const database = getDatabase();
  return database.transaction(() => {
    const existing = database.prepare(`SELECT r.id,r.display_name AS displayName,r.avatar_url AS avatarUrl,r.deleted_at AS deletedAt
      FROM reader_identities i JOIN readers r ON r.id=i.reader_id WHERE i.provider=? AND i.subject=?`).get(provider, subject) as (ReaderPublic & { deletedAt: string | null }) | undefined;
    if (existing) {
      if (existing.deletedAt) throw new HttpError(403, '读者账号暂不可用');
      return { id: existing.id, displayName: existing.displayName, avatarUrl: existing.avatarUrl, loginMethod: provider };
    }
    const now = new Date().toISOString();
    const id = Number(database.prepare('INSERT INTO readers(display_name,avatar_url,created_at,updated_at,webauthn_user_id) VALUES (?,?,?,?,?)').run(name, avatar, now, now, readerToken()).lastInsertRowid);
    database.prepare('INSERT INTO reader_identities(provider,subject,reader_id) VALUES (?,?,?)').run(provider, subject, id);
    return { id, displayName: name, avatarUrl: avatar, loginMethod: provider };
  }).immediate();
}

// 持久额度在一个立即事务内预占，异步发信和令牌交换不能穿过并发窗口。
export function takeReaderAllowance(limits: Array<{ key: string; maximum: number; seconds: number }>, now = Date.now()) {
  const database = getDatabase();
  return database.transaction(() => {
    database.prepare('DELETE FROM reader_auth_limits WHERE expires_at<=?').run(now);
    for (const limit of limits) {
      const current = database.prepare('SELECT count FROM reader_auth_limits WHERE key=?').get(limit.key) as { count: number } | undefined;
      if (current && current.count >= limit.maximum) return false;
    }
    for (const limit of limits) database.prepare(`INSERT INTO reader_auth_limits(key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1`).run(limit.key, now + limit.seconds * 1000);
    return true;
  }).immediate();
}

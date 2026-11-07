import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { APIContext } from 'astro';
import { readerConfig } from '../config/readers';
import { siteConfig } from '../config/site';
import { getDatabase } from './db';
import { HttpError, readJsonObject, readPositiveId, requireSameOrigin, route } from './http';
import { fingerprintIp, getClientIp } from './network';
import { getReaderAuthOptions, listReaderPasskeys, readReaderSession, readerCookieName, readerCookieOptions, readerPasskeyCookieName,
  readerToken, readerTokenHash, requireRecentReaderSession, startReaderSession, takeReaderAllowance, validReaderToken,
  type ReaderCookies, type ReaderPublic } from './readers';

interface PasskeyChallenge { challenge: string; reader_id: number | null; session_hash: string | null }
const origin = new URL(siteConfig.siteUrl).origin;
const relyingPartyId = new URL(siteConfig.siteUrl).hostname;

export const readerPasskeyRoute = (handler: (context: APIContext, body: Record<string, unknown>) => Response | Promise<Response>) => route(async (context) => {
  requireSameOrigin(context.request);
  requirePasskeyAllowance(fingerprintIp(getClientIp(context.request, context.clientAddress)));
  return handler(context, await readJsonObject(context.request, readerConfig.passkeyRequestMaximumBytes));
});

export function requirePasskeyAllowance(source: string) {
  if (!getReaderAuthOptions().passkey) throw new HttpError(503, '通行密钥暂不可用，请使用其他方式登录');
  if (!takeReaderAllowance([
    { key: `passkey-source:${source}`, maximum: readerConfig.passkeySourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'passkey-global', maximum: readerConfig.passkeyGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '通行密钥操作过于频繁，请稍后重试');
}

// 每次仪式只认本浏览器的一次性挑战；注册额外绑定当前登录会话。
function storeChallenge(kind: 'register' | 'login', challenge: string, cookies: ReaderCookies, readerId: number | null = null) {
  const token = readerToken();
  const previous = cookies.get(readerPasskeyCookieName)?.value;
  const session = cookies.get(readerCookieName)?.value;
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_passkey_challenges WHERE expires_at<=?').run(now);
    if (validReaderToken(previous)) database.prepare('DELETE FROM reader_passkey_challenges WHERE token_hash=?').run(readerTokenHash(previous));
    database.prepare('INSERT INTO reader_passkey_challenges(token_hash,challenge,kind,reader_id,session_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(readerTokenHash(token), challenge, kind, readerId, kind === 'register' && validReaderToken(session) ? readerTokenHash(session) : null,
        now, now + readerConfig.passkeyChallengeSeconds * 1000);
  }).immediate();
  cookies.set(readerPasskeyCookieName, token, { ...readerCookieOptions(), maxAge: readerConfig.passkeyChallengeSeconds });
}

function consumeChallenge(kind: 'register' | 'login', cookies: ReaderCookies): PasskeyChallenge {
  const token = cookies.get(readerPasskeyCookieName)?.value;
  cookies.delete(readerPasskeyCookieName, readerCookieOptions());
  if (!validReaderToken(token)) throw new HttpError(400, '通行密钥验证已过期，请重新开始');
  const row = getDatabase().prepare('DELETE FROM reader_passkey_challenges WHERE token_hash=? AND kind=? AND expires_at>? RETURNING challenge,reader_id,session_hash')
    .get(readerTokenHash(token), kind, Date.now()) as PasskeyChallenge | undefined;
  if (!row) throw new HttpError(400, '通行密钥验证已过期，请重新开始');
  return row;
}

export async function createPasskeyRegistrationOptions(cookies: ReaderCookies) {
  const reader = requireRecentReaderSession(cookies);
  const database = getDatabase();
  const passkeys = database.prepare('SELECT credential_id,transports FROM reader_passkeys WHERE reader_id=? AND deleted_at IS NULL').all(reader.id) as Array<{ credential_id: string; transports: string }>;
  if (passkeys.length >= readerConfig.passkeyMaximumCount) throw new HttpError(400, '通行密钥已达数量上限，请先删除不再使用的密钥');
  let account = database.prepare('SELECT webauthn_user_id FROM readers WHERE id=?').get(reader.id) as { webauthn_user_id: string | null };
  if (!validReaderToken(account.webauthn_user_id)) {
    database.prepare('UPDATE readers SET webauthn_user_id=? WHERE id=? AND webauthn_user_id IS NULL').run(readerToken(), reader.id);
    account = database.prepare('SELECT webauthn_user_id FROM readers WHERE id=?').get(reader.id) as { webauthn_user_id: string };
  }
  if (!validReaderToken(account.webauthn_user_id)) throw new HttpError(503, '通行密钥账号配置暂不可用');
  const options = await generateRegistrationOptions({ rpName: siteConfig.name, rpID: relyingPartyId,
    userID: new Uint8Array(Buffer.from(account.webauthn_user_id, 'base64url')), userName: reader.displayName, userDisplayName: reader.displayName,
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: readerConfig.passkeyAlgorithms, timeout: readerConfig.passkeyChallengeSeconds * 1000,
    excludeCredentials: passkeys.map((key) => ({ id: key.credential_id, transports: JSON.parse(key.transports) })),
  });
  storeChallenge('register', options.challenge, cookies, reader.id);
  return options;
}

function readCredentialResponse(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '通行密钥响应格式不正确');
  const response = value as Record<string, unknown>;
  if (response.type !== 'public-key' || typeof response.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(response.id)
    || response.rawId !== response.id || !response.response || typeof response.response !== 'object' || Array.isArray(response.response)) {
    throw new HttpError(400, '通行密钥响应格式不正确');
  }
  return response;
}

export async function verifyPasskeyRegistration(cookies: ReaderCookies, body: Record<string, unknown>) {
  const reader = requireRecentReaderSession(cookies);
  const challenge = consumeChallenge('register', cookies);
  const sessionToken = cookies.get(readerCookieName)?.value;
  if (challenge.reader_id !== reader.id || !validReaderToken(sessionToken) || challenge.session_hash !== readerTokenHash(sessionToken)) {
    throw new HttpError(400, '登录状态已变化，请重新添加通行密钥');
  }
  const response = readCredentialResponse(body.response);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || Array.from(label).length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new HttpError(400, '请为通行密钥填写1–60字的名称');
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: relyingPartyId,
      requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: readerConfig.passkeyAlgorithms });
  } catch { throw new HttpError(400, '通行密钥验证未通过，请重新尝试'); }
  if (!verification.verified) throw new HttpError(400, '通行密钥验证未通过，请重新尝试');
  const info = verification.registrationInfo;
  const database = getDatabase();
  database.transaction(() => {
    if (requireRecentReaderSession(cookies).id !== reader.id) throw new HttpError(401, '请重新验证身份', 'reauth_required');
    if (listReaderPasskeys(reader.id).length >= readerConfig.passkeyMaximumCount) throw new HttpError(400, '通行密钥已达数量上限');
    if (database.prepare('SELECT 1 FROM reader_passkeys WHERE credential_id=?').get(info.credential.id)) throw new HttpError(409, '这个通行密钥已经登记过，请使用另一枚密钥');
    database.prepare(`INSERT INTO reader_passkeys(credential_id,reader_id,public_key,counter,transports,label,device_type,backed_up,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(info.credential.id, reader.id, Buffer.from(info.credential.publicKey), info.credential.counter,
      JSON.stringify(info.credential.transports || []), label, info.credentialDeviceType, Number(info.credentialBackedUp), new Date().toISOString());
  }).immediate();
  return listReaderPasskeys(reader.id);
}

export async function createPasskeyLoginOptions(cookies: ReaderCookies) {
  const options = await generateAuthenticationOptions({ rpID: relyingPartyId, userVerification: 'required', allowCredentials: [],
    timeout: readerConfig.passkeyChallengeSeconds * 1000 });
  storeChallenge('login', options.challenge, cookies);
  return options;
}

export async function verifyPasskeyLogin(cookies: ReaderCookies, body: Record<string, unknown>): Promise<ReaderPublic> {
  const challenge = consumeChallenge('login', cookies);
  const response = readCredentialResponse(body.response);
  const assertion = response.response as Record<string, unknown>;
  const database = getDatabase();
  const passkey = database.prepare(`SELECT p.id,p.reader_id,p.public_key,p.counter,p.transports,r.webauthn_user_id
    FROM reader_passkeys p JOIN readers r ON r.id=p.reader_id WHERE p.credential_id=? AND p.deleted_at IS NULL AND r.deleted_at IS NULL`)
    .get(response.id) as { id: number; reader_id: number; public_key: Buffer; counter: number; transports: string; webauthn_user_id: string } | undefined;
  if (!passkey || assertion.userHandle !== passkey.webauthn_user_id) throw new HttpError(400, '通行密钥验证未通过，请使用其他方式登录');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({ response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: relyingPartyId, requireUserVerification: true,
      credential: { id: String(response.id), publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: JSON.parse(passkey.transports) } });
  } catch { throw new HttpError(400, '通行密钥验证未通过，请重新尝试'); }
  if (!verification.verified) throw new HttpError(400, '通行密钥验证未通过，请重新尝试');
  return database.transaction(() => {
    const changed = database.prepare(`UPDATE reader_passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=? AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM readers WHERE id=reader_id AND deleted_at IS NULL)`)
      .run(verification.authenticationInfo.newCounter, Number(verification.authenticationInfo.credentialBackedUp), new Date().toISOString(), passkey.id, passkey.counter).changes;
    if (!changed) throw new HttpError(409, '通行密钥状态已变化，请重新尝试');
    startReaderSession(cookies, { id: passkey.reader_id }, 'passkey', passkey.id);
    return readReaderSession(cookies)!;
  }).immediate();
}

export function deleteReaderPasskey(cookies: ReaderCookies, value: unknown) {
  const reader = requireRecentReaderSession(cookies);
  const id = readPositiveId(value);
  const database = getDatabase();
  database.transaction(() => {
    if (!database.prepare('UPDATE reader_passkeys SET deleted_at=? WHERE id=? AND reader_id=? AND deleted_at IS NULL').run(new Date().toISOString(), id, reader.id).changes) {
      throw new HttpError(404, '通行密钥不存在');
    }
    database.prepare('DELETE FROM reader_sessions WHERE reader_id=? AND passkey_id=?').run(reader.id, id);
  }).immediate();
  if (!readReaderSession(cookies)) cookies.delete(readerCookieName, readerCookieOptions());
  return listReaderPasskeys(reader.id);
}

import { createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { serverConfig } from '../config/server';

const deriveKey = promisify(scrypt);
const cookieName = 'samsblog_admin';
const production = () => import.meta.env.PROD || process.env.NODE_ENV === 'production';

function readSecret() {
  const secret = process.env.BLOG_SECRET;
  if (secret && secret.length >= 32) return secret;
  return production() ? undefined : 'development-only-change-me';
}

export function hasValidAdminSecret() {
  return Boolean(readSecret());
}

export async function verifyAdminPassword(password: string) {
  if (!readSecret() || !password || password.length > serverConfig.passwordMaxLength) return false;
  const configured = process.env.ADMIN_PASSWORD_HASH;
  if (!configured) return false;
  const [salt, expectedHex, extra] = configured.split(':');
  if (!salt || !/^[a-f\d]{128}$/i.test(expectedHex || '') || extra !== undefined) return false;
  const actual = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

export function createAdminSession() {
  const secret = readSecret();
  if (!secret) throw new Error('Invalid server configuration: BLOG_SECRET');
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + serverConfig.sessionSeconds * 1000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function verifyAdminSession(token?: string) {
  const secret = readSecret();
  if (!secret || !token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof value?.exp === 'number' && Number.isFinite(value.exp) && value.exp > Date.now();
  } catch { return false; }
}

export function readAdminSession(cookies: { get(name: string): { value: string } | undefined }) {
  return verifyAdminSession(cookies.get(cookieName)?.value);
}

export const adminCookie = {
  name: cookieName,
  options: { httpOnly: true, secure: production(), sameSite: 'strict' as const, path: '/', maxAge: serverConfig.sessionSeconds },
};

const attempts = new Map<string, { count: number; expiresAt: number }>();
let globalAttempts = { count: 0, expiresAt: 0 };

// 限制单来源与全站密码计算量，不保存原始地址
export function allowLoginAttempt(fingerprint: string, now = Date.now()) {
  for (const [key, value] of attempts) if (value.expiresAt <= now) attempts.delete(key);
  if (globalAttempts.expiresAt <= now) globalAttempts = { count: 0, expiresAt: now + serverConfig.loginWindowSeconds * 1000 };
  if (globalAttempts.count >= serverConfig.loginGlobalAttempts) return false;
  let value = attempts.get(fingerprint);
  if (!value) {
    if (attempts.size >= serverConfig.loginTrackedAddresses) return false;
    value = { count: 0, expiresAt: now + serverConfig.loginWindowSeconds * 1000 };
    attempts.set(fingerprint, value);
  }
  if (value.count >= serverConfig.loginAttempts) return false;
  value.count++;
  globalAttempts.count++;
  return true;
}

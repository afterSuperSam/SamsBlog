import { randomInt, timingSafeEqual } from 'node:crypto';
import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError } from './http';
import { parseNotificationEmail } from './reply-notifications';
import { readerUpstreamRequest } from './reader-transport';
import { getReaderAuthOptions, readerPrivateHash, readerToken, readerTokenHash, resolveReaderIdentity, startReaderSession, takeReaderAllowance, type ReaderCookies } from './readers';

const emailIdentity = (email: string) => readerPrivateHash('email', email);
export function readReaderEmail(value: unknown) {
  const email = parseNotificationEmail(value);
  if (!email) throw new HttpError(400, '请填写有效的邮箱地址');
  return email;
}

// 登录验证码独立于评论邮件队列；失败不重试、不持久保存验证码或邮件正文。
export async function sendReaderEmailCode(email: string, sourceHash: string) {
  if (!getReaderAuthOptions().email) throw new HttpError(503, '邮箱登录尚未配置');
  const sender = parseNotificationEmail(process.env.MAIL_FROM);
  const address = emailIdentity(email);
  if (!takeReaderAllowance([
    { key: `email-cooldown:${address}`, maximum: 1, seconds: readerConfig.emailCooldownSeconds },
    { key: `email-address:${address}`, maximum: readerConfig.emailAddressLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: `email-source:${sourceHash}`, maximum: readerConfig.emailSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'email-global', maximum: readerConfig.emailGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) return;
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = readerPrivateHash('email-code', `${address}:${code}`);
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_email_codes WHERE expires_at<=?').run(now);
    database.prepare(`INSERT INTO reader_email_codes(email_hash,code_hash,attempts,created_at,expires_at) VALUES (?,?,0,?,?)
      ON CONFLICT(email_hash) DO UPDATE SET code_hash=excluded.code_hash,attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .run(address, codeHash, now, now + readerConfig.codeSeconds * 1000);
  }).immediate();
  try {
    const result = await readerUpstreamRequest('email', { method: 'POST', headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `reader-code-${codeHash}-${now}`,
    }, body: JSON.stringify({ from: sender, to: [email], subject: 'SamsBlog 读者登录验证码',
      text: `你的登录验证码是 ${code}，${Math.ceil(readerConfig.codeSeconds / 60)} 分钟内有效。请勿向他人透露。若非本人操作，请忽略此邮件。` }) });
    if (typeof result.id !== 'string' || !result.id) throw new HttpError(502, '验证码暂时无法发送');
  } catch {
    database.prepare('DELETE FROM reader_email_codes WHERE email_hash=? AND code_hash=?').run(address, codeHash);
    console.warn('Reader email delivery unavailable');
  }
}

export function verifyReaderEmailCode(email: string, code: unknown, sourceHash: string, cookies: ReaderCookies) {
  if (!getReaderAuthOptions().email) throw new HttpError(503, '邮箱登录尚未配置');
  if (!takeReaderAllowance([
    { key: `verify-source:${sourceHash}`, maximum: readerConfig.verifySourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'verify-global', maximum: readerConfig.verifyGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '登录尝试过于频繁，请稍后重试');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpError(400, '请输入六位验证码');
  const address = emailIdentity(email);
  const submitted = readerPrivateHash('email-code', `${address}:${code}`);
  const database = getDatabase();
  const verified = database.transaction(() => {
    database.prepare('DELETE FROM reader_email_codes WHERE expires_at<=?').run(Date.now());
    const expected = database.prepare('SELECT code_hash AS codeHash,attempts FROM reader_email_codes WHERE email_hash=?').get(address) as { codeHash: string; attempts: number } | undefined;
    if (!expected || expected.attempts >= readerConfig.codeAttempts) return false;
    if (!timingSafeEqual(Buffer.from(expected.codeHash), Buffer.from(submitted))) {
      database.prepare('UPDATE reader_email_codes SET attempts=attempts+1 WHERE email_hash=?').run(address);
      return false;
    }
    database.prepare('DELETE FROM reader_email_codes WHERE email_hash=?').run(address);
    return true;
  }).immediate();
  if (!verified) throw new HttpError(400, '验证码无效或已过期，请重新获取');
  const identity = readerTokenHash(`verified-email:${email}`);
  const reader = resolveReaderIdentity('email', identity, `读者${readerToken().slice(0, 8)}`, null);
  startReaderSession(cookies, reader);
  return reader;
}

import { randomInt, timingSafeEqual } from 'node:crypto';
import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError } from './http';
import { isNotificationAddressSuppressed, parseNotificationEmail } from './reply-notifications';
import { readerUpstreamRequest } from './reader-transport';
import { getReaderAuthOptions, linkReaderIdentity, readReaderBindingToken, readerPrivateHash, readerToken, readerTokenHash, requireReaderIdentityLink,
  requireReaderReauthenticationIdentity, resolveReaderIdentity, startReaderSession, takeReaderAllowance, type ReaderCookies } from './readers';

const emailIdentity = (email: string) => readerPrivateHash('email', email);
export function readReaderEmail(value: unknown) {
  const email = parseNotificationEmail(value);
  if (!email) throw new HttpError(400, '请填写有效的邮箱地址');
  return email;
}

// 邮件展示使用纯 HTML 和文本两份内容，不依赖远程字体或图片。
export function createReaderCodeEmail(code: string, validitySeconds = readerConfig.codeSeconds) {
  if (!new RegExp(`^\\d{${readerConfig.codeLength}}$`).test(code) || !Number.isSafeInteger(validitySeconds) || validitySeconds <= 0) throw new Error('Invalid reader code email input');
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const minutes = Math.ceil(validitySeconds / 60);
  const subject = 'SamsBlog 读者登录验证码';
  const text = `你的登录验证码是 ${code}，${minutes} 分钟内有效。请勿向他人透露。若非本人操作，请忽略此邮件。`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head><body style="margin:0;padding:0;background:#f5f3ee;color:#303336;font-family:Arial,'Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf8;border-radius:20px;"><tr><td style="padding:30px 28px;">
<p style="margin:0 0 24px;color:#486779;font-size:22px;font-weight:700;">SamsBlog</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.5;font-weight:600;">读者登录验证码</h1>
<p style="margin:0 0 24px;color:#686d71;font-size:16px;line-height:1.8;">输入下方验证码，继续登录。</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:22px 16px;background:#eef2f3;border-radius:14px;font-family:Consolas,monospace;font-size:44px;line-height:1.2;letter-spacing:12px;font-weight:700;color:#304d5c;">${escape(code)}</td></tr></table>
<p style="margin:22px 0 0;color:#686d71;font-size:15px;line-height:1.8;">${escape(String(minutes))} 分钟内有效，请勿向他人透露。</p>
<p style="margin:10px 0 0;color:#85898b;font-size:14px;line-height:1.8;">若非本人操作，请忽略此邮件。</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// 登录验证码独立于评论邮件队列；失败不重试、不持久保存验证码或邮件正文。
export async function sendReaderEmailCode(email: string, sourceHash: string, binding?: { cookies: ReaderCookies; token: unknown }) {
  if (!getReaderAuthOptions().email) throw new HttpError(503, '邮箱登录尚未配置');
  const sender = parseNotificationEmail(process.env.MAIL_FROM);
  const address = emailIdentity(email);
  const bindingHash = binding ? readReaderBindingToken(binding.token) : undefined;
  if (binding && bindingHash) requireReaderIdentityLink(binding.cookies, bindingHash, 'email');
  const challengeAddress = bindingHash ? readerPrivateHash('email-binding', `${bindingHash}:${address}`) : address;
  if (!takeReaderAllowance([
    { key: `email-cooldown:${address}`, maximum: 1, seconds: readerConfig.emailCooldownSeconds },
    { key: `email-address:${address}`, maximum: readerConfig.emailAddressLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: `email-source:${sourceHash}`, maximum: readerConfig.emailSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'email-global', maximum: readerConfig.emailGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) return;
  if (isNotificationAddressSuppressed(email)) return;
  const code = String(randomInt(0, 10 ** readerConfig.codeLength)).padStart(readerConfig.codeLength, '0');
  const codeHash = readerPrivateHash('email-code', `${challengeAddress}:${code}`);
  const now = Date.now();
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('DELETE FROM reader_email_codes WHERE expires_at<=?').run(now);
    database.prepare(`INSERT INTO reader_email_codes(email_hash,code_hash,attempts,created_at,expires_at) VALUES (?,?,0,?,?)
      ON CONFLICT(email_hash) DO UPDATE SET code_hash=excluded.code_hash,attempts=0,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .run(challengeAddress, codeHash, now, now + readerConfig.codeSeconds * 1000);
  }).immediate();
  try {
    const result = await readerUpstreamRequest('email', { method: 'POST', headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `reader-code-${codeHash}-${now}`,
    }, body: JSON.stringify({ from: sender, to: [email], ...createReaderCodeEmail(code) }) });
    if (typeof result.id !== 'string' || !result.id) throw new HttpError(502, '验证码暂时无法发送');
  } catch {
    database.prepare('DELETE FROM reader_email_codes WHERE email_hash=? AND code_hash=?').run(challengeAddress, codeHash);
    console.warn('Reader email delivery unavailable');
  }
}

export function verifyReaderEmailCode(email: string, code: unknown, sourceHash: string, cookies: ReaderCookies, action: { bindingToken?: unknown; reauthenticate?: boolean } = {}) {
  if (!getReaderAuthOptions().email) throw new HttpError(503, '邮箱登录尚未配置');
  const address = emailIdentity(email);
  const bindingHash = action.bindingToken !== undefined ? readReaderBindingToken(action.bindingToken) : undefined;
  if (bindingHash) requireReaderIdentityLink(cookies, bindingHash, 'email');
  if (bindingHash && action.reauthenticate) throw new HttpError(400, '登录操作无效');
  const challengeAddress = bindingHash ? readerPrivateHash('email-binding', `${bindingHash}:${address}`) : address;
  if (!takeReaderAllowance([
    { key: `verify-minute-source:${sourceHash}`, maximum: readerConfig.verifyMinuteLimit, seconds: readerConfig.verifyMinuteSeconds, rolling: true },
    { key: `verify-minute-email:${address}`, maximum: readerConfig.verifyMinuteLimit, seconds: readerConfig.verifyMinuteSeconds, rolling: true },
    { key: `verify-source:${sourceHash}`, maximum: readerConfig.verifySourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'verify-global', maximum: readerConfig.verifyGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, `验证码验证过于频繁，每分钟最多 ${readerConfig.verifyMinuteLimit} 次，请稍后再试`);
  if (typeof code !== 'string' || !new RegExp(`^\\d{${readerConfig.codeLength}}$`).test(code)) throw new HttpError(400, '请输入三位验证码，旧验证码请重新获取');
  const submitted = readerPrivateHash('email-code', `${challengeAddress}:${code}`);
  const database = getDatabase();
  const verified = database.transaction(() => {
    database.prepare('DELETE FROM reader_email_codes WHERE expires_at<=?').run(Date.now());
    const expected = database.prepare('SELECT code_hash AS codeHash,attempts FROM reader_email_codes WHERE email_hash=?').get(challengeAddress) as { codeHash: string; attempts: number } | undefined;
    if (!expected || expected.attempts >= readerConfig.codeAttempts) return false;
    if (!timingSafeEqual(Buffer.from(expected.codeHash), Buffer.from(submitted))) {
      database.prepare('UPDATE reader_email_codes SET attempts=attempts+1 WHERE email_hash=?').run(challengeAddress);
      return false;
    }
    database.prepare('DELETE FROM reader_email_codes WHERE email_hash=?').run(challengeAddress);
    return true;
  }).immediate();
  if (!verified) throw new HttpError(400, '验证码无效或已过期，请重新获取');
  const identity = readerTokenHash(`verified-email:${email}`);
  if (bindingHash) return linkReaderIdentity(cookies, bindingHash, 'email', identity);
  if (action.reauthenticate) requireReaderReauthenticationIdentity(cookies, 'email', identity);
  const reader = resolveReaderIdentity('email', identity, `读者${readerToken().slice(0, 8)}`, null);
  startReaderSession(cookies, reader, 'email');
  return reader;
}

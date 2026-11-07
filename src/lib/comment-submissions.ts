import { createHash, randomUUID } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { HttpError } from './http';

const operationPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// 匿名身份在首屏建立，只落库摘要；账号切换使用独立的提交命名空间。
export function ensureCommentIdentity(cookies: AstroCookies, url: URL) {
  const identityCookie = url.protocol === 'https:' ? '__Host-samsblog-comment-identity' : 'samsblog-comment-identity';
  let identity = cookies.get(identityCookie)?.value;
  if (!identity || !operationPattern.test(identity)) {
    identity = randomUUID();
    cookies.set(identityCookie, identity, { httpOnly: true, secure: url.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: serverConfig.commentIdentitySeconds });
  }
  return `anonymous:${createHash('sha256').update(identity).digest('hex')}`;
}

export function readCommentOperationId(value: unknown) {
  if (typeof value !== 'string' || !operationPattern.test(value)) throw new HttpError(400, '提交编号无效，请刷新后重试');
  return value.toLowerCase();
}

// 调用方事务同时写入留言、通知与原始响应，重试先命中结果再检查提交额度。
export function completeCommentOperation(identity: string, operationId: string, request: unknown, create: () => { body: unknown; status: number }) {
  const database = getDatabase();
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return database.transaction(() => {
    const previous = database.prepare('SELECT request_hash,result_json,status_code FROM message_submissions WHERE identity_scope=? AND operation_id=?')
      .get(identity, operationId) as { request_hash: string; result_json: string; status_code: number } | undefined;
    if (previous) {
      if (previous.request_hash !== digest) throw new HttpError(409, '此提交编号已用于另一份内容，请恢复原输入重试；发表新内容请修改正文');
      return { body: JSON.parse(previous.result_json) as unknown, status: previous.status_code };
    }
    const result = create();
    database.prepare('INSERT INTO message_submissions(identity_scope,operation_id,request_hash,result_json,status_code,created_at) VALUES(?,?,?,?,?,?)')
      .run(identity, operationId, digest, JSON.stringify(result.body), result.status, new Date().toISOString());
    return result;
  }).immediate();
}

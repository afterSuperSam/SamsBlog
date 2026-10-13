import { createMessage, hasRecentSubmission, listPublishedMessages } from '../../../lib/db';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { HttpError, json, readJsonObject, readPositiveId, route } from '../../../lib/http';

export const GET = route(() => json({ messages: listPublishedMessages() }));

export const POST = route(async ({ request, clientAddress }) => {
  const body = await readJsonObject(request);
  if (body.website) return json({ ok: true });
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const parentId = body.parentId == null ? null : readPositiveId(body.parentId);
  if (nickname.length < 2 || nickname.length > 24) throw new HttpError(400, '昵称需要 2–24 个字符');
  if (content.length < 2 || content.length > 500) throw new HttpError(400, '留言需要 2–500 个字符');
  const fingerprintHash = fingerprintIp(getClientIp(request, clientAddress));
  if (hasRecentSubmission(fingerprintHash)) throw new HttpError(429, '提交得太快了，请稍后再试');
  createMessage({ parentId, nickname, content, fingerprintHash });
  return json({ ok: true, message: '留言已送达，审核后会公开展示。' }, 201);
});

import { createAdminReply, deleteMessage, listAllMessages, updateMessageStatus, type MessageStatus } from '../../../lib/db';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';

export const GET = adminRoute(() => json({ messages: listAllMessages() }));

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  const id = readPositiveId(body.id);
  if (body.status !== 'pending' && body.status !== 'published' && body.status !== 'hidden') throw new HttpError(400, '留言状态不正确');
  return updateMessageStatus(id, body.status as MessageStatus) ? json({ ok: true }) : json({ error: '留言不存在' }, 404);
});

export const POST = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  const parentId = readPositiveId(body.parentId);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length < 2 || content.length > 500) throw new HttpError(400, '回复需要 2–500 个字符');
  return json({ ok: true, id: createAdminReply(parentId, content) }, 201);
});

export const DELETE = adminRoute(async ({ request }) => {
  const id = readPositiveId((await readJsonObject(request)).id);
  return deleteMessage(id) ? json({ ok: true }) : json({ error: '留言不存在' }, 404);
});

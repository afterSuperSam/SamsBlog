import { auditAdminMutation } from '../../../lib/admin-audit';
import { createAdminReply, deleteMessage, listAllMessages, updateMessageStatus, type MessageStatus } from '../../../lib/db';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, requireSameOrigin } from '../../../lib/http';
import { queuePublishedThreadReplies, queueReplyNotification } from '../../../lib/reply-notifications';

export const GET = adminRoute(() => json({ messages: listAllMessages() }));

export const PATCH = adminRoute(async ({ request }) => {
  requireSameOrigin(request);
  const body = await readJsonObject(request);
  const id = readPositiveId(body.id);
  if (body.status !== 'pending' && body.status !== 'published' && body.status !== 'hidden') throw new HttpError(400, '留言状态不正确');
  const changed = auditAdminMutation({ objectType: 'message', objectId: id, operation: 'update' }, () => {
    if (!updateMessageStatus(id, body.status as MessageStatus)) return false;
    if (body.status === 'published') queuePublishedThreadReplies(id);
    return true;
  });
  return changed ? json({ ok: true }) : json({ error: '留言不存在' }, 404);
});

export const POST = adminRoute(async ({ request }) => {
  requireSameOrigin(request);
  const body = await readJsonObject(request);
  const parentId = readPositiveId(body.parentId);
  const replyTargetId = body.replyTargetId == null ? parentId : readPositiveId(body.replyTargetId);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const contentLength = Array.from(content).length;
  if (contentLength < 2 || contentLength > 500) throw new HttpError(400, '回复需要 2–500 个字符');
  if (content.includes('\u0000')) throw new HttpError(400, '回复包含不支持的字符');
  const id = auditAdminMutation({ objectType: 'message', objectId: replyTargetId, operation: 'reply' }, () => {
    const createdId = createAdminReply(parentId, content, replyTargetId);
    queueReplyNotification(replyTargetId, createdId);
    return createdId;
  });
  return json({ ok: true, id }, 201);
});

export const DELETE = adminRoute(async ({ request }) => {
  requireSameOrigin(request);
  const id = readPositiveId((await readJsonObject(request)).id);
  return auditAdminMutation({ objectType: 'message', objectId: id, operation: 'delete' }, () => deleteMessage(id)) ? json({ ok: true }) : json({ error: '留言不存在' }, 404);
});

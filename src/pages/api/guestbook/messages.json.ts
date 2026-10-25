import { createMessage, getDatabase, hasRecentSubmission, listPublishedMessages } from '../../../lib/db';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { HttpError, json, readJsonObject, readPositiveId, route, requireSameOrigin } from '../../../lib/http';
import { getArticle } from '../../../lib/articles';
import { parseNotificationEmail, queueAdminNotification, queueReplyNotification, replyNotificationsConfigured } from '../../../lib/reply-notifications';

export const GET = route(({ url }) => {
  const articleId = url.searchParams.has('articleId') ? readPositiveId(Number(url.searchParams.get('articleId'))) : null;
  if (articleId && !getArticle(articleId)) throw new HttpError(404, '文章不存在');
  return json({ messages: listPublishedMessages(60, articleId) });
});

export const POST = route(async ({ request, clientAddress }) => {
  requireSameOrigin(request);
  const body = await readJsonObject(request);
  if (body.website) return json({ ok: true });
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const parentId = body.parentId == null ? null : readPositiveId(body.parentId);
  const articleId = body.articleId == null ? null : readPositiveId(body.articleId);
  const quoteMessageId = body.quoteMessageId == null ? null : readPositiveId(body.quoteMessageId);
  if (body.quoteContent !== undefined && typeof body.quoteContent !== 'string') throw new HttpError(400, '引用内容格式不正确');
  const quoteContent = typeof body.quoteContent === 'string' ? body.quoteContent : '';
  const email = parseNotificationEmail(body.email);
  if (body.notifyReply !== undefined && typeof body.notifyReply !== 'boolean') throw new HttpError(400, '通知选项不正确');
  // 与 SQLite 的 length 约束统一按 Unicode 码点计数。
  const nicknameLength = Array.from(nickname).length;
  const contentLength = Array.from(content).length;
  if (nicknameLength < 2 || nicknameLength > 24) throw new HttpError(400, '昵称需要 2–24 个字符');
  if (contentLength < 2 || contentLength > 500) throw new HttpError(400, '留言需要 2–500 个字符');
  if (nickname.includes('\u0000')) throw new HttpError(400, '昵称包含不支持的字符');
  if (content.includes('\u0000')) throw new HttpError(400, '留言包含不支持的字符');
  const fingerprintHash = fingerprintIp(getClientIp(request, clientAddress));
  if (hasRecentSubmission(fingerprintHash)) throw new HttpError(429, '提交得太快了，请稍后再试');
  const wantsNotification = body.notifyReply === true && replyNotificationsConfigured;
  if (wantsNotification && !email) throw new HttpError(400, '接收回复通知需要填写邮箱');
  const id = getDatabase().transaction(() => {
    const createdId = createMessage({ parentId, articleId, quoteMessageId, quoteContent, nickname, content, fingerprintHash, email: wantsNotification ? email : '', notifyReply: wantsNotification });
    if (articleId && parentId) queueReplyNotification(parentId, createdId);
    queueAdminNotification('message', createdId);
    return createdId;
  })();
  return json({ ok: true, id, message: articleId ? '评论已发表。' : '留言已送达，审核后会公开展示。' }, 201);
});

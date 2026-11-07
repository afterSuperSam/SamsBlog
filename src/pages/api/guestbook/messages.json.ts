import { createMessage, hasReachedMessageSubmissionLimit, listPublishedMessages } from '../../../lib/db';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { HttpError, json, readJsonObject, readPositiveId, requirePublicActivityAllowance, route, requireSameOrigin } from '../../../lib/http';
import { getArticle } from '../../../lib/articles';
import { parseNotificationEmail, queueAdminNotification, queueReplyNotification, replyNotificationsConfigured, requestMessageNotificationVerification } from '../../../lib/reply-notifications';
import { readReaderSession } from '../../../lib/readers';
import { completeCommentOperation, ensureCommentIdentity, readCommentOperationId } from '../../../lib/comment-submissions';
import { getReaderNotificationEmail } from '../../../lib/reader-account';

export const GET = route(({ url }) => {
  const articleId = url.searchParams.has('articleId') ? readPositiveId(Number(url.searchParams.get('articleId'))) : null;
  if (articleId && !getArticle(articleId)) throw new HttpError(404, '文章不存在');
  return json({ messages: listPublishedMessages(60, articleId) });
});

export const POST = route(async ({ request, clientAddress, cookies }) => {
  requireSameOrigin(request);
  const fingerprintHash = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(fingerprintHash);
  const body = await readJsonObject(request);
  if (body.website) return json({ ok: true });
  const reader = readReaderSession(cookies);
  const operationId = readCommentOperationId(body.operationId);
  if (body.submissionIdentity !== undefined && body.submissionIdentity !== (reader ? `reader:${reader.id}` : 'anonymous')) throw new HttpError(409, '登录身份已变化，请在当前身份下重新提交');
  const identity = reader ? `reader:${reader.id}` : ensureCommentIdentity(cookies, new URL(request.url));
  const nickname = reader?.displayName ?? (typeof body.nickname === 'string' ? body.nickname.trim() : '');
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const parentId = body.parentId == null ? null : readPositiveId(body.parentId);
  const replyTargetId = body.replyTargetId == null ? parentId : readPositiveId(body.replyTargetId);
  const articleId = body.articleId == null ? null : readPositiveId(body.articleId);
  const quoteMessageId = body.quoteMessageId == null ? null : readPositiveId(body.quoteMessageId);
  if (body.quoteContent !== undefined && typeof body.quoteContent !== 'string') throw new HttpError(400, '引用内容格式不正确');
  const quoteContent = typeof body.quoteContent === 'string' ? body.quoteContent : '';
  const email = reader ? getReaderNotificationEmail(reader.id) : parseNotificationEmail(body.email);
  if (body.notifyReply !== undefined && typeof body.notifyReply !== 'boolean') throw new HttpError(400, '通知选项不正确');
  // 与 SQLite 的 length 约束统一按 Unicode 码点计数。
  const nicknameLength = Array.from(nickname).length;
  const contentLength = Array.from(content).length;
  if (nicknameLength < 2 || nicknameLength > 24) throw new HttpError(400, '昵称需要 2–24 个字符');
  if (contentLength < 2 || contentLength > 500) throw new HttpError(400, '留言需要 2–500 个字符');
  if (nickname.includes('\u0000')) throw new HttpError(400, '昵称包含不支持的字符');
  if (content.includes('\u0000')) throw new HttpError(400, '留言包含不支持的字符');
  const wantsNotification = body.notifyReply === true && replyNotificationsConfigured && (!reader || Boolean(email));
  if (wantsNotification && !email) throw new HttpError(400, '接收回复通知需要填写邮箱');
  const result = completeCommentOperation(identity, operationId, {
    parentId, replyTargetId, articleId, quoteMessageId, quoteContent, nickname: reader ? null : nickname, content,
    email: reader ? null : email, notifyReply: body.notifyReply === true,
  }, () => {
    if (hasReachedMessageSubmissionLimit(fingerprintHash)) throw new HttpError(429, '留言和评论已达提交上限，请稍后再试');
    const createdId = createMessage({ parentId, replyTargetId, articleId, quoteMessageId, quoteContent, nickname, content, fingerprintHash, readerId: reader?.id, email: wantsNotification ? email : '', notifyReply: wantsNotification, emailVerified: Boolean(reader && email) });
    if (reader && replyTargetId) queueReplyNotification(replyTargetId, createdId);
    const verificationQueued = !reader && wantsNotification && requestMessageNotificationVerification(createdId);
    queueAdminNotification('message', createdId);
    return { status: 201, body: { ok: true, id: createdId, status: reader ? 'published' : 'pending',
      message: (reader ? '已公开发表。' : '留言已送达，审核后会公开展示。') + (verificationQueued ? '请查看验证邮件，确认后才会启用回复通知。' : '') } };
  });
  return json(result.body, result.status);
});

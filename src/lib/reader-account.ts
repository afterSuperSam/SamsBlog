import type { APIRoute } from 'astro';
import { readerConfig } from '../config/readers';
import { getDatabase } from './db';
import { HttpError, route } from './http';
import { getMedia, removeUnusedAvatar, saveMedia } from './media';
import { parseNotificationEmail, requestReaderNotificationVerification, revokeReaderNotificationVerification } from './reply-notifications';
import { getReaderAuthOptions, listReaderIdentities, listReaderPasskeys, readReaderSession, type ReaderPublic } from './readers';

// 私有账户响应连同错误统一禁止缓存，身份只从服务端会话获取。
export const readerAccountRoute = (handler: APIRoute): APIRoute => async (context) => {
  const response = await route(handler)(context);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
};

export function requireReaderAccount(cookies: Parameters<typeof readReaderSession>[0]) {
  const reader = readReaderSession(cookies);
  if (!reader) throw new HttpError(401, '请先登录读者账号');
  return reader;
}

export function getReaderAccount(reader: ReaderPublic) {
  const database = getDatabase();
  const details = database.prepare(`SELECT display_name AS displayName,avatar_url AS avatarUrl,
    website_url AS websiteUrl,notification_email AS notificationEmail,notification_email_pending AS pendingEmail,
    notification_email_verified_at AS notificationEmailVerifiedAt,created_at AS createdAt FROM readers WHERE id=? AND deleted_at IS NULL`).get(reader.id) as {
      displayName: string; avatarUrl: string | null; websiteUrl: string; notificationEmail: string | null; pendingEmail: string | null; notificationEmailVerifiedAt: string | null; createdAt: string;
    } | undefined;
  if (!details) throw new HttpError(401, '读者登录已失效，请重新登录');
  const commentCount = (database.prepare('SELECT COUNT(*) AS count FROM messages WHERE reader_id=? AND deleted_at IS NULL').get(reader.id) as { count: number }).count;
  const { notificationEmail, pendingEmail, notificationEmailVerifiedAt, ...publicDetails } = details;
  return { reader: { ...reader, ...publicDetails }, notificationEmail: pendingEmail ?? notificationEmail ?? '',
    notificationEmailVerified: Boolean(notificationEmail && notificationEmailVerifiedAt && !pendingEmail),
    verifiedNotificationEmail: notificationEmailVerifiedAt ? notificationEmail || '' : '',
    commentCount, passkeys: listReaderPasskeys(reader.id), identities: listReaderIdentities(reader.id), authOptions: getReaderAuthOptions() };
}

// 通知地址独立于登录身份，仅用于当前账号设置和未来留言的收件快照。
export function getReaderNotificationEmail(readerId: number) {
  const row = getDatabase().prepare('SELECT notification_email AS email FROM readers WHERE id=? AND deleted_at IS NULL AND notification_email_verified_at IS NOT NULL').get(readerId) as { email: string | null } | undefined;
  return row?.email || '';
}

export function updateReaderProfile(reader: ReaderPublic, input: Record<string, unknown>) {
  if (typeof input.displayName !== 'string' || typeof input.websiteUrl !== 'string') throw new HttpError(400, '请填写昵称和网站地址');
  const displayName = input.displayName.trim();
  const length = Array.from(displayName).length;
  if (length < 2 || length > readerConfig.displayNameMaximumLength || /[\u0000-\u001f\u007f]/.test(displayName)) throw new HttpError(400, `昵称需要 2–${readerConfig.displayNameMaximumLength} 个字符，不能包含控制字符`);
  let websiteUrl = input.websiteUrl.trim();
  if (websiteUrl) {
    if (websiteUrl.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(websiteUrl)) throw new HttpError(400, '请填写有效的 HTTP(S) 网站地址');
    try {
      const address = new URL(websiteUrl);
      if (!['http:', 'https:'].includes(address.protocol) || !/^https?:\/\//i.test(websiteUrl) || address.username || address.password) throw new Error('Invalid profile website');
      websiteUrl = address.href;
    } catch { throw new HttpError(400, '请填写无账号密码的完整 HTTP(S) 网站地址'); }
  }
  if (input.notificationEmail !== undefined && typeof input.notificationEmail !== 'string') throw new HttpError(400, '请填写有效的邮箱地址');
  const notificationEmail = input.notificationEmail === undefined ? undefined : parseNotificationEmail(input.notificationEmail);
  getDatabase().transaction(() => {
    const current = getDatabase().prepare('SELECT notification_email AS email,notification_email_pending AS pending FROM readers WHERE id=? AND deleted_at IS NULL').get(reader.id) as { email: string | null; pending: string | null } | undefined;
    if (!current) throw new HttpError(401, '读者登录已失效，请重新登录');
    if (notificationEmail !== undefined) {
      if (!notificationEmail) {
        revokeReaderNotificationVerification(reader.id);
        getDatabase().prepare('UPDATE readers SET notification_email=NULL,notification_email_pending=NULL,notification_email_verified_at=NULL WHERE id=?').run(reader.id);
      } else {
        getDatabase().prepare('UPDATE readers SET notification_email_pending=? WHERE id=?').run(notificationEmail === current.email ? null : notificationEmail, reader.id);
      }
    }
    getDatabase().prepare('UPDATE readers SET display_name=?,website_url=?,updated_at=? WHERE id=?').run(displayName, websiteUrl, new Date().toISOString(), reader.id);
    if (notificationEmail) requestReaderNotificationVerification(reader.id);
  }).immediate();
  return { ...reader, displayName };
}

// 头像替换提交成功后再回收无引用的专用旧图，失败不会清理原头像。
export async function updateReaderAvatar(reader: ReaderPublic, file: File) {
  const media = await saveMedia(file, { maximumBytes: readerConfig.avatarMaximumBytes, restoreDeleted: false, purpose: 'avatar' });
  const result = getDatabase().transaction(() => {
    if (!getMedia(media.filename)) throw new HttpError(409, '这张图片暂不可用，请选择其他图片');
    const previous = getDatabase().prepare('SELECT avatar_url AS avatarUrl FROM readers WHERE id=? AND deleted_at IS NULL').get(reader.id) as { avatarUrl: string | null } | undefined;
    const result = getDatabase().prepare('UPDATE readers SET avatar_url=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(media.url, new Date().toISOString(), reader.id);
    if (!result.changes) throw new HttpError(401, '读者登录已失效，请重新登录');
    return { account: getReaderAccount(reader), previousAvatarUrl: previous?.avatarUrl ?? null };
  }).immediate();
  if (result.previousAvatarUrl !== media.url) {
    try { removeUnusedAvatar(result.previousAvatarUrl); }
    catch (error) { console.warn('Unused avatar cleanup failed', { code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }); }
  }
  return result.account;
}

// 仅返回本人未删除的内容；可见性同时控制文章标题与公开跳转入口。
export function listReaderComments(readerId: number, requestedPage = 1) {
  const database = getDatabase();
  const pageSize = readerConfig.accountPageSize;
  const total = (database.prepare('SELECT COUNT(*) AS count FROM messages WHERE reader_id=? AND deleted_at IS NULL').get(readerId) as { count: number }).count;
  const page = Math.min(Math.max(1, Math.ceil(total / pageSize)), Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const comments = database.prepare(`SELECT m.id,m.content,m.created_at AS createdAt,m.status,m.article_id AS articleId,m.parent_id AS parentId,
      CASE WHEN a.publication_status='published' AND a.deleted_at IS NULL THEN a.title ELSE NULL END AS articleTitle,
      CASE WHEN m.status='published' AND (m.parent_id IS NULL OR (parent.status='published' AND parent.deleted_at IS NULL))
        AND (m.article_id IS NULL OR (a.publication_status='published' AND a.deleted_at IS NULL))
        THEN CASE WHEN m.article_id IS NULL THEN '/#guestbook' ELSE '/articles/' || m.article_id || '#comments' END ELSE NULL END AS url
    FROM messages m LEFT JOIN blog_articles a ON a.id=m.article_id LEFT JOIN messages parent ON parent.id=m.parent_id
    WHERE m.reader_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`)
    .all(readerId, pageSize, (page - 1) * pageSize) as Array<{ id: number; content: string; createdAt: string; status: string; articleId: number | null; articleTitle: string | null; parentId: number | null; url: string | null }>;
  return { comments: comments.map((comment) => ({ ...comment, createdAt: new Date(comment.createdAt.includes('T') ? comment.createdAt : `${comment.createdAt.replace(' ', 'T')}Z`).toISOString() })), page, pageSize, total };
}

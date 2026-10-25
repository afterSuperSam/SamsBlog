import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverConfig } from '../config/server';
import { siteConfig } from '../config/site';
import { getDatabase } from './db';
import { HttpError } from './http';
import { createAdminEmail, createReplyEmail } from './reply-email';

export function parseNotificationEmail(value: unknown) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(value.trim())) throw new HttpError(400, '请填写有效的邮箱地址');
  return value.trim().toLowerCase();
}

const apiKey = process.env.RESEND_API_KEY || '';
const sender = parseNotificationEmail(process.env.MAIL_FROM || '');
const replyTo = parseNotificationEmail(process.env.MAIL_REPLY_TO || '');
const adminAddress = parseNotificationEmail(process.env.MAIL_ADMIN_TO || '');
const secret = process.env.BLOG_SECRET || '';
export const replyNotificationsConfigured = Boolean(apiKey && sender && secret.length >= 32);
export const adminNotificationsConfigured = replyNotificationsConfigured && Boolean(adminAddress);
const unsubscribeToken = (id: number) => createHmac('sha256', secret).update(`reply-notification:${id}`).digest('hex');

export function cancelReplyNotifications(id: number, token: string) {
  const expected = unsubscribeToken(id);
  if (!secret || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) throw new HttpError(400, '退订链接无效');
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('UPDATE messages SET notify_reply = 0, email = ? WHERE id = ?').run('', id);
    database.prepare("UPDATE mail_notifications SET status = 'cancelled',request_payload='' WHERE kind='reply' AND message_id = ? AND status != 'sent'").run(id);
  })();
}

export function queueReplyNotification(messageId: number, replyId: number) {
  if (!replyNotificationsConfigured) return;
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT OR IGNORE INTO mail_notifications(message_id,reply_id,created_at,updated_at)
    SELECT m.id,r.id,?,? FROM messages m JOIN messages r ON r.id=? AND r.parent_id=m.id AND r.article_id IS m.article_id
    WHERE m.id=? AND m.parent_id IS NULL AND m.notify_reply=1 AND m.email!='' AND m.deleted_at IS NULL AND m.status='published'
      AND r.deleted_at IS NULL AND r.status='published'
      AND (m.article_id IS NULL OR EXISTS (SELECT 1 FROM blog_articles a WHERE a.id=m.article_id AND a.deleted_at IS NULL AND a.publication_status='published'))`)
    .run(now, now, replyId, messageId);
  scheduleReplyNotifications();
}

// 审核公开根留言或回复时补排尚未入队的公开回复，唯一约束避免重复通知。
export function queuePublishedThreadReplies(id: number) {
  if (!replyNotificationsConfigured) return;
  const replies = getDatabase().prepare(`SELECT r.parent_id AS parentId,r.id FROM messages r
    WHERE r.parent_id IS NOT NULL AND (r.parent_id=? OR r.id=?) AND r.status='published' AND r.deleted_at IS NULL`)
    .all(id, id) as Array<{ parentId: number; id: number }>;
  for (const reply of replies) queueReplyNotification(reply.parentId, reply.id);
}

// 只由公开提交接口排入站长提醒，审核或后台回复不会重复通知自己。
export function queueAdminNotification(kind: 'message' | 'application', id: number) {
  if (!adminNotificationsConfigured) return;
  const now = new Date().toISOString();
  if (kind === 'message') {
    getDatabase().prepare(`INSERT OR IGNORE INTO mail_notifications(kind,message_id,created_at,updated_at)
      SELECT 'message',id,?,? FROM messages WHERE id=? AND deleted_at IS NULL AND status!='hidden' AND fingerprint_hash!='admin'`).run(now, now, id);
  } else {
    getDatabase().prepare(`INSERT OR IGNORE INTO mail_notifications(kind,application_id,created_at,updated_at)
      SELECT 'application',id,?,? FROM friend_applications WHERE id=? AND deleted_at IS NULL AND status='pending'`).run(now, now, id);
  }
  scheduleReplyNotifications();
}

export function listReplyNotifications() {
  return getDatabase().prepare(`SELECT n.id,n.kind,n.status,n.attempts,n.created_at AS createdAt,COALESCE(m.nickname,f.name,'') AS nickname,m.article_id AS articleId
    FROM mail_notifications n LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN friend_applications f ON f.id=n.application_id
    ORDER BY n.created_at DESC,n.id DESC LIMIT 100`).all() as Array<{ id: number; kind: 'reply' | 'message' | 'application'; status: 'pending' | 'sent' | 'failed' | 'cancelled'; attempts: number; createdAt: string; nickname: string; articleId: number | null }>;
}

function prepareNotification(notification: Record<string, unknown>) {
  const base = siteConfig.rss.siteUrl;
  if (notification.kind === 'reply') {
    if (!notification.notifyReply || !notification.email || notification.parentDeleted || notification.replyDeleted
      || notification.parentStatus !== 'published' || notification.replyStatus !== 'published'
      || (notification.articleId && (notification.articleDeleted || notification.articleStatus !== 'published'))) return null;
    const address = new URL(notification.articleId ? `/articles/${notification.articleId}#comments` : '/#guestbook', base).href;
    const unsubscribe = new URL(`/notifications?message=${notification.messageId}&token=${unsubscribeToken(Number(notification.messageId))}`, base).href;
    return { to: [String(notification.email)], ...createReplyEmail({ nickname: String(notification.nickname), replyNickname: String(notification.replyNickname),
      contextTitle: String(notification.title || '留言纸条'), originalContent: String(notification.originalContent), content: String(notification.content),
      isOwnerReply: notification.replyFingerprint === 'admin', address, unsubscribe }, serverConfig.notificationReplyTemplateId) };
  }
  if (!adminNotificationsConfigured) return null;
  if (notification.kind === 'message') {
    if (notification.parentDeleted || notification.parentStatus === 'hidden' || notification.messageFingerprint === 'admin') return null;
    return { to: [adminAddress], ...createAdminEmail({ event: notification.parentId ? '收到一条访客回复' : notification.articleId ? '收到一条文章评论' : '收到一张留言纸条',
      name: String(notification.nickname), context: String(notification.title || '留言纸条'), content: String(notification.originalContent),
      address: new URL('/admin/messages', base).href }, serverConfig.notificationAdminTemplateId) };
  }
  if (notification.applicationDeleted || notification.applicationStatus !== 'pending') return null;
  return { to: [adminAddress], ...createAdminEmail({ event: '收到一份友链申请', name: String(notification.applicationName), context: '网站友链 · 等待审核',
    content: [notification.applicationUrl, notification.applicationDescription, notification.applicationEmail ? `联系邮箱：${notification.applicationEmail}` : ''].filter(Boolean).join('\n\n'),
    address: new URL('/admin/applications', base).href }, serverConfig.notificationAdminTemplateId) };
}

let workerTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;

// 队列先落库再投递；错误只记录分类，不记录地址、正文或密钥。
export function scheduleReplyNotifications(delay = 0) {
  if (!replyNotificationsConfigured || running || workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = undefined;
    void deliverReplyNotifications().catch((error: unknown) => {
      console.error('Reply notification worker failed', { type: error instanceof Error ? error.name : typeof error });
    });
  }, delay);
  workerTimer.unref();
}

export async function deliverReplyNotifications() {
  if (!replyNotificationsConfigured || running) return;
  const database = getDatabase();
  running = true;
  try {
    database.prepare("UPDATE mail_notifications SET status='failed',request_payload='' WHERE status='pending' AND datetime(created_at) < datetime('now',?)").run(`-${serverConfig.notificationExpiryHours} hours`);
    const queued = database.prepare("SELECT id FROM mail_notifications WHERE status='pending' AND retry_at <= ? ORDER BY id LIMIT ?")
      .all(new Date().toISOString(), serverConfig.notificationBatchSize) as Array<{ id: number }>;
    for (const item of queued) {
      const notification = database.prepare(`SELECT n.id,n.kind,n.attempts,n.request_payload AS requestPayload,n.message_id AS messageId,n.reply_id AS replyId,
      m.email,m.notify_reply AS notifyReply,m.deleted_at AS parentDeleted,m.status AS parentStatus,m.nickname,m.article_id AS articleId,
      m.content AS originalContent,m.parent_id AS parentId,m.fingerprint_hash AS messageFingerprint,
      r.content,r.nickname AS replyNickname,r.fingerprint_hash AS replyFingerprint,r.deleted_at AS replyDeleted,r.status AS replyStatus,
      a.title,a.deleted_at AS articleDeleted,a.publication_status AS articleStatus,
      f.name AS applicationName,f.url AS applicationUrl,f.description AS applicationDescription,f.email AS applicationEmail,f.status AS applicationStatus,f.deleted_at AS applicationDeleted
      FROM mail_notifications n LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN messages r ON r.id=n.reply_id
      LEFT JOIN blog_articles a ON a.id=m.article_id
      LEFT JOIN friend_applications f ON f.id=n.application_id
      WHERE n.id=? AND n.status='pending'`).get(item.id) as Record<string, unknown> | undefined;
      if (!notification) continue;
      const prepared = prepareNotification(notification);
      if (!prepared) {
        database.prepare("UPDATE mail_notifications SET status='cancelled',request_payload='' WHERE id=? AND status='pending'").run(notification.id);
        continue;
      }
      const attempts = Number(notification.attempts) + 1;
      const now = new Date().toISOString();
      const payload = String(notification.requestPayload || JSON.stringify({ from: `SamsBlog <${sender}>`,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...prepared }));
      database.prepare("UPDATE mail_notifications SET request_payload=? WHERE id=? AND status='pending'").run(payload, notification.id);
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(serverConfig.notificationTimeoutMilliseconds),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `samsblog-${notification.kind}-${notification.id}` },
          body: payload,
        });
        if (!response.ok) {
          const retry = response.status === 429 || response.status >= 500;
          const status = retry && attempts < serverConfig.notificationMaximumAttempts ? 'pending' : 'failed';
          database.prepare("UPDATE mail_notifications SET status=?,attempts=?,updated_at=?,retry_at=?,request_payload=? WHERE id=? AND status='pending'")
            .run(status, attempts, now, new Date(Date.now() + serverConfig.notificationRetrySeconds * 1000 * 2 ** attempts).toISOString(), status === 'pending' ? payload : '', notification.id);
          console.warn('Reply notification provider rejected request', { status: response.status });
          continue;
        }
        const result = await response.json() as { id?: unknown };
        if (typeof result.id !== 'string') throw new Error('Invalid provider response');
        database.prepare("UPDATE mail_notifications SET status='sent',attempts=?,updated_at=?,provider_id=?,request_payload='' WHERE id=? AND status='pending'").run(attempts, now, result.id, notification.id);
      } catch (error) {
        const status = attempts < serverConfig.notificationMaximumAttempts ? 'pending' : 'failed';
        database.prepare("UPDATE mail_notifications SET status=?,attempts=?,updated_at=?,retry_at=?,request_payload=? WHERE id=? AND status='pending'")
          .run(status, attempts, now, new Date(Date.now() + serverConfig.notificationRetrySeconds * 1000 * 2 ** attempts).toISOString(), status === 'pending' ? payload : '', notification.id);
        console.warn('Reply notification delivery unavailable', { type: error instanceof Error ? error.name : typeof error });
      }
    }
  } finally {
    running = false;
    if (database.prepare("SELECT 1 FROM mail_notifications WHERE status='pending' LIMIT 1").get()) scheduleReplyNotifications(serverConfig.notificationRetrySeconds * 1000);
  }
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverConfig } from '../config/server';
import { siteConfig } from '../config/site';
import { getDatabase } from './db';
import { HttpError } from './http';
import { createAdminEmail, createApplicationAcceptedEmail, createNotificationVerificationEmail, createReplyEmail } from './reply-email';
import { isMaintenanceMode } from './maintenance';

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
const notificationAddressHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

export function isNotificationAddressSuppressed(email: string) {
  return Boolean(getDatabase().prepare('SELECT 1 FROM mail_suppressions WHERE email_hash=?').get(notificationAddressHash(email)));
}

// 验证资格只绑定一条留言或一个读者；地址级限额阻止借匿名留言反复发送验证信。
function queueNotificationVerification(email: string, readerId: number | null, messageId: number | null) {
  if (!replyNotificationsConfigured || !email || isNotificationAddressSuppressed(email)) return false;
  const database = getDatabase();
  return database.transaction(() => {
    const now = new Date().toISOString();
    const recent = database.prepare(`SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM notification_email_verifications
      WHERE email=? AND created_at>?`).get(email, new Date(Date.now() - 86400000).toISOString()) as { count: number; latest: string | null };
    if (recent.count >= serverConfig.notificationVerificationDailyLimit
      || (recent.latest && Date.parse(recent.latest) > Date.now() - serverConfig.notificationVerificationCooldownSeconds * 1000)) return false;
    database.prepare('UPDATE notification_email_verifications SET revoked_at=? WHERE reader_id IS ? AND message_id IS ? AND consumed_at IS NULL AND revoked_at IS NULL').run(now, readerId, messageId);
    const token = randomBytes(32).toString('hex');
    const result = database.prepare(`INSERT INTO notification_email_verifications(token_hash,email,reader_id,message_id,created_at,expires_at)
      VALUES(?,?,?,?,?,?)`).run(createHash('sha256').update(token).digest('hex'), email, readerId, messageId, now, new Date(Date.now() + serverConfig.notificationVerificationSeconds * 1000).toISOString());
    const address = new URL('/notifications/verify', siteConfig.rss.siteUrl); address.searchParams.set('token', token);
    const payload = JSON.stringify({ from: `SamsBlog <${sender}>`, ...(replyTo ? { reply_to: replyTo } : {}), to: [email],
      ...createNotificationVerificationEmail({ address: address.href, expiresInMinutes: Math.ceil(serverConfig.notificationVerificationSeconds / 60) }) });
    database.prepare(`INSERT INTO mail_notifications(kind,verification_id,created_at,updated_at,request_payload,recipient_hash)
      VALUES('verification',?,?,?,?,?)`).run(result.lastInsertRowid, now, now, payload, notificationAddressHash(email));
    scheduleReplyNotifications();
    return true;
  })();
}

export function requestMessageNotificationVerification(messageId: number) {
  const message = getDatabase().prepare(`SELECT email FROM messages WHERE id=? AND reader_id IS NULL AND notify_reply=1
    AND email_verified_at IS NULL AND deleted_at IS NULL AND status!='hidden'`).get(messageId) as { email: string } | undefined;
  return message ? queueNotificationVerification(message.email, null, messageId) : false;
}

export function requestReaderNotificationVerification(readerId: number) {
  const reader = getDatabase().prepare(`SELECT COALESCE(notification_email_pending,notification_email) AS email FROM readers
    WHERE id=? AND deleted_at IS NULL AND (notification_email_pending IS NOT NULL OR notification_email_verified_at IS NULL)`)
    .get(readerId) as { email: string | null } | undefined;
  return reader?.email ? queueNotificationVerification(reader.email, readerId, null) : false;
}

export function revokeReaderNotificationVerification(readerId: number) {
  const database = getDatabase();
  const now = new Date().toISOString();
  database.prepare('UPDATE notification_email_verifications SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(now, readerId);
  database.prepare("UPDATE mail_notifications SET status='cancelled',request_payload='' WHERE status='pending' AND (verification_id IN (SELECT id FROM notification_email_verifications WHERE reader_id=?) OR (kind='reply' AND message_id IN (SELECT id FROM messages WHERE reader_id=?)))").run(readerId, readerId);
  database.prepare("UPDATE messages SET email='',notify_reply=0,email_verified_at=NULL WHERE reader_id=?").run(readerId);
}

export function confirmNotificationEmail(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, '验证链接无效或已过期');
  const database = getDatabase();
  database.transaction(() => {
    const now = new Date().toISOString();
    const verification = database.prepare(`SELECT id,email,reader_id AS readerId,message_id AS messageId FROM notification_email_verifications
      WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
      .get(createHash('sha256').update(token).digest('hex'), now) as { id: number; email: string; readerId: number | null; messageId: number | null } | undefined;
    if (!verification || isNotificationAddressSuppressed(verification.email)) throw new HttpError(400, '验证链接无效或已过期');
    if (verification.readerId) {
      const reader = database.prepare('SELECT COALESCE(notification_email_pending,notification_email) AS email FROM readers WHERE id=? AND deleted_at IS NULL')
        .get(verification.readerId) as { email: string | null } | undefined;
      if (reader?.email !== verification.email) throw new HttpError(400, '通知邮箱已变更，请使用最新验证链接');
      revokeReaderNotificationVerification(verification.readerId);
      database.prepare('UPDATE readers SET notification_email=?,notification_email_pending=NULL,notification_email_verified_at=?,updated_at=? WHERE id=?')
        .run(verification.email, now, now, verification.readerId);
    } else {
      const updated = database.prepare(`UPDATE messages SET email_verified_at=? WHERE id=? AND reader_id IS NULL AND email=? AND notify_reply=1
        AND deleted_at IS NULL AND status!='hidden'`).run(now, verification.messageId, verification.email);
      if (!updated.changes) throw new HttpError(400, '这条留言已停止接收通知');
    }
    database.prepare('UPDATE notification_email_verifications SET consumed_at=?,revoked_at=NULL WHERE id=?').run(now, verification.id);
  }).immediate();
}

// Svix 原始字节签名覆盖事件编号、时间戳和正文；事件去重与地址抑制在同一事务提交。
export function processResendWebhook(payload: Buffer, headers: Headers, now = Date.now()) {
  const webhookSecret = serverConfig.notificationWebhookSecret;
  if (!webhookSecret) throw new HttpError(503, '邮件回执尚未配置');
  const eventId = headers.get('svix-id') || '';
  const timestamp = headers.get('svix-timestamp') || '';
  const signatures = headers.get('svix-signature') || '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !/^\d{1,12}$/.test(timestamp) || signatures.length > 2048
    || Math.abs(Number(timestamp) * 1000 - now) > serverConfig.notificationWebhookToleranceSeconds * 1000) throw new HttpError(400, '邮件回执签名无效');
  const expected = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64')).update(`${eventId}.${timestamp}.`).update(payload).digest();
  const verified = signatures.split(/\s+/).some((signature) => {
    const match = /^v1,([A-Za-z0-9+/]{43}=)$/.exec(signature);
    if (!match) return false;
    const value = Buffer.from(match[1], 'base64');
    return value.length === expected.length && timingSafeEqual(value, expected);
  });
  if (!verified) throw new HttpError(400, '邮件回执签名无效');
  let event: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; to?: unknown } };
  try { event = JSON.parse(payload.toString('utf8')); } catch { throw new HttpError(400, '邮件回执格式无效'); }
  if (!event || typeof event !== 'object' || !['email.delivered', 'email.bounced', 'email.complained'].includes(String(event.type))) return;
  if (typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))
    || typeof event.data?.email_id !== 'string' || !event.data.email_id || event.data.email_id.length > 128 || !Array.isArray(event.data.to)) throw new HttpError(400, '邮件回执格式无效');
  const providerId = event.data.email_id;
  const createdAt = new Date(event.created_at).toISOString();
  const eventType = String(event.type);
  const status = eventType.slice(6) as 'delivered' | 'bounced' | 'complained';
  const recipientHashes = event.data.to.filter((email): email is string => typeof email === 'string' && email.length <= 254).map(notificationAddressHash);
  const database = getDatabase();
  database.transaction(() => {
    const notification = database.prepare('SELECT id,recipient_hash AS recipientHash,delivery_status AS deliveryStatus,delivery_updated_at AS deliveryUpdatedAt FROM mail_notifications WHERE provider_id=? AND provider_id!=\'\'')
      .get(providerId) as { id: number; recipientHash: string; deliveryStatus: string; deliveryUpdatedAt: string } | undefined;
    if (!notification?.recipientHash || !recipientHashes.includes(notification.recipientHash)) return;
    const inserted = database.prepare('INSERT OR IGNORE INTO mail_webhook_events(event_id,provider_id,event_type,created_at) VALUES(?,?,?,?)').run(eventId, providerId, eventType, createdAt);
    if (!inserted.changes) return;
    const precedence: Record<string, number> = { '': 0, delivered: 1, bounced: 2, complained: 3 };
    if (precedence[status] > precedence[notification.deliveryStatus]
      || (status === notification.deliveryStatus && createdAt > notification.deliveryUpdatedAt)) {
      database.prepare('UPDATE mail_notifications SET delivery_status=?,delivery_updated_at=? WHERE id=?').run(status, createdAt, notification.id);
    }
    if (status !== 'delivered') {
      database.prepare(`INSERT INTO mail_suppressions(email_hash,reason,created_at) VALUES(?,?,?)
        ON CONFLICT(email_hash) DO UPDATE SET reason=CASE WHEN mail_suppressions.reason='complained' THEN 'complained' ELSE excluded.reason END,
          created_at=MIN(mail_suppressions.created_at,excluded.created_at)`).run(notification.recipientHash, status, createdAt);
      database.prepare("UPDATE mail_notifications SET status='cancelled',request_payload='' WHERE recipient_hash=? AND status='pending'").run(notification.recipientHash);
    }
  }).immediate();
}

export function cancelReplyNotifications(id: number, token: string) {
  const expected = unsubscribeToken(id);
  if (!secret || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) throw new HttpError(400, '退订链接无效');
  const database = getDatabase();
  database.transaction(() => {
    database.prepare('UPDATE messages SET notify_reply = 0, email_verified_at=NULL, email = ? WHERE id = ?').run('', id);
    database.prepare('UPDATE notification_email_verifications SET revoked_at=? WHERE message_id=? AND consumed_at IS NULL').run(new Date().toISOString(), id);
    database.prepare("UPDATE mail_notifications SET status = 'cancelled',request_payload='' WHERE kind='reply' AND message_id = ? AND status != 'sent'").run(id);
  })();
}

export function queueReplyNotification(messageId: number, replyId: number) {
  if (!replyNotificationsConfigured) return;
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT OR IGNORE INTO mail_notifications(message_id,reply_id,created_at,updated_at)
    SELECT m.id,r.id,?,? FROM messages m JOIN messages r ON r.id=? AND r.reply_target_id=m.id AND r.article_id IS m.article_id
    JOIN messages root ON root.id=r.parent_id AND root.parent_id IS NULL AND root.status='published' AND root.deleted_at IS NULL
    WHERE m.id=? AND (m.id=root.id OR m.parent_id=root.id) AND m.notify_reply=1 AND m.email!='' AND m.email_verified_at IS NOT NULL AND m.deleted_at IS NULL AND m.status='published'
      AND r.deleted_at IS NULL AND r.status='published'
      AND (m.article_id IS NULL OR EXISTS (SELECT 1 FROM blog_articles a WHERE a.id=m.article_id AND a.deleted_at IS NULL AND a.publication_status='published'))`)
    .run(now, now, replyId, messageId);
  scheduleReplyNotifications();
}

// 审核公开根留言或回复时补排尚未入队的公开回复，唯一约束避免重复通知。
export function queuePublishedThreadReplies(id: number) {
  if (!replyNotificationsConfigured) return;
  const replies = getDatabase().prepare(`SELECT r.reply_target_id AS replyTargetId,r.id FROM messages r
    WHERE r.parent_id IS NOT NULL AND (r.parent_id=? OR r.id=? OR r.reply_target_id=?) AND r.status='published' AND r.deleted_at IS NULL`)
    .all(id, id, id) as Array<{ replyTargetId: number; id: number }>;
  for (const reply of replies) queueReplyNotification(reply.replyTargetId, reply.id);
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

// 审核事务中只落库，通过状态和正式友链关系共同限定回信对象。
export function queueAcceptedFriendApplication(id: number) {
  if (!replyNotificationsConfigured) return false;
  const now = new Date().toISOString();
  return getDatabase().prepare(`INSERT OR IGNORE INTO mail_notifications(kind,application_id,created_at,updated_at)
    SELECT 'application_accepted',application.id,?,? FROM friend_applications AS application
    JOIN friends AS friend ON friend.id=application.friend_id
    WHERE application.id=? AND application.status='accepted' AND application.email!='' AND application.deleted_at IS NULL
      AND friend.visible=1 AND friend.deleted_at IS NULL`).run(now, now, id).changes === 1;
}

export function listReplyNotifications() {
  return getDatabase().prepare(`SELECT n.id,n.kind,n.status,n.delivery_status AS deliveryStatus,n.delivery_updated_at AS deliveryUpdatedAt,n.attempts,n.created_at AS createdAt,COALESCE(m.nickname,f.name,'') AS nickname,m.article_id AS articleId
    FROM mail_notifications n LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN friend_applications f ON f.id=n.application_id
    ORDER BY n.created_at DESC,n.id DESC LIMIT 100`).all() as Array<{ id: number; kind: 'reply' | 'message' | 'application' | 'application_accepted' | 'verification'; status: 'pending' | 'sent' | 'failed' | 'cancelled'; deliveryStatus: '' | 'delivered' | 'bounced' | 'complained'; deliveryUpdatedAt: string; attempts: number; createdAt: string; nickname: string; articleId: number | null }>;
}

function prepareNotification(notification: Record<string, unknown>) {
  const base = siteConfig.rss.siteUrl;
  if (notification.kind === 'verification') {
    if (!notification.verificationEligible || !notification.requestPayload) return null;
    return JSON.parse(String(notification.requestPayload)) as { to: string[]; subject: string; html: string; text: string };
  }
  if (notification.kind === 'reply') {
    if (!notification.notifyReply || !notification.email || !notification.emailVerified || !notification.threadVisible || !notification.targetMatches
      || (notification.readerId && (!notification.readerVerified || notification.readerEmail !== notification.email || notification.readerDeleted)) || notification.parentDeleted || notification.replyDeleted
      || notification.parentStatus !== 'published' || notification.replyStatus !== 'published'
      || (notification.articleId && (notification.articleDeleted || notification.articleStatus !== 'published'))) return null;
    const address = new URL(notification.articleId ? `/articles/${notification.articleId}#comments` : '/#guestbook', base).href;
    const unsubscribe = new URL(`/notifications?message=${notification.messageId}&token=${unsubscribeToken(Number(notification.messageId))}`, base).href;
    return { to: [String(notification.email)], ...createReplyEmail({ nickname: String(notification.nickname), replyNickname: String(notification.replyNickname),
      contextTitle: String(notification.title || '留言纸条'), originalContent: String(notification.originalContent), content: String(notification.content),
      isOwnerReply: notification.replyFingerprint === 'admin', address, unsubscribe }, serverConfig.notificationReplyTemplateId) };
  }
  if (notification.kind === 'application_accepted') {
    if (notification.applicationDeleted || notification.applicationStatus !== 'accepted' || !notification.applicationEmail
      || !notification.acceptedFriendId || !notification.acceptedFriendVisible || notification.acceptedFriendDeleted) return null;
    return { to: [String(notification.applicationEmail)], ...createApplicationAcceptedEmail({
      name: String(notification.acceptedFriendName), address: new URL('/about#friends', base).href,
    }) };
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
  if (!replyNotificationsConfigured || isMaintenanceMode() || running || workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = undefined;
    void deliverReplyNotifications().catch((error: unknown) => {
      console.error('Reply notification worker failed', { type: error instanceof Error ? error.name : typeof error });
    });
  }, delay);
  workerTimer.unref();
}

export async function deliverReplyNotifications() {
  if (!replyNotificationsConfigured || isMaintenanceMode() || running) return;
  const database = getDatabase();
  running = true;
  try {
    database.prepare("UPDATE mail_notifications SET status='failed',request_payload='' WHERE status='pending' AND datetime(created_at) < datetime('now',?)").run(`-${serverConfig.notificationExpiryHours} hours`);
    const queued = database.prepare("SELECT id FROM mail_notifications WHERE status='pending' AND retry_at <= ? ORDER BY id LIMIT ?")
      .all(new Date().toISOString(), serverConfig.notificationBatchSize) as Array<{ id: number }>;
    for (const item of queued) {
      const notification = database.prepare(`SELECT n.id,n.kind,n.attempts,n.request_payload AS requestPayload,n.message_id AS messageId,n.reply_id AS replyId,
      m.email,m.email_verified_at AS emailVerified,m.reader_id AS readerId,reader.notification_email AS readerEmail,reader.notification_email_verified_at AS readerVerified,reader.deleted_at AS readerDeleted,
      (root.id IS NOT NULL AND root.status='published' AND root.deleted_at IS NULL) AS threadVisible,
      (r.reply_target_id=m.id AND r.article_id IS m.article_id AND (m.id=root.id OR m.parent_id=root.id)) AS targetMatches,
      m.notify_reply AS notifyReply,m.deleted_at AS parentDeleted,m.status AS parentStatus,m.nickname,m.article_id AS articleId,
      m.content AS originalContent,m.parent_id AS parentId,m.fingerprint_hash AS messageFingerprint,
      r.content,r.nickname AS replyNickname,r.fingerprint_hash AS replyFingerprint,r.deleted_at AS replyDeleted,r.status AS replyStatus,
      a.title,a.deleted_at AS articleDeleted,a.publication_status AS articleStatus,
      f.name AS applicationName,f.url AS applicationUrl,f.description AS applicationDescription,f.email AS applicationEmail,f.status AS applicationStatus,f.deleted_at AS applicationDeleted,
      accepted.id AS acceptedFriendId,accepted.name AS acceptedFriendName,accepted.visible AS acceptedFriendVisible,accepted.deleted_at AS acceptedFriendDeleted,
      (verification.id IS NOT NULL AND verification.consumed_at IS NULL AND verification.revoked_at IS NULL AND verification.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND ((verification.reader_id IS NOT NULL AND verification_reader.deleted_at IS NULL AND COALESCE(verification_reader.notification_email_pending,verification_reader.notification_email)=verification.email)
          OR (verification.message_id IS NOT NULL AND verification_message.deleted_at IS NULL AND verification_message.status!='hidden' AND verification_message.notify_reply=1 AND verification_message.email=verification.email))) AS verificationEligible
      FROM mail_notifications n LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN messages r ON r.id=n.reply_id
      LEFT JOIN messages root ON root.id=r.parent_id
      LEFT JOIN readers reader ON reader.id=m.reader_id
      LEFT JOIN notification_email_verifications verification ON verification.id=n.verification_id
      LEFT JOIN readers verification_reader ON verification_reader.id=verification.reader_id
      LEFT JOIN messages verification_message ON verification_message.id=verification.message_id
      LEFT JOIN blog_articles a ON a.id=m.article_id
      LEFT JOIN friend_applications f ON f.id=n.application_id
      LEFT JOIN friends accepted ON accepted.id=f.friend_id
      WHERE n.id=? AND n.status='pending'`).get(item.id) as Record<string, unknown> | undefined;
      if (!notification) continue;
      const prepared = prepareNotification(notification);
      if (!prepared || prepared.to.some(isNotificationAddressSuppressed)) {
        database.prepare("UPDATE mail_notifications SET status='cancelled',request_payload='' WHERE id=? AND status='pending'").run(notification.id);
        continue;
      }
      const attempts = Number(notification.attempts) + 1;
      const now = new Date().toISOString();
      const payload = String(notification.requestPayload || JSON.stringify({ from: `SamsBlog <${sender}>`,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...prepared }));
      const recipientHash = notificationAddressHash(prepared.to[0]);
      const storedRecipient = JSON.parse(payload) as { to?: unknown };
      if (!Array.isArray(storedRecipient.to) || storedRecipient.to.length !== 1 || notificationAddressHash(String(storedRecipient.to[0])) !== recipientHash) {
        database.prepare("UPDATE mail_notifications SET status='cancelled',request_payload='' WHERE id=? AND status='pending'").run(notification.id);
        continue;
      }
      database.prepare("UPDATE mail_notifications SET request_payload=?,recipient_hash=? WHERE id=? AND status='pending'").run(payload, recipientHash, notification.id);
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
            .run(status, attempts, now, new Date(Date.now() + Math.min(serverConfig.notificationRetryMaximumSeconds, serverConfig.notificationRetrySeconds * 2 ** attempts) * 1000).toISOString(), status === 'pending' ? payload : '', notification.id);
          console.warn('Reply notification provider rejected request', { status: response.status });
          continue;
        }
        const result = await response.json() as { id?: unknown };
        if (typeof result.id !== 'string') throw new Error('Invalid provider response');
        database.prepare("UPDATE mail_notifications SET status='sent',attempts=?,updated_at=?,provider_id=?,request_payload='' WHERE id=? AND status='pending'").run(attempts, now, result.id, notification.id);
      } catch (error) {
        const status = attempts < serverConfig.notificationMaximumAttempts ? 'pending' : 'failed';
        database.prepare("UPDATE mail_notifications SET status=?,attempts=?,updated_at=?,retry_at=?,request_payload=? WHERE id=? AND status='pending'")
          .run(status, attempts, now, new Date(Date.now() + Math.min(serverConfig.notificationRetryMaximumSeconds, serverConfig.notificationRetrySeconds * 2 ** attempts) * 1000).toISOString(), status === 'pending' ? payload : '', notification.id);
        console.warn('Reply notification delivery unavailable', { type: error instanceof Error ? error.name : typeof error });
      }
    }
  } finally {
    running = false;
    if (database.prepare("SELECT 1 FROM mail_notifications WHERE status='pending' LIMIT 1").get()) scheduleReplyNotifications(serverConfig.notificationRetrySeconds * 1000);
  }
}

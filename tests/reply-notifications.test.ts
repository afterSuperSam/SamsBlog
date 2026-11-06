import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

let database: typeof import('../src/lib/db');
let notifications: typeof import('../src/lib/reply-notifications');
beforeAll(async () => {
  vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-mail-')));
  vi.stubEnv('RESEND_API_KEY', 'test-key-never-sent'); vi.stubEnv('MAIL_FROM', 'blog@example.com');
  vi.stubEnv('MAIL_REPLY_TO', 'blog@example.com'); vi.stubEnv('BLOG_SECRET', 'test-notification-secret-at-least-32-characters');
  vi.stubEnv('MAIL_ADMIN_TO', 'owner@example.com');
  vi.useFakeTimers();
  database = await import('../src/lib/db'); notifications = await import('../src/lib/reply-notifications');
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('queues consented replies once, retries with the same key, cancels hidden replies and supports signed opt-out', async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'provider-fixture' }), { status: 200 }));
  vi.stubGlobal('fetch', send);
  const parent = database.createMessage({ nickname: '测试访客', content: '测试留言', email: 'reader@example.com', notifyReply: true, fingerprintHash: 'test' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createAdminReply(parent, '测试回复');
  notifications.queueReplyNotification(parent, reply); notifications.queueReplyNotification(parent, reply);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  expect(notifications.listReplyNotifications()[0].status).toBe('sent');
  const body = JSON.parse(send.mock.calls[0][1].body);
  expect(body.from).toBe('SamsBlog <blog@example.com>'); expect(body.reply_to).toBe('blog@example.com');
  expect(body.html).toContain('测试回复');
  expect(body.html).toContain('alt="SuperSam"');
  expect(body.html).toContain('测试留言');
  expect(body.html).toContain('不再接收此留言的回复通知');
  expect(body.text).toContain('SuperSam回复了你');
  const unsubscribe = new URL(body.text.match(/https?:\/\/\S+\/notifications\?\S+/)[0]);
  expect(() => notifications.cancelReplyNotifications(parent, 'invalid')).toThrow();
  notifications.cancelReplyNotifications(parent, unsubscribe.searchParams.get('token')!);
  expect(database.getDatabase().prepare('SELECT email,notify_reply FROM messages WHERE id=?').get(parent)).toEqual({ email: '', notify_reply: 0 });
  notifications.queueReplyNotification(parent, database.createAdminReply(parent, '退订后的回复'));
  await notifications.deliverReplyNotifications(); expect(send).toHaveBeenCalledTimes(1);

  const second = database.createMessage({ nickname: '另一访客', content: '另一留言', email: 'other@example.com', notifyReply: true, fingerprintHash: 'other' });
  database.updateMessageStatus(second, 'published');
  const hidden = database.createAdminReply(second, '隐藏回复');
  notifications.queueReplyNotification(second, hidden); database.updateMessageStatus(hidden, 'hidden');
  await notifications.deliverReplyNotifications(); expect(send).toHaveBeenCalledTimes(1);
  expect(notifications.listReplyNotifications().find((item) => item.status === 'cancelled')).toBeTruthy();

  const retry = database.createAdminReply(second, '重试回复'); notifications.queueReplyNotification(second, retry);
  send.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await notifications.deliverReplyNotifications();
  const firstKey = send.mock.calls[1][1].headers['Idempotency-Key'];
  database.getDatabase().prepare("UPDATE mail_notifications SET retry_at='' WHERE status='pending'").run();
  send.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'retried-fixture' }), { status: 200 }));
  await notifications.deliverReplyNotifications();
  expect(send.mock.calls[2][1].headers['Idempotency-Key']).toBe(firstKey);
  expect(notifications.listReplyNotifications().some((item) => item.status === 'sent' && item.attempts === 2)).toBe(true);
  warning.mockRestore();
});

it('keeps anonymous article replies private and queues their visitor email only after approval', async () => {
  const { saveArticle } = await import('../src/lib/articles');
  const articleId = saveArticle({ title: '待审回复通知', content: '测试正文', source: 'original', category: 'journal' });
  const parent = database.createMessage({ articleId, nickname: '订阅作者', content: '原评论', email: 'moderation@example.com', notifyReply: true, fingerprintHash: 'moderation-parent' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createMessage({ articleId, parentId: parent, nickname: '匿名回复者', content: '待审核的回复', fingerprintHash: 'moderation-child' });
  const send = vi.fn().mockImplementation(async () => Response.json({ id: 'moderation-fixture' }));
  vi.stubGlobal('fetch', send);
  notifications.queueReplyNotification(parent, reply);
  await notifications.deliverReplyNotifications();
  expect(send).not.toHaveBeenCalled();
  expect(database.listPublishedMessages(60, articleId)[0].replies).toEqual([]);
  database.updateMessageStatus(reply, 'published');
  notifications.queuePublishedThreadReplies(reply);
  notifications.queuePublishedThreadReplies(reply);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  expect(database.listPublishedMessages(60, articleId)[0].replies?.[0].id).toBe(reply);
});

it('escapes untrusted notification text and rejects unsafe or mismatched action addresses', async () => {
  const { createReplyEmail } = await import('../src/lib/reply-email');
  const input = { nickname: '<img src=x onerror=alert(1)>', replyNickname: 'A & B', contextTitle: '<script>title</script>', originalContent: '<img src=x onerror=alert(2)>',
    content: '第一行\r\n<a href="javascript:alert(1)">回复</a>\n最后一行',
    address: 'https://blog.example.com/articles/12#comments', unsubscribe: 'https://blog.example.com/notifications?message=4&token=test' };
  const message = createReplyEmail(input);
  expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(message.html).toContain('A &amp; B');
  expect(message.html).toContain('&lt;script&gt;title&lt;/script&gt;');
  expect(message.html).toContain('第一行<br>&lt;a href=&quot;javascript:alert(1)&quot;&gt;回复&lt;/a&gt;<br>最后一行');
  expect(message.html).not.toMatch(/<script|onerror="|href="javascript:|<img src=x/);
  expect(message.html).toContain('href="https://blog.example.com/notifications?message=4&amp;token=test"');
  expect(message.text).toContain(input.content);
  expect(() => createReplyEmail({ ...input, address: 'javascript:alert(1)' })).toThrow('Invalid reply email address');
  expect(() => createReplyEmail({ ...input, unsubscribe: 'https://other.example.com/notifications' })).toThrow('Invalid reply email address');
});

it('uses published templates without mixing HTML and falls back safely when escaped variables exceed the provider limit', async () => {
  const { createReplyEmail } = await import('../src/lib/reply-email');
  const input = { nickname: '测试访客', replyNickname: 'Sam', isOwnerReply: true, contextTitle: '文章', originalContent: '原留言', content: '<b>不执行 HTML</b>',
    address: 'https://blog.example.com/articles/1#comments', unsubscribe: 'https://blog.example.com/notifications?message=1&token=test' };
  const template = createReplyEmail(input, 'samsblog-reply-v1');
  expect(template).not.toHaveProperty('html'); expect(template).not.toHaveProperty('text');
  expect(template.template?.variables.CONTENT_HTML).toBe('&lt;b&gt;不执行 HTML&lt;/b&gt;');
  expect(template.template?.variables.ORIGINAL_TEXT).toBe('原留言');
  const escaped = createReplyEmail({ ...input, originalContent: '"'.repeat(500) }, 'samsblog-reply-v1');
  expect(escaped).not.toHaveProperty('template');
  expect(escaped.html).toContain('&quot;'.repeat(500));
});

it('queues owner alerts once and keeps them independent of visitor opt-out while excluding administrative replies', async () => {
  const parent = database.createMessage({ nickname: '站长提醒', content: '新留言', email: 'visitor@example.com', notifyReply: true, fingerprintHash: 'owner-alert' });
  notifications.queueAdminNotification('message', parent); notifications.queueAdminNotification('message', parent);
  const ownReply = database.createAdminReply(parent, '后台回复');
  notifications.queueAdminNotification('message', ownReply);
  const token = createHmac('sha256', 'test-notification-secret-at-least-32-characters').update(`reply-notification:${parent}`).digest('hex');
  notifications.cancelReplyNotifications(parent, token);
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'owner-alert-fixture' })));
  vi.stubGlobal('fetch', send);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse(send.mock.calls[0][1].body);
  expect(body.to).toEqual(['owner@example.com']);
  expect(body.subject).toContain('留言纸条');
  expect(body.html).toContain('/admin/messages');
  expect(body.html).not.toContain('notifications?message=');
});

it('cancels owner alerts when a submission is hidden or a friend application is already processed', async () => {
  const { createFriendApplication, parseFriendInput, reviewFriendApplication } = await import('../src/lib/friends');
  const first = database.createMessage({ nickname: '隐藏提醒', content: '不再提醒', fingerprintHash: 'hidden-alert' });
  notifications.queueAdminNotification('message', first); database.updateMessageStatus(first, 'hidden');
  const application = createFriendApplication(parseFriendInput({ name: '测试网站', url: 'https://alert.example.com', description: '友链申请', iconUrl: 'https://example.com/icon.png', rssUrl: '', backgroundUrl: '', visible: false }), 'friend@example.com', 'friend-alert');
  notifications.queueAdminNotification('application', application); notifications.queueAdminNotification('application', application);
  reviewFriendApplication(application, false, {});
  const pending = createFriendApplication(parseFriendInput({ name: '等待审核', url: 'https://pending.example.com', description: '新友链申请', iconUrl: 'https://example.com/icon.png', rssUrl: '', backgroundUrl: '', visible: false }), 'friend@example.com', 'friend-alert-pending');
  notifications.queueAdminNotification('application', pending);
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'friend-alert-fixture' })));
  vi.stubGlobal('fetch', send); await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse(send.mock.calls[0][1].body);
  expect(body.to).toEqual(['owner@example.com']); expect(body.subject).toContain('友链申请');
  expect(body.text).toContain('https://pending.example.com');
  expect(body.html).toContain('/admin/applications');
});

it('rechecks consent and visibility for each queued message after an earlier delivery waits', async () => {
  const parents = ['等待发送', '等待退订', '等待隐藏'].map((nickname, index) => {
    const parent = database.createMessage({ nickname, content: '测试留言', email: `reader-${index}@example.com`, notifyReply: true, fingerprintHash: `batch-${index}` });
    database.updateMessageStatus(parent, 'published');
    const reply = database.createAdminReply(parent, '测试回复');
    notifications.queueReplyNotification(parent, reply);
    return { parent, reply };
  });
  let release!: (response: Response) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockResolvedValue(new Response(JSON.stringify({ id: 'unexpected-fixture' })));
  vi.stubGlobal('fetch', send);
  const delivery = notifications.deliverReplyNotifications();
  await Promise.resolve();
  const token = createHmac('sha256', 'test-notification-secret-at-least-32-characters').update(`reply-notification:${parents[1].parent}`).digest('hex');
  notifications.cancelReplyNotifications(parents[1].parent, token);
  database.updateMessageStatus(parents[2].reply, 'hidden');
  release(new Response(JSON.stringify({ id: 'first-fixture' })));
  await delivery;
  expect(send).toHaveBeenCalledTimes(1);
  const queued = database.getDatabase().prepare('SELECT status FROM mail_notifications WHERE message_id=?').get(parents[1].parent);
  expect(queued).toEqual({ status: 'cancelled' });
});

it('sends existing public replies after a pending guestbook thread becomes public without queueing twice', async () => {
  const { createAdminSession } = await import('../src/lib/admin-auth');
  const { POST, PATCH } = await import('../src/pages/api/admin/messages.json');
  const call = async (handler: typeof POST, method: string, body: Record<string, unknown>) => handler({
    request: new Request('https://blog.example.com/api/admin/messages.json', {
      method, headers: { 'Content-Type': 'application/json', Origin: 'https://blog.example.com' }, body: JSON.stringify(body),
    }), cookies: { get: () => ({ value: createAdminSession() }) },
  } as unknown as Parameters<typeof POST>[0]);
  const parent = database.createMessage({ nickname: '待审核访客', content: '等待公开的留言', email: 'pending@example.com', notifyReply: true, fingerprintHash: 'pending-thread' });
  expect((await call(POST, 'POST', { parentId: parent, content: '审核前的回复' })).status).toBe(201);
  expect((await call(PATCH, 'PATCH', { id: parent, status: 'published' })).status).toBe(200);
  expect((await call(PATCH, 'PATCH', { id: parent, status: 'published' })).status).toBe(200);
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'published-fixture' })));
  vi.stubGlobal('fetch', send);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][1].body).to).toEqual(['pending@example.com']);
});

it('keeps the same persisted provider payload across retries when the article title changes', async () => {
  const { saveArticle } = await import('../src/lib/articles');
  const articleId = saveArticle({ title: '原题目', content: '测试正文', source: 'original', category: 'journal' });
  const parent = database.createMessage({ articleId, nickname: '文章访客', content: '评论内容', email: 'article@example.com', notifyReply: true, fingerprintHash: 'article-notification' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createAdminReply(parent, '文章回复');
  notifications.queueReplyNotification(parent, reply);
  const send = vi.fn().mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'stable-payload-fixture' })));
  vi.stubGlobal('fetch', send);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await notifications.deliverReplyNotifications();
  saveArticle({ id: articleId, title: '更改后的题目', content: '测试正文', source: 'original', category: 'journal' });
  database.getDatabase().prepare("UPDATE mail_notifications SET retry_at='' WHERE status='pending'").run();
  await notifications.deliverReplyNotifications();
  expect(send.mock.calls[1][1].body).toBe(send.mock.calls[0][1].body);
  expect(database.getDatabase().prepare('SELECT request_payload AS payload FROM mail_notifications WHERE reply_id=?').get(reply)).toEqual({ payload: '' });
  warning.mockRestore();
});

it('preserves cancellation while an already-started provider request completes and removes its snapshot', async () => {
  const parent = database.createMessage({ nickname: '正在退订', content: '测试留言', email: 'inflight@example.com', notifyReply: true, fingerprintHash: 'inflight' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createAdminReply(parent, '已发起的回复');
  notifications.queueReplyNotification(parent, reply);
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
  const delivery = notifications.deliverReplyNotifications();
  await Promise.resolve();
  expect(database.getDatabase().prepare('SELECT request_payload FROM mail_notifications WHERE reply_id=?').get(reply)).toMatchObject({ request_payload: expect.stringContaining('inflight@example.com') });
  const token = createHmac('sha256', 'test-notification-secret-at-least-32-characters').update(`reply-notification:${parent}`).digest('hex');
  notifications.cancelReplyNotifications(parent, token);
  release(new Response(JSON.stringify({ id: 'already-started-fixture' })));
  await delivery;
  expect(database.getDatabase().prepare('SELECT status,request_payload FROM mail_notifications WHERE reply_id=?').get(reply)).toEqual({ status: 'cancelled', request_payload: '' });
});

it('clears snapshots on permanent failure and expiry instead of retaining notification addresses', async () => {
  const parent = database.createMessage({ nickname: '失败队列', content: '测试留言', email: 'failure@example.com', notifyReply: true, fingerprintHash: 'failure' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createAdminReply(parent, '失败回复');
  notifications.queueReplyNotification(parent, reply);
  const expired = database.createAdminReply(parent, '过期回复');
  notifications.queueReplyNotification(parent, expired);
  database.getDatabase().prepare("UPDATE mail_notifications SET request_payload=?,created_at='2000-01-01T00:00:00.000Z' WHERE reply_id=?").run('{"to":["failure@example.com"]}', expired);
  const send = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', send);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  expect(database.getDatabase().prepare('SELECT status,request_payload FROM mail_notifications WHERE reply_id IN (?,?)').all(reply, expired))
    .toEqual([{ status: 'failed', request_payload: '' }, { status: 'failed', request_payload: '' }]);
  warning.mockRestore();
});

it('queues acceptance receipts once only for approved applications with an email and renders safe public links', async () => {
  const friends = await import('../src/lib/friends');
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'acceptance-fixture' })));
  vi.stubGlobal('fetch', send);
  const create = (suffix: string, email: string) => friends.createFriendApplication(friends.parseFriendInput({
    name: '<img src=x onerror=alert(1)> & 站点', url: `https://receipt-${suffix}.example.com`, description: '友链申请', iconUrl: 'https://example.com/icon.png',
  }), email, `receipt-${suffix}`);
  const id = create('approved', 'applicant@example.com');
  friends.reviewFriendApplication(id, true, {});
  expect(send).not.toHaveBeenCalled();
  expect(() => friends.reviewFriendApplication(id, true, {})).toThrow('已经处理');
  expect(notifications.queueAcceptedFriendApplication(id)).toBe(false);
  const declined = create('declined', 'declined@example.com');
  friends.reviewFriendApplication(declined, false, {});
  const empty = create('empty', '');
  friends.reviewFriendApplication(empty, true, {});
  expect(database.getDatabase().prepare("SELECT application_id FROM mail_notifications WHERE kind='application_accepted'").all()).toEqual([{ application_id: id }]);
  const application = database.getDatabase().prepare('SELECT friend_id FROM friend_applications WHERE id=?').get(id) as { friend_id: number };
  expect(friends.listFriends().find((friend) => friend.id === application.friend_id)?.name).toContain('& 站点');
  expect(JSON.stringify(friends.listFriends())).not.toContain('applicant@example.com');
  expect(JSON.stringify(notifications.listReplyNotifications())).not.toContain('applicant@example.com');
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse(send.mock.calls[0][1].body);
  expect(body.to).toEqual(['applicant@example.com']);
  expect(body.subject).toContain('友链申请已通过');
  expect(body.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; 站点');
  expect(body.html).toContain('查看网站友链');
  expect(body.html).toContain('/about#friends');
  expect(body.text).toContain('查看网站友链：');
  expect(body.html).not.toMatch(/<img src=x|前往后台处理|\/admin\//);
  expect(body).not.toHaveProperty('template');
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
});

it('rolls back approval and its new friend if acceptance queue insertion fails', async () => {
  const friends = await import('../src/lib/friends');
  const id = friends.createFriendApplication(friends.parseFriendInput({ name: '原子审核', url: 'https://receipt-atomic.example.com', description: '原子入队', iconUrl: 'https://example.com/icon.png' }), 'atomic@example.com', 'receipt-atomic');
  const connection = database.getDatabase();
  connection.exec("CREATE TRIGGER reject_acceptance_receipt BEFORE INSERT ON mail_notifications WHEN NEW.kind='application_accepted' BEGIN SELECT RAISE(ABORT,'receipt fixture failure'); END");
  try {
    expect(() => friends.reviewFriendApplication(id, true, {})).toThrow('receipt fixture failure');
    expect(connection.prepare('SELECT status,friend_id FROM friend_applications WHERE id=?').get(id)).toEqual({ status: 'pending', friend_id: null });
    expect(friends.listFriends().some((friend) => friend.url === 'https://receipt-atomic.example.com/')).toBe(false);
  } finally { connection.exec('DROP TRIGGER reject_acceptance_receipt'); }
});

it('cancels receipts for deleted applications and hidden or replaced friends using the original friend ID', async () => {
  const friends = await import('../src/lib/friends');
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  const connection = database.getDatabase();
  for (const mode of ['hidden', 'replaced', 'deleted-application']) {
    const input = friends.parseFriendInput({ name: `失效回信${mode}`, url: `https://receipt-${mode}.example.com`, description: '取消验证', iconUrl: 'https://example.com/icon.png' });
    const id = friends.createFriendApplication(input, 'cancelled@example.com', `receipt-${mode}`);
    friends.reviewFriendApplication(id, true, {});
    const { friend_id: friendId } = connection.prepare('SELECT friend_id FROM friend_applications WHERE id=?').get(id) as { friend_id: number };
    if (mode === 'hidden') connection.prepare('UPDATE friends SET visible=0 WHERE id=?').run(friendId);
    else if (mode === 'replaced') { friends.deleteFriend(friendId); friends.saveFriend(input); }
    else connection.prepare('UPDATE friend_applications SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
    await notifications.deliverReplyNotifications();
    expect(connection.prepare("SELECT status,request_payload FROM mail_notifications WHERE kind='application_accepted' AND application_id=?").get(id))
      .toEqual({ status: 'cancelled', request_payload: '' });
  }
  expect(send).not.toHaveBeenCalled();
});

it('sends acceptance receipts without an admin address and retries the exact snapshot without reverting approval', async () => {
  vi.stubEnv('MAIL_ADMIN_TO', '');
  vi.resetModules();
  const isolatedDatabase = (await import('../src/lib/db')).getDatabase();
  const isolatedNotifications = await import('../src/lib/reply-notifications');
  const friends = await import('../src/lib/friends');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const send = vi.fn().mockRejectedValueOnce(new TypeError('fixture network failure')).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'receipt-retry' })));
  vi.stubGlobal('fetch', send);
  try {
    expect(isolatedNotifications.adminNotificationsConfigured).toBe(false);
    const id = friends.createFriendApplication(friends.parseFriendInput({ name: '重试回信', url: 'https://receipt-retry.example.com', description: '邮件失败不影响审核', iconUrl: 'https://example.com/icon.png' }), 'retry-receipt@example.com', 'receipt-retry');
    friends.reviewFriendApplication(id, true, {});
    await isolatedNotifications.deliverReplyNotifications();
    expect(isolatedDatabase.prepare('SELECT status FROM friend_applications WHERE id=?').get(id)).toEqual({ status: 'accepted' });
    const first = send.mock.calls[0][1];
    expect(first.headers['Idempotency-Key']).toContain('application_accepted');
    isolatedDatabase.prepare('UPDATE friends SET name=? WHERE id=(SELECT friend_id FROM friend_applications WHERE id=?)').run('发送后的改名', id);
    isolatedDatabase.prepare("UPDATE mail_notifications SET retry_at='' WHERE kind='application_accepted' AND application_id=?").run(id);
    await isolatedNotifications.deliverReplyNotifications();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].body).toBe(first.body);
    expect(send.mock.calls[1][1].headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
    expect(isolatedDatabase.prepare("SELECT status,attempts,request_payload FROM mail_notifications WHERE kind='application_accepted' AND application_id=?").get(id))
      .toEqual({ status: 'sent', attempts: 2, request_payload: '' });
  } finally {
    isolatedDatabase.close();
    vi.stubEnv('MAIL_ADMIN_TO', 'owner@example.com');
    vi.resetModules();
    warning.mockRestore();
  }
});

it('migrates the previous reply queue without changing delivery identity or retry snapshots', async () => {
  const parent = database.createMessage({ nickname: '迁移测试', content: '旧留言', fingerprintHash: 'migration' });
  const reply = database.createAdminReply(parent, '旧回复');
  const connection = database.getDatabase();
  connection.exec(`CREATE TABLE reply_notifications (
    id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, reply_id INTEGER NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    retry_at TEXT NOT NULL, provider_id TEXT NOT NULL, request_payload TEXT NOT NULL
  )`);
  const legacy = { id: 777, message_id: parent, reply_id: reply, status: 'pending', attempts: 2,
    created_at: '2026-10-25T00:00:00.000Z', updated_at: '2026-10-25T00:05:00.000Z',
    retry_at: '2026-10-25T00:10:00.000Z', provider_id: 'migration-fixture', request_payload: '{"subject":"旧的请求正文"}' };
  connection.prepare('INSERT INTO reply_notifications VALUES (@id,@message_id,@reply_id,@status,@attempts,@created_at,@updated_at,@retry_at,@provider_id,@request_payload)').run(legacy);
  connection.exec("DROP TABLE mail_notifications; DELETE FROM schema_migrations WHERE id IN ('20261025-mail-notification-outbox','20261107-friend-application-receipt')");
  connection.close();
  vi.resetModules();
  const migrated = (await import('../src/lib/db')).getDatabase();
  expect(migrated.prepare('SELECT * FROM mail_notifications WHERE id=777').get()).toEqual({ ...legacy, kind: 'reply', application_id: null });
  expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name='reply_notifications'").get()).toBeUndefined();
  expect(() => migrated.prepare("INSERT INTO mail_notifications(kind,created_at,updated_at) VALUES ('application','','')").run()).toThrow();
  migrated.close();
});

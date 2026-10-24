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
  database.getDatabase().prepare("UPDATE reply_notifications SET retry_at='' WHERE status='pending'").run();
  send.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'retried-fixture' }), { status: 200 }));
  await notifications.deliverReplyNotifications();
  expect(send.mock.calls[2][1].headers['Idempotency-Key']).toBe(firstKey);
  expect(notifications.listReplyNotifications().some((item) => item.status === 'sent' && item.attempts === 2)).toBe(true);
  warning.mockRestore();
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
  const queued = database.getDatabase().prepare('SELECT status FROM reply_notifications WHERE message_id=?').get(parents[1].parent);
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
  const reply = database.createAdminReply(parent, '文章回复');
  notifications.queueReplyNotification(parent, reply);
  const send = vi.fn().mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'stable-payload-fixture' })));
  vi.stubGlobal('fetch', send);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await notifications.deliverReplyNotifications();
  saveArticle({ id: articleId, title: '更改后的题目', content: '测试正文', source: 'original', category: 'journal' });
  database.getDatabase().prepare("UPDATE reply_notifications SET retry_at='' WHERE status='pending'").run();
  await notifications.deliverReplyNotifications();
  expect(send.mock.calls[1][1].body).toBe(send.mock.calls[0][1].body);
  expect(database.getDatabase().prepare('SELECT request_payload AS payload FROM reply_notifications WHERE reply_id=?').get(reply)).toEqual({ payload: '' });
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
  expect(database.getDatabase().prepare('SELECT request_payload FROM reply_notifications WHERE reply_id=?').get(reply)).toMatchObject({ request_payload: expect.stringContaining('inflight@example.com') });
  const token = createHmac('sha256', 'test-notification-secret-at-least-32-characters').update(`reply-notification:${parent}`).digest('hex');
  notifications.cancelReplyNotifications(parent, token);
  release(new Response(JSON.stringify({ id: 'already-started-fixture' })));
  await delivery;
  expect(database.getDatabase().prepare('SELECT status,request_payload FROM reply_notifications WHERE reply_id=?').get(reply)).toEqual({ status: 'cancelled', request_payload: '' });
});

it('clears snapshots on permanent failure and expiry instead of retaining notification addresses', async () => {
  const parent = database.createMessage({ nickname: '失败队列', content: '测试留言', email: 'failure@example.com', notifyReply: true, fingerprintHash: 'failure' });
  database.updateMessageStatus(parent, 'published');
  const reply = database.createAdminReply(parent, '失败回复');
  notifications.queueReplyNotification(parent, reply);
  const expired = database.createAdminReply(parent, '过期回复');
  notifications.queueReplyNotification(parent, expired);
  database.getDatabase().prepare("UPDATE reply_notifications SET request_payload=?,created_at='2000-01-01T00:00:00.000Z' WHERE reply_id=?").run('{"to":["failure@example.com"]}', expired);
  const send = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', send);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await notifications.deliverReplyNotifications();
  expect(send).toHaveBeenCalledTimes(1);
  expect(database.getDatabase().prepare('SELECT status,request_payload FROM reply_notifications WHERE reply_id IN (?,?)').all(reply, expired))
    .toEqual([{ status: 'failed', request_payload: '' }, { status: 'failed', request_payload: '' }]);
  warning.mockRestore();
});

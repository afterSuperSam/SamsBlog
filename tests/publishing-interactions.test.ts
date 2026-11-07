import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import { getDatabase, createMessage as createStoredMessage, createAdminReply, deleteMessage, listPublishedMessages, listAllMessages, updateMessageStatus } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { recordPageView, getArticleAnalytics, hashVisitorToken } from '../src/lib/stats';
import { adminCookie, createAdminSession } from '../src/lib/admin-auth';
import { listFriends, listFriendApplications, reviewFriendApplication } from '../src/lib/friends';
import { POST as postComment, GET as getComments } from '../src/pages/api/guestbook/messages.json';
import { POST as react } from '../src/pages/api/articles/reactions.json';
import { POST as apply } from '../src/pages/api/friends/applications.json';
import { PATCH as review } from '../src/pages/api/admin/applications.json';
import { parseVisitorProfile } from '../src/lib/visitor-profile';
import { siteConfig } from '../src/config/site';
import { serverConfig } from '../src/config/server';
import { initializeCommentDraft } from '../src/lib/comment-drafts';

vi.mock('../src/lib/reply-notifications', async (original) => ({ ...await original<object>(), replyNotificationsConfigured: false, queueReplyNotification: vi.fn() }));
const readerSession = vi.hoisted(() => ({ value: null as { id: number; displayName: string; avatarUrl: null } | null }));
vi.mock('../src/lib/readers', () => ({ readReaderSession: () => readerSession.value }));
function createPublishedMessage(input: Parameters<typeof createStoredMessage>[0]) {
  const id = createStoredMessage(input); updateMessageStatus(id, 'published'); return id;
}
beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-publishing-'))); });
afterEach(() => { vi.unstubAllGlobals(); });
const content = { title: '互动验证', content: '正文', source: 'original', category: 'journal' };
let sequence = 0;
async function call(handler: APIRoute, route: string, body?: unknown, token = '11111111-1111-4111-8111-111111111111', method = 'POST', origin = 'https://blog.example.com', clientAddress = `203.0.113.${++sequence}`) {
  return await handler({ url: new URL(route, 'https://blog.example.com'),
    request: new Request(new URL(route, 'https://blog.example.com'), { method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(handler === postComment && body && typeof body === 'object' ? { operationId: randomUUID(), ...body } : body) }) }),
    clientAddress,
    cookies: { get: (name: string) => ({ value: name === adminCookie.name ? createAdminSession() : token }), set: vi.fn() },
  } as unknown as APIContext) as Response;
}

describe('public submission quotas', () => {
  const submit = (handler: APIRoute, route: string, body: unknown, clientAddress = '198.51.100.1') =>
    call(handler, route, body, undefined, 'POST', undefined, clientAddress);

  it('replays a lost-response submission after another tab edits the draft and the original tab refreshes', async () => {
    const createStorage = () => {
      const values = new Map<string, string>();
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    };
    const firstSession = createStorage(); const secondSession = createStorage();
    vi.stubGlobal('localStorage', createStorage()); vi.stubGlobal('sessionStorage', firstSession);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, createElement: () => ({ className: '', textContent: '', setAttribute() {}, remove() {} }) }));
    const field = () => Object.assign(new EventTarget(), { value: '', closest: () => ({ after() {} }) }) as unknown as HTMLTextAreaElement;
    const firstField = field(); let firstTab = initializeCommentDraft(firstField, 'guestbook', null);
    const body = { nickname: '跨标签访客', content: '同一份丢失响应的提交', notifyReply: false };
    firstField.value = body.content; firstField.dispatchEvent(new Event('input'));
    const original = await firstTab.captureSubmission(body);
    const first = await submit(postComment, '/api/guestbook/messages.json', { ...body, operationId: original.operationId, submissionIdentity: 'anonymous' }, '198.51.100.245');
    expect(first.status).toBe(201); const accepted = await first.json();
    vi.stubGlobal('sessionStorage', secondSession);
    const secondField = field(); const secondTab = initializeCommentDraft(secondField, 'guestbook', null);
    secondField.value = '另一个标签正在写的新正文'; secondField.dispatchEvent(new Event('input')); secondTab.destroy();
    vi.stubGlobal('sessionStorage', firstSession);
    firstTab.destroy(); firstTab = initializeCommentDraft(firstField, 'guestbook', null);
    const retry = await firstTab.captureSubmission(body);
    const replayed = await submit(postComment, '/api/guestbook/messages.json', { ...body, operationId: retry.operationId, submissionIdentity: 'anonymous' }, '198.51.100.245');
    expect(replayed.status).toBe(201); expect(await replayed.json()).toEqual(accepted);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM messages WHERE content=?').get(body.content)).toEqual({ count: 1 });
    expect(retry.operationId).toBe(original.operationId);
    firstTab.destroy();
  });

  it.each(['draft', 'pending'])('keeps the selected operation through partial %s storage failure and a refreshed API retry', async (failure) => {
    const local = new Map<string, string>(); const session = new Map<string, string>(); let draftWrites = 0;
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => {
      if (failure === 'draft' && ++draftWrites >= 3) throw new DOMException('Full', 'QuotaExceededError');
      local.set(key, value);
    } });
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => {
      if (failure === 'pending' && key.endsWith(':pending')) throw new DOMException('Full', 'QuotaExceededError');
      session.set(key, value);
    } });
    vi.stubGlobal('console', { ...console, warn: vi.fn() }); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, createElement: () => ({ className: '', textContent: '', setAttribute() {}, remove() {} }) }));
    const field = Object.assign(new EventTarget(), { value: '', closest: () => ({ after() {} }) }) as unknown as HTMLTextAreaElement;
    let draft = initializeCommentDraft(field, 'guestbook', null);
    const body = { nickname: '部分写入访客', content: `部分${failure}存储失败后重试`, notifyReply: false };
    field.value = body.content; field.dispatchEvent(new Event('input'));
    const original = await draft.captureSubmission(body);
    const source = failure === 'draft' ? '198.51.100.246' : '198.51.100.247';
    const first = await submit(postComment, '/api/guestbook/messages.json', { ...body, operationId: original.operationId, submissionIdentity: 'anonymous' }, source);
    expect(first.status).toBe(201); const accepted = await first.json();
    expect((await draft.captureSubmission(body)).operationId).toBe(original.operationId);
    draft.destroy(); draft = initializeCommentDraft(field, 'guestbook', null);
    field.value = body.content; field.dispatchEvent(new Event('input'));
    const retry = await draft.captureSubmission(body);
    const replayed = await submit(postComment, '/api/guestbook/messages.json', { ...body, operationId: retry.operationId, submissionIdentity: 'anonymous' }, source);
    expect(replayed.status).toBe(201); expect(await replayed.json()).toEqual(accepted);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM messages WHERE content=?').get(body.content)).toEqual({ count: 1 });
    expect(retry.operationId).toBe(original.operationId);
    if (failure === 'draft') expect(JSON.parse(session.get(`${siteConfig.commentDrafts.storageKey}:pending`) || '{}')[`${original.key}/${original.requestHash}`].operationId).toBe(original.operationId);
    draft.destroy();
  });

  it('replays the original response without a second message or quota charge and rejects changed reuse', async () => {
    const operationId = randomUUID();
    const message = { operationId, nickname: '幂等访客', content: '响应丢失后重试' };
    expect((await submit(postComment, '/api/guestbook/messages.json', { ...message, submissionIdentity: 'reader:999' }, '198.51.100.210')).status).toBe(409);
    const first = await submit(postComment, '/api/guestbook/messages.json', message, '198.51.100.211');
    const original = await first.json(); expect(first.status).toBe(201);
    await submit(postComment, '/api/guestbook/messages.json', { ...message, operationId: randomUUID(), content: '用完第二次额度' }, '198.51.100.211');
    const replay = await submit(postComment, '/api/guestbook/messages.json', message, '198.51.100.211');
    expect(replay.status).toBe(201); expect(await replay.json()).toEqual(original);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM messages WHERE content=?').get(message.content)).toEqual({ count: 1 });
    expect((await submit(postComment, '/api/guestbook/messages.json', { ...message, content: '同编号不同正文' }, '198.51.100.211')).status).toBe(409);
    const anotherIdentity = await call(postComment, '/api/guestbook/messages.json', message, randomUUID(), 'POST', undefined, '198.51.100.212');
    expect(anotherIdentity.status).toBe(201); expect((await anotherIdentity.json()).id).not.toBe(original.id);
  });

  it('rolls back the message, notification and operation result together on failure', async () => {
    const { completeCommentOperation } = await import('../src/lib/comment-submissions');
    const operationId = randomUUID();
    expect(() => completeCommentOperation('reader:rollback', operationId, { content: '回滚提交' }, () => {
      const id = createStoredMessage({ nickname: '事务测试', content: '回滚提交', fingerprintHash: 'rollback-submission' });
      getDatabase().prepare("INSERT INTO mail_notifications(kind,message_id,created_at,updated_at) VALUES('message',?,?,?)").run(id, new Date().toISOString(), new Date().toISOString());
      throw new Error('submission fixture failure');
    })).toThrow('submission fixture failure');
    expect(getDatabase().prepare('SELECT 1 FROM messages WHERE fingerprint_hash=?').get('rollback-submission')).toBeUndefined();
    expect(getDatabase().prepare('SELECT 1 FROM message_submissions WHERE operation_id=?').get(operationId)).toBeUndefined();
  });

  it('shares a request quota across public write endpoints before invalid input can reach storage', async () => {
    const source = '198.51.100.200';
    for (let index = 0; index < serverConfig.publicActivityLimit; index++) {
      const handler = index % 2 ? apply : postComment;
      const route = index % 2 ? '/api/friends/applications.json' : '/api/guestbook/messages.json';
      expect((await submit(handler, route, {}, source)).status).toBe(400);
    }
    expect((await submit(postComment, '/api/guestbook/messages.json', {}, source)).status).toBe(429);
    expect((await submit(apply, '/api/friends/applications.json', {}, source)).status).toBe(429);
  });

  it('shares a rolling quota between guestbook messages and article comments', async () => {
    const articleId = saveArticle({ ...content, title: '留言限流验证' });
    const route = '/api/guestbook/messages.json';
    const message = { nickname: '限流验证', content: '只写临时测试库' };
    const first = await submit(postComment, route, message);
    expect(first.status).toBe(201);
    expect((await submit(postComment, route, { ...message, articleId })).status).toBe(201);
    expect((await submit(postComment, route, message)).status).toBe(429);
    expect((await submit(postComment, route, message, '198.51.100.2')).status).toBe(201);
    const { id } = await first.json();
    getDatabase().prepare("UPDATE messages SET created_at=datetime('now','-61 seconds') WHERE id=?").run(id);
    expect((await submit(postComment, route, message)).status).toBe(201);
  });

  it('allows two friend applications per source and releases a slot after one hour', async () => {
    const route = '/api/friends/applications.json';
    const application = (number: number) => ({
      name: '限流验证', description: '只写临时测试库', url: `https://quota-${number}.example.com/`,
      iconUrl: 'https://assets.example.com/icon.png', rssUrl: '',
    });
    expect((await submit(apply, route, application(1))).status).toBe(201);
    expect((await submit(apply, route, application(2))).status).toBe(201);
    expect((await submit(apply, route, application(3))).status).toBe(429);
    expect((await submit(apply, route, application(4), '198.51.100.2')).status).toBe(201);
    getDatabase().prepare('UPDATE friend_applications SET created_at=? WHERE url=?')
      .run(new Date(Date.now() - 3601000).toISOString(), application(1).url);
    expect((await submit(apply, route, application(3))).status).toBe(201);
  });
});

describe('article conversation boundaries', () => {
  it('uses only the verified reader session for publication and keeps pending parents private', async () => {
    const articleId = saveArticle(content);
    const parentId = createPublishedMessage({ articleId, nickname: '公开父帖', content: '公开内容', fingerprintHash: 'reader-parent' });
    const guestParent = createPublishedMessage({ nickname: '公开留言', content: '公开内容', fingerprintHash: 'reader-guest-parent' });
    const readerId = Number(getDatabase().prepare('INSERT INTO readers(display_name,created_at,updated_at) VALUES (?,?,?)').run('可信读者', new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    const { queueReplyNotification } = await import('../src/lib/reply-notifications');
    vi.mocked(queueReplyNotification).mockClear();
    for (const scope of [{}, { parentId: guestParent }, { articleId }, { articleId, parentId }]) {
      const response = await call(postComment, '/api/guestbook/messages.json', { ...scope, nickname: '匿名访客', content: '待审内容', readerId, status: 'published', isAdmin: true });
      const result = await response.json();
      expect(result.status).toBe('pending');
      expect(getDatabase().prepare('SELECT status,reader_id,nickname FROM messages WHERE id=?').get(result.id)).toEqual({ status: 'pending', reader_id: null, nickname: '匿名访客' });
    }
    expect(queueReplyNotification).not.toHaveBeenCalled();
    readerSession.value = { id: readerId, displayName: '可信读者', avatarUrl: null };
    try {
      for (const scope of [{}, { parentId: guestParent }, { articleId }, { articleId, parentId }]) {
        const response = await call(postComment, '/api/guestbook/messages.json', { ...scope, nickname: '伪造作者', content: '登录读者内容', readerId: 999999 });
        const result = await response.json();
        expect(result.status).toBe('published');
        expect(getDatabase().prepare('SELECT status,reader_id,nickname FROM messages WHERE id=?').get(result.id)).toEqual({ status: 'published', reader_id: readerId, nickname: '可信读者' });
      }
      for (const status of ['pending', 'hidden'] as const) {
        updateMessageStatus(parentId, status);
        expect((await call(postComment, '/api/guestbook/messages.json', { articleId, parentId, content: '不能公开父帖' })).status).toBe(404);
        expect(listPublishedMessages(60, articleId).some((message) => message.id === parentId)).toBe(false);
      }
      const output = JSON.stringify(listPublishedMessages());
      expect(output).not.toMatch(/reader_id|readerId|email|fingerprint/);
    } finally { readerSession.value = null; }
  });

  it('holds anonymous article comments for moderation and never exposes contact details', async () => {
    const articleId = saveArticle(content);
    const response = await call(postComment, '/api/guestbook/messages.json', { articleId, nickname: '测试访客', content: '直接公开的评论', email: 'reader@example.com' });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(listPublishedMessages(60, articleId).map((message) => message.id)).not.toContain(id);
    expect(listAllMessages().find((message) => message.id === id)?.status).toBe('pending');
    expect(listPublishedMessages().some((message) => message.id === id)).toBe(false);
    const publicResponse = await call(getComments, `/api/guestbook/messages.json?articleId=${articleId}`, undefined, undefined, 'GET');
    const serialized = await publicResponse.text();
    expect(serialized).not.toContain('reader@example.com'); expect(serialized).not.toContain('fingerprint');
    const guest = createStoredMessage({ nickname: '纸条访客', content: '需要审核的留言', fingerprintHash: 'test-guest' });
    expect(listPublishedMessages().some((message) => message.id === guest)).toBe(false);
    expect(listAllMessages().find((message) => message.id === guest)?.status).toBe('pending');
    expect(getDatabase().prepare('SELECT email,notify_reply FROM messages WHERE id=?').get(id)).toEqual({ email: '', notify_reply: 0 });
  });
  it('rejects cross-article, nested and hidden replies and hides discussion when an article is withdrawn', async () => {
    const first = saveArticle(content); const second = saveArticle(content);
    const parent = createPublishedMessage({ articleId: first, nickname: '测试访客', content: '原评论', fingerprintHash: 'a' });
    expect((await call(postComment, '/api/guestbook/messages.json', { articleId: second, parentId: parent, nickname: '另一访客', content: '越界回复' })).status).toBe(404);
    const child = createPublishedMessage({ articleId: first, parentId: parent, nickname: '另一访客', content: '合法回复', fingerprintHash: 'b' });
    expect(() => createPublishedMessage({ articleId: first, parentId: child, nickname: '另一访客', content: '嵌套回复', fingerprintHash: 'c' })).toThrow();
    updateMessageStatus(parent, 'hidden');
    expect(listPublishedMessages(60, first)).toEqual([]);
    expect(() => createPublishedMessage({ articleId: first, parentId: parent, nickname: '另一访客', content: '隐藏回复', fingerprintHash: 'd' })).toThrow();
    withdrawArticle(first);
    expect((await call(getComments, `/api/guestbook/messages.json?articleId=${first}`, undefined, undefined, 'GET')).status).toBe(404);
    expect(listAllMessages().some((message) => message.id === parent)).toBe(true);
    expect((await call(postComment, '/api/guestbook/messages.json', { articleId: second, nickname: '访客', content: '测试' }, undefined, 'POST', 'https://other.example')).status).toBe(403);
  });
  it('quotes exact root or reply text without changing the root thread or trusting an owner nickname', async () => {
    const articleId = saveArticle(content);
    const parentId = createPublishedMessage({ articleId, nickname: '原作者', content: '评论原文中的连续片段。', fingerprintHash: 'quote-root' });
    const ownerReply = createAdminReply(parentId, '站长回复中的原话');
    const response = await call(postComment, '/api/guestbook/messages.json', {
      articleId, parentId, quoteMessageId: ownerReply, quoteContent: '回复中的原话',
      nickname: 'Sam', content: '引用站长的回复', isAdmin: true, quoteNickname: '伪造昵称',
    });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    updateMessageStatus(id, 'published');
    const thread = listPublishedMessages(60, articleId).find((message) => message.id === parentId)!;
    expect(thread).toMatchObject({ quoteMessageId: null, quoteContent: '', quoteNickname: '' });
    expect(thread.replies?.find((reply) => reply.id === ownerReply)?.isAdmin).toBe(true);
    expect(thread.replies?.find((reply) => reply.id === id)).toMatchObject({
      parentId, quoteMessageId: ownerReply, quoteContent: '回复中的原话', quoteNickname: 'SuperSam', isAdmin: false,
    });
    expect((await call(postComment, '/api/guestbook/messages.json', {
      articleId, parentId, quoteMessageId: parentId, quoteContent: '连续片段', nickname: '另一访客', content: '引用根评论',
    })).status).toBe(201);
  });
  it('rejects fabricated, oversized, malformed, cross-article and non-public quote sources', async () => {
    const articleId = saveArticle(content); const otherArticle = saveArticle(content);
    const parentId = createPublishedMessage({ articleId, nickname: '原作者', content: `连续原文${'😀'.repeat(siteConfig.discussion.quoteMaximumCharacters + 1)}`, fingerprintHash: 'quote-validation' });
    const other = createPublishedMessage({ articleId: otherArticle, nickname: '其他作者', content: '连续原文', fingerprintHash: 'quote-other' });
    const hidden = createPublishedMessage({ articleId, nickname: '隐藏作者', content: '连续原文', fingerprintHash: 'quote-hidden' });
    updateMessageStatus(hidden, 'hidden');
    const payload = { articleId, parentId, quoteMessageId: parentId, quoteContent: '连续原文', nickname: '测试访客', content: '引用验证' };
    for (const quote of [
      { quoteContent: '连续伪造原文' }, { quoteContent: '原文连续' }, { quoteContent: '' }, { quoteContent: ' ' },
      { quoteContent: '\u0000' }, { quoteContent: 12 }, { quoteMessageId: null }, { quoteMessageId: '1' },
      { quoteContent: '😀'.repeat(siteConfig.discussion.quoteMaximumCharacters + 1) }, { parentId: null },
    ]) {
      expect((await call(postComment, '/api/guestbook/messages.json', { ...payload, ...quote })).status).toBe(400);
    }
    expect((await call(postComment, '/api/guestbook/messages.json', { ...payload, articleId: null })).status).toBe(404);
    for (const quoteMessageId of [other, hidden, 999999]) {
      expect((await call(postComment, '/api/guestbook/messages.json', { ...payload, quoteMessageId })).status).toBe(404);
    }
    expect((await call(postComment, '/api/guestbook/messages.json', {
      ...payload, quoteContent: '😀'.repeat(siteConfig.discussion.quoteMaximumCharacters),
    })).status).toBe(201);
    expect(() => getDatabase().prepare("UPDATE messages SET quote_message_id = ?, quote_content = '' WHERE id = ?").run(parentId, other)).toThrow();
  });
  it('removes quote snapshots when their source or source thread becomes private or deleted', async () => {
    const articleId = saveArticle(content);
    const sourceRoot = createPublishedMessage({ articleId, nickname: '引用作者', content: '独有的引用根原话', fingerprintHash: 'quote-privacy-root' });
    const sourceReply = createPublishedMessage({ articleId, parentId: sourceRoot, nickname: '回复作者', content: '独有的引用回复原话', fingerprintHash: 'quote-privacy-reply' });
    const targetRoot = createPublishedMessage({ articleId, nickname: '回应作者', content: '保留公开的另一线程', fingerprintHash: 'quote-privacy-target' });
    const quoted = createPublishedMessage({ articleId, parentId: targetRoot, quoteMessageId: sourceReply, quoteContent: '引用回复原话', nickname: '回应访客', content: '引用后的回应', fingerprintHash: 'quote-privacy-quote' });
    const readQuote = () => listPublishedMessages(60, articleId).find((message) => message.id === targetRoot)?.replies?.find((message) => message.id === quoted);
    expect(readQuote()).toMatchObject({ quoteMessageId: sourceReply, quoteContent: '引用回复原话', quoteNickname: '回复作者' });
    updateMessageStatus(sourceRoot, 'hidden');
    expect(readQuote()).toMatchObject({ quoteMessageId: null, quoteContent: '', quoteNickname: '' });
    expect(() => createPublishedMessage({ articleId, parentId: targetRoot, quoteMessageId: sourceReply, quoteContent: '引用回复原话', nickname: '测试访客', content: '隐藏后引用', fingerprintHash: 'quote-hidden-thread' })).toThrow('引用的评论不存在');
    updateMessageStatus(sourceRoot, 'published');
    updateMessageStatus(sourceReply, 'hidden');
    expect(readQuote()).toMatchObject({ quoteMessageId: null, quoteContent: '', quoteNickname: '' });
    updateMessageStatus(sourceReply, 'published');
    deleteMessage(sourceReply);
    const response = await call(getComments, `/api/guestbook/messages.json?articleId=${articleId}`, undefined, undefined, 'GET');
    const serialized = await response.text();
    expect(serialized).not.toContain('引用回复原话');
    expect(readQuote()).toMatchObject({ quoteMessageId: null, quoteContent: '', quoteNickname: '' });
  });
});

describe('reactions and visitor counting', () => {
  it('rejects coerced reaction values and enforces source quotas across changing visitor cookies', async () => {
    const articleId = saveArticle(content);
    for (const reaction of [[], ['like'], {}, null, false]) {
      expect((await call(react, '/api/articles/reactions.json', { articleId, reaction })).status).toBe(400);
    }
    const source = '198.51.100.201';
    for (let index = 0; index < serverConfig.publicActivityLimit; index++) {
      const token = `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
      expect((await call(react, '/api/articles/reactions.json', { articleId, reaction: 'like' }, token, 'POST', undefined, source)).status).toBe(200);
    }
    expect((await call(react, '/api/articles/reactions.json', { articleId, reaction: 'like' }, undefined, 'POST', undefined, source)).status).toBe(429);
  });
  it('stores one reaction per anonymous visitor, supports switching and cancellation', async () => {
    const articleId = saveArticle(content);
    const payload = { articleId, reaction: 'like' };
    expect(await (await call(react, '/api/articles/reactions.json', payload)).json()).toMatchObject({ counts: { like: 1 }, selected: 'like' });
    expect((await call(react, '/api/articles/reactions.json', payload)).status).toBe(429);
    getDatabase().prepare("UPDATE article_reactions SET updated_at='2000-01-01'").run();
    expect(await (await call(react, '/api/articles/reactions.json', { articleId, reaction: 'helpful' })).json()).toMatchObject({ counts: { helpful: 1 }, selected: 'helpful' });
    getDatabase().prepare("UPDATE article_reactions SET updated_at='2000-01-01'").run();
    expect(await (await call(react, '/api/articles/reactions.json', { articleId, reaction: '' })).json()).toEqual({ counts: {}, selected: '' });
    withdrawArticle(articleId);
    expect((await call(react, '/api/articles/reactions.json', payload)).status).toBe(404);
  });
  it('counts repeat views separately from unique visitors and fills dates without visits', () => {
    const articleId = saveArticle(content); const first = hashVisitorToken('first'); const second = hashVisitorToken('second');
    recordPageView(first, new Date(), articleId); recordPageView(first, new Date(), articleId); recordPageView(second, new Date(), articleId);
    const statistics = getArticleAnalytics(7);
    expect(statistics.articles.find((article) => article.id === articleId)).toMatchObject({ views: 3, visitors: 2 });
    expect(statistics.days).toHaveLength(7);
    expect(statistics.totals).toEqual({ views: 3, visitors: 2 });
    expect(statistics.days.at(-1)).toMatchObject({ views: 3, visitors: 2 });
  });
});

describe('friend applications and local visitor profile', () => {
  it('retains and reviews the oldest pending application beyond 200 records', () => {
    const database = getDatabase();
    const ids = database.transaction(() => {
      const insert = database.prepare(`INSERT INTO friend_applications(name,url,description,icon_url,fingerprint_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`);
      return Array.from({ length: 201 }, (_, index) => Number(insert.run(`批量申请${index}`, `https://application-${index}.example.com/`, '待审核申请',
        'https://example.com/icon.png', `application-fixture-${index}`, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z').lastInsertRowid));
    })();
    expect(listFriendApplications().filter((entry) => ids.includes(entry.id))).toHaveLength(201);
    reviewFriendApplication(ids[0], true, {});
    expect(listFriends().some((friend) => friend.url === 'https://application-0.example.com/')).toBe(true);
    expect(() => reviewFriendApplication(ids[0], true, {})).toThrow('已经处理');
    database.prepare('UPDATE friend_applications SET deleted_at=? WHERE id=?').run('2020-01-02T00:00:00.000Z', ids[1]);
    expect(listFriendApplications().some((entry) => entry.id === ids[1])).toBe(false);
    expect(() => reviewFriendApplication(ids[1], true, {})).toThrow('不存在');
  });
  it('keeps applications private until review and prevents repeated acceptance', async () => {
    const input = { name: '申请站点', url: 'https://new-friend.example.com', description: '等待审核', iconUrl: 'https://new-friend.example.com/icon.png', rssUrl: '', email: 'owner@example.com' };
    expect((await call(apply, '/api/friends/applications.json', input)).status).toBe(201);
    expect(listFriends().some((friend) => friend.name === input.name)).toBe(false);
    expect((await call(apply, '/api/friends/applications.json', input)).status).toBe(409);
    const row = getDatabase().prepare('SELECT id FROM friend_applications WHERE name=?').get(input.name) as { id: number };
    expect((await call(review, '/api/admin/applications.json', { ...input, id: row.id, accepted: true }, undefined, 'PATCH')).status).toBe(200);
    expect(listFriends().some((friend) => friend.name === input.name)).toBe(true);
    expect((await call(review, '/api/admin/applications.json', { ...input, id: row.id, accepted: true }, undefined, 'PATCH')).status).toBe(409);
    expect((await call(apply, '/api/friends/applications.json', { ...input, url: 'http://127.0.0.1/' })).status).toBe(400);
  });
  it('restores only bounded name and email and ignores malformed local data', () => {
    expect(parseVisitorProfile('{')).toBeNull(); expect(parseVisitorProfile('null')).toBeNull();
    expect(parseVisitorProfile(JSON.stringify({ nickname: 'a'.repeat(25), email: '' }))).toBeNull();
    expect(parseVisitorProfile(JSON.stringify({ nickname: '访客\n', email: '' }))).toBeNull();
    expect(parseVisitorProfile(JSON.stringify({ nickname: '访客', email: 'reader@example.com', content: '不应保留', notifyReply: true }))).toEqual({ nickname: '访客', email: 'reader@example.com' });
  });
});

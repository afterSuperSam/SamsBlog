import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import { getDatabase, createMessage, createAdminReply, deleteMessage, listPublishedMessages, listAllMessages, updateMessageStatus } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { recordPageView, getArticleAnalytics, hashVisitorToken } from '../src/lib/stats';
import { createAdminSession } from '../src/lib/admin-auth';
import { listFriends, listFriendApplications, reviewFriendApplication } from '../src/lib/friends';
import { POST as postComment, GET as getComments } from '../src/pages/api/guestbook/messages.json';
import { POST as react } from '../src/pages/api/articles/reactions.json';
import { POST as apply } from '../src/pages/api/friends/applications.json';
import { PATCH as review } from '../src/pages/api/admin/applications.json';
import { parseVisitorProfile } from '../src/lib/visitor-profile';
import { siteConfig } from '../src/config/site';

vi.mock('../src/lib/reply-notifications', async (original) => ({ ...await original<object>(), replyNotificationsConfigured: false, queueReplyNotification: vi.fn() }));
beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-publishing-'))); });
const content = { title: '互动验证', content: '正文', source: 'original', category: 'journal' };
let sequence = 0;
async function call(handler: APIRoute, route: string, body?: unknown, token = '11111111-1111-4111-8111-111111111111', method = 'POST', origin = 'https://blog.example.com') {
  return await handler({ url: new URL(route, 'https://blog.example.com'),
    request: new Request(new URL(route, 'https://blog.example.com'), { method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    clientAddress: `203.0.113.${++sequence}`,
    cookies: { get: (name: string) => ({ value: name === 'samsblog_admin' ? createAdminSession() : token }), set: vi.fn() },
  } as unknown as APIContext) as Response;
}

describe('article conversation boundaries', () => {
  it('publishes article comments immediately, retains guestbook moderation and never exposes contact details', async () => {
    const articleId = saveArticle(content);
    const response = await call(postComment, '/api/guestbook/messages.json', { articleId, nickname: '测试访客', content: '直接公开的评论', email: 'reader@example.com' });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(listPublishedMessages(60, articleId).map((message) => message.id)).toContain(id);
    expect(listPublishedMessages().some((message) => message.id === id)).toBe(false);
    const publicResponse = await call(getComments, `/api/guestbook/messages.json?articleId=${articleId}`, undefined, undefined, 'GET');
    const serialized = await publicResponse.text();
    expect(serialized).not.toContain('reader@example.com'); expect(serialized).not.toContain('fingerprint');
    const guest = createMessage({ nickname: '纸条访客', content: '需要审核的留言', fingerprintHash: 'test-guest' });
    expect(listPublishedMessages().some((message) => message.id === guest)).toBe(false);
    expect(listAllMessages().find((message) => message.id === guest)?.status).toBe('pending');
    expect(getDatabase().prepare('SELECT email,notify_reply FROM messages WHERE id=?').get(id)).toEqual({ email: '', notify_reply: 0 });
  });
  it('rejects cross-article, nested and hidden replies and hides discussion when an article is withdrawn', async () => {
    const first = saveArticle(content); const second = saveArticle(content);
    const parent = createMessage({ articleId: first, nickname: '测试访客', content: '原评论', fingerprintHash: 'a' });
    expect((await call(postComment, '/api/guestbook/messages.json', { articleId: second, parentId: parent, nickname: '另一访客', content: '越界回复' })).status).toBe(404);
    const child = createMessage({ articleId: first, parentId: parent, nickname: '另一访客', content: '合法回复', fingerprintHash: 'b' });
    expect(() => createMessage({ articleId: first, parentId: child, nickname: '另一访客', content: '嵌套回复', fingerprintHash: 'c' })).toThrow();
    updateMessageStatus(parent, 'hidden');
    expect(listPublishedMessages(60, first)).toEqual([]);
    expect(() => createMessage({ articleId: first, parentId: parent, nickname: '另一访客', content: '隐藏回复', fingerprintHash: 'd' })).toThrow();
    withdrawArticle(first);
    expect((await call(getComments, `/api/guestbook/messages.json?articleId=${first}`, undefined, undefined, 'GET')).status).toBe(404);
    expect(listAllMessages().some((message) => message.id === parent)).toBe(true);
    expect((await call(postComment, '/api/guestbook/messages.json', { articleId: second, nickname: '访客', content: '测试' }, undefined, 'POST', 'https://other.example')).status).toBe(403);
  });
  it('quotes exact root or reply text without changing the root thread or trusting an owner nickname', async () => {
    const articleId = saveArticle(content);
    const parentId = createMessage({ articleId, nickname: '原作者', content: '评论原文中的连续片段。', fingerprintHash: 'quote-root' });
    const ownerReply = createAdminReply(parentId, '站长回复中的原话');
    const response = await call(postComment, '/api/guestbook/messages.json', {
      articleId, parentId, quoteMessageId: ownerReply, quoteContent: '回复中的原话',
      nickname: 'Sam', content: '引用站长的回复', isAdmin: true, quoteNickname: '伪造昵称',
    });
    expect(response.status).toBe(201);
    const { id } = await response.json();
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
    const parentId = createMessage({ articleId, nickname: '原作者', content: `连续原文${'😀'.repeat(siteConfig.discussion.quoteMaximumCharacters + 1)}`, fingerprintHash: 'quote-validation' });
    const other = createMessage({ articleId: otherArticle, nickname: '其他作者', content: '连续原文', fingerprintHash: 'quote-other' });
    const hidden = createMessage({ articleId, nickname: '隐藏作者', content: '连续原文', fingerprintHash: 'quote-hidden' });
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
    const sourceRoot = createMessage({ articleId, nickname: '引用作者', content: '独有的引用根原话', fingerprintHash: 'quote-privacy-root' });
    const sourceReply = createMessage({ articleId, parentId: sourceRoot, nickname: '回复作者', content: '独有的引用回复原话', fingerprintHash: 'quote-privacy-reply' });
    const targetRoot = createMessage({ articleId, nickname: '回应作者', content: '保留公开的另一线程', fingerprintHash: 'quote-privacy-target' });
    const quoted = createMessage({ articleId, parentId: targetRoot, quoteMessageId: sourceReply, quoteContent: '引用回复原话', nickname: '回应访客', content: '引用后的回应', fingerprintHash: 'quote-privacy-quote' });
    const readQuote = () => listPublishedMessages(60, articleId).find((message) => message.id === targetRoot)?.replies?.find((message) => message.id === quoted);
    expect(readQuote()).toMatchObject({ quoteMessageId: sourceReply, quoteContent: '引用回复原话', quoteNickname: '回复作者' });
    updateMessageStatus(sourceRoot, 'hidden');
    expect(readQuote()).toMatchObject({ quoteMessageId: null, quoteContent: '', quoteNickname: '' });
    expect(() => createMessage({ articleId, parentId: targetRoot, quoteMessageId: sourceReply, quoteContent: '引用回复原话', nickname: '测试访客', content: '隐藏后引用', fingerprintHash: 'quote-hidden-thread' })).toThrow('引用的评论不存在');
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

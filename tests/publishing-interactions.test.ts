import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import { getDatabase, createMessage, listPublishedMessages, listAllMessages, updateMessageStatus } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { recordPageView, getArticleAnalytics, hashVisitorToken } from '../src/lib/stats';
import { createAdminSession } from '../src/lib/admin-auth';
import { listFriends, listFriendApplications, reviewFriendApplication } from '../src/lib/friends';
import { POST as postComment, GET as getComments } from '../src/pages/api/guestbook/messages.json';
import { POST as react } from '../src/pages/api/articles/reactions.json';
import { POST as apply } from '../src/pages/api/friends/applications.json';
import { PATCH as review } from '../src/pages/api/admin/applications.json';
import { parseVisitorProfile } from '../src/lib/visitor-profile';

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

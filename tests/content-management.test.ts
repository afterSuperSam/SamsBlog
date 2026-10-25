import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { APIContext, APIRoute } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGithubContributions } from '../src/lib/contributions';
import { serverConfig } from '../src/config/server';
import { deleteFriend, listFriends, parseFriendInput, saveFriend, setFriendStarred } from '../src/lib/friends';
import { getSiteStats, hashVisitorToken, recordPageView } from '../src/lib/stats';
import { createMessage, createAdminReply, deleteMessage, getDatabase, listAllMessages, listPublishedMessages, updateMessageStatus } from '../src/lib/db';
import { createAdminSession } from '../src/lib/admin-auth';
import { POST as postPublicMessage } from '../src/pages/api/guestbook/messages.json';
import { POST as postAdminReply } from '../src/pages/api/admin/messages.json';
import { PATCH as patchFriend } from '../src/pages/api/admin/friends.json';

beforeAll(async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'samsblog-content-'));
  vi.stubEnv('BLOG_DATA_DIR', dataDirectory);
  const existing = new Database(path.join(dataDirectory, 'blog.sqlite'));
  existing.exec(`CREATE TABLE friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL, icon_url TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    background_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE media (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
  INSERT INTO media (id, url) VALUES (1, '/historical-photo.jpg');`);
  existing.prepare('INSERT INTO friends (name,url,description,icon_url,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('楹雾镇', 'https://yingwutown.top/', '我的世界玩家社区', 'https://yingwutown.top/favicon.ico', '2026-08-22', '2026-08-22');
  existing.prepare('INSERT INTO friends (name,url,description,icon_url,created_at,updated_at,deleted_at,background_url) VALUES (?,?,?,?,?,?,?,?)')
    .run('历史友链', 'https://deleted.example.com/', '保留删除状态', 'https://deleted.example.com/icon.png', '2026-08-22', '2026-08-22', '2026-09-01', 'https://deleted.example.com/background.jpg');
  existing.close();
});

let messageRequestSequence = 0;
async function callMessageApi(handler: APIRoute, body: Record<string, unknown>, authorized = true) {
  messageRequestSequence += 1;
  return handler({
    request: new Request('https://blog.example.com/api/messages.json', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://blog.example.com' }, body: JSON.stringify(body),
    }),
    clientAddress: `203.0.113.${messageRequestSequence}`,
    cookies: { get: () => authorized ? { value: createAdminSession() } : undefined },
  } as unknown as APIContext) as Promise<Response>;
}

describe('SQLite content management', () => {
  it('counts runtime days at Shanghai midnight and stays zero before launch', () => {
    const launch = new Date(`${serverConfig.siteLaunchedAt}T00:00:00+08:00`).getTime();
    expect(getSiteStats(new Date(launch - 1)).runtimeDays).toBe(0);
    expect(getSiteStats(new Date(launch)).runtimeDays).toBe(1);
    expect(getSiteStats(new Date(launch + 86_400_000 - 1)).runtimeDays).toBe(1);
    expect(getSiteStats(new Date(launch + 86_400_000)).runtimeDays).toBe(2);
  });

  it('initializes active content without deleting historical data', () => {
    expect(getDatabase().prepare("SELECT name FROM sqlite_master WHERE name IN ('articles', 'article_activity')").all()).toHaveLength(0);
    expect(getDatabase().prepare('SELECT * FROM media').all()).toEqual([{ id: 1, url: '/historical-photo.jpg' }]);
    expect(getDatabase().prepare("SELECT deleted_at, background_url FROM friends WHERE url = 'https://deleted.example.com/'").get())
      .toEqual({ deleted_at: '2026-09-01', background_url: 'https://deleted.example.com/background.jpg' });
    expect(listFriends({ includeHidden: true }).some((friend) => friend.url === 'https://deleted.example.com/')).toBe(false);
    expect(getDatabase().prepare("SELECT name FROM sqlite_master WHERE name = 'friends_public_idx'").get()).toBeTruthy();
    expect(listFriends().find((friend) => friend.url === 'https://moesam.com/')?.description).toBe('我的世界玩家社区');
    const first = hashVisitorToken('first');
    recordPageView(first); recordPageView(first); recordPageView(hashVisitorToken('second'));
    expect(getSiteStats()).toMatchObject({ visitors: 2, pageViews: 3, friends: listFriends().length });
  });

  it('edits, hides and soft-deletes HTTP(S) friend links', () => {
    const input = parseFriendInput({ name: '测试友链', url: 'https://example.com', description: '用于验证友链后台。', iconUrl: 'https://example.com/icon.png', backgroundUrl: 'https://example.com/background.jpg', visible: true });
    const id = Number(saveFriend(input));
    expect(listFriends().find((friend) => friend.id === id)?.backgroundUrl).toBe(input.backgroundUrl);
    expect(saveFriend({ ...input, id, name: '改名友链', visible: false })).toBe(true);
    expect(listFriends().some((friend) => friend.id === id)).toBe(false);
    expect(listFriends({ includeHidden: true }).some((friend) => friend.name === '改名友链')).toBe(true);
    expect(() => parseFriendInput({ ...input, iconUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => parseFriendInput({ ...input, url: 'https://user:password@example.com' })).toThrow();
    expect(() => parseFriendInput({ ...input, backgroundUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => parseFriendInput({ ...input, backgroundUrl: 'https://user:secret@example.com/background.jpg' })).toThrow();
    expect(() => parseFriendInput({ ...input, backgroundUrl: 123 })).toThrow();
    expect(deleteFriend(id)).toBe(true);
    expect(listFriends({ includeHidden: true }).some((friend) => friend.id === id)).toBe(false);
    expect(getDatabase().prepare('SELECT deleted_at FROM friends WHERE id = ?').get(id)).toMatchObject({ deleted_at: expect.any(String) });
    expect(saveFriend(input)).toBeGreaterThan(id);
  });

  it('keeps starred friends first and preserves the original creation order within each group', () => {
    const database = getDatabase();
    const existing = listFriends()[0];
    expect(existing.starred).toBe(false);
    expect(database.prepare("SELECT id FROM schema_migrations WHERE id='20261025-friend-starred'").get()).toBeTruthy();
    const ids = Array.from({ length: 4 }, (_, index) => Number(saveFriend(parseFriendInput({
      name: `排序友链${index}`, url: `https://sort-${index}.example.com`, description: '星标排序验证', iconUrl: 'https://example.com/icon.png',
    }))));
    ids.forEach((id, index) => database.prepare('UPDATE friends SET created_at=? WHERE id=?').run(`2026-01-0${index + 1}T00:00:00.000Z`, id));
    const ordered = () => listFriends().filter((friend) => ids.includes(friend.id)).map((friend) => friend.id);
    expect(setFriendStarred(ids[3], true)).toBe(true);
    expect(setFriendStarred(ids[1], true)).toBe(true);
    expect(ordered()).toEqual([ids[1], ids[3], ids[0], ids[2]]);
    const starred = listFriends().find((friend) => friend.id === ids[1])!;
    const { starred: ignored, ...ordinaryEdit } = starred;
    expect(saveFriend(parseFriendInput({ ...ordinaryEdit, name: '修改名称不清除星标' }))).toBe(true);
    expect(listFriends().find((friend) => friend.id === ids[1])).toMatchObject({ starred: true, createdAt: '2026-01-02T00:00:00.000Z' });
    setFriendStarred(ids[1], false);
    expect(ordered()).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    expect(() => database.prepare('UPDATE friends SET starred=2 WHERE id=?').run(ids[0])).toThrow();
    ids.forEach(deleteFriend);
  });

  it('validates star updates and never exposes hidden or deleted starred friends', async () => {
    const input = parseFriendInput({ name: '星标边界', url: 'https://star-boundary.example.com', description: '边界验证', iconUrl: 'https://example.com/icon.png', visible: false });
    const id = Number(saveFriend(input));
    const request = (starred: unknown, authorized = true, origin = 'https://blog.example.com') => patchFriend({
      request: new Request('https://blog.example.com/api/admin/friends.json', { method: 'PATCH', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ id, action: 'star', starred }) }),
      clientAddress: '203.0.113.170', cookies: { get: () => authorized ? { value: createAdminSession() } : undefined },
    } as unknown as APIContext) as Promise<Response>;
    expect((await request(true, false)).status).toBe(401);
    expect((await request(true, true, 'https://other.example')).status).toBe(403);
    for (const value of ['true', 1, null]) {
      expect(() => parseFriendInput({ ...input, starred: value })).toThrow('布尔值');
      expect((await request(value)).status).toBe(400);
    }
    expect((await request(true)).status).toBe(200);
    expect(listFriends().some((friend) => friend.id === id)).toBe(false);
    expect(listFriends({ includeHidden: true }).find((friend) => friend.id === id)?.starred).toBe(true);
    deleteFriend(id);
    expect((await request(false)).status).toBe(404);
    expect(setFriendStarred(id, false)).toBe(false);
  });

  it('rejects incomplete HTTP addresses in every friend URL field', () => {
    const input = { name: '地址验证', url: 'https://example.com/', description: '验证完整网址', iconUrl: 'https://example.com/icon.png', visible: true };
    for (const field of ['url', 'iconUrl', 'backgroundUrl', 'rssUrl']) {
      expect(() => parseFriendInput({ ...input, [field]: 'https:example.com/image' })).toThrow('完整的网址');
    }
  });

  it('preserves existing friends during background migration and allows clearing a background', () => {
    const friend = listFriends().find((item) => item.url === 'https://moesam.com/')!;
    expect(friend.backgroundUrl).toBe('');
    expect(getDatabase().prepare("SELECT id FROM schema_migrations WHERE id = '20261015-friend-background-v1'").get()).toBeTruthy();
    const input = parseFriendInput({ ...friend, backgroundUrl: 'https://example.com/art.webp' });
    expect(saveFriend(input)).toBe(true);
    expect(listFriends().find((item) => item.id === friend.id)?.backgroundUrl).toBe('https://example.com/art.webp');
    expect(saveFriend(parseFriendInput({ ...input, backgroundUrl: '  ' }))).toBe(true);
    expect(listFriends().find((item) => item.id === friend.id)?.backgroundUrl).toBe('');
    expect(parseFriendInput({ ...input, backgroundUrl: undefined }).backgroundUrl).toBe('');
  });

  it('migrates optional friend RSS addresses and supports create, edit and clearing', () => {
    const existing = listFriends().find((friend) => friend.url === 'https://moesam.com/')!;
    expect(existing.rssUrl).toBe('');
    expect(getDatabase().prepare("SELECT id FROM schema_migrations WHERE id = '20261018-friend-rss-v1'").get()).toBeTruthy();
    const input = parseFriendInput({ name: '订阅友链', url: 'https://rss.example.com', description: '可订阅的友链', iconUrl: 'https://rss.example.com/icon.png', rssUrl: ' https://rss.example.com/feed.xml?a=1&b=2#ignored ' });
    const id = Number(saveFriend(input));
    expect(listFriends().find((friend) => friend.id === id)?.rssUrl).toBe('https://rss.example.com/feed.xml?a=1&b=2');
    expect(saveFriend(parseFriendInput({ ...input, id, rssUrl: 'http://rss.example.com/atom.xml' }))).toBe(true);
    expect(listFriends().find((friend) => friend.id === id)?.rssUrl).toBe('http://rss.example.com/atom.xml');
    expect(saveFriend(parseFriendInput({ ...input, id, rssUrl: '  ' }))).toBe(true);
    expect(listFriends().find((friend) => friend.id === id)?.rssUrl).toBe('');
    expect(parseFriendInput({ ...input, rssUrl: undefined }).rssUrl).toBe('');
    for (const rssUrl of [123, null, '/rss.xml', 'javascript:alert(1)', 'ftp://example.com/rss.xml', 'https://user:secret@example.com/rss.xml']) {
      expect(() => parseFriendInput({ ...input, rssUrl })).toThrow();
    }
  });

  it('parses real consecutive GitHub dates and rejects incomplete responses', () => {
    const cells = Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
      return `<td data-level="2" data-date="${date}"></td><tool-tip>2 contributions on ${date}.</tool-tip>`;
    }).join('');
    const calendar = parseGithubContributions(cells);
    expect(new Set(calendar.days.map((day) => day.date)).size).toBe(365);
    expect(calendar.total).toBe(730);
    expect(() => parseGithubContributions('')).toThrow();
  });

  it.each([
    { nickname: '😀', content: '有效留言' },
    { nickname: '访客', content: '😀' },
    { nickname: '名\u0000字', content: '有效留言' },
    { nickname: '访客', content: '留\u0000言' },
    { nickname: '😀'.repeat(25), content: '有效留言' },
    { nickname: '访客', content: '😀'.repeat(501) },
  ])('rejects invalid public message character counts and NUL with a client error (case %#)', async (body) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await callMessageApi(postPublicMessage, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it.each([
    { nickname: '😀😀', content: '😀😀' },
    { nickname: '😀'.repeat(24), content: '😀'.repeat(500) },
    { nickname: '名'.repeat(24), content: '文'.repeat(500) },
    { nickname: 'a'.repeat(24), content: 'b'.repeat(500) },
  ])('counts public message limits by Unicode code points (case %#)', async (body) => {
    const response = await callMessageApi(postPublicMessage, body);
    expect(response.status).toBe(201);
    expect(getDatabase().prepare('SELECT nickname,content,status FROM messages ORDER BY id DESC LIMIT 1').get())
      .toEqual({ ...body, status: 'pending' });
  });

  it('applies the same Unicode limits and NUL rejection to authenticated replies', async () => {
    const parentId = createMessage({ nickname: '原留言', content: '管理员回复验证', fingerprintHash: 'reply-validation-root' });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await callMessageApi(postAdminReply, { parentId, content: '有效回复' }, false)).status).toBe(401);
      for (const content of ['😀', '回\u0000复', '😀'.repeat(501)]) {
        const response = await callMessageApi(postAdminReply, { parentId, content });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.any(String) });
      }
      for (const content of ['😀😀', '😀'.repeat(500), '文'.repeat(500), 'a'.repeat(500)]) {
        const response = await callMessageApi(postAdminReply, { parentId, content });
        expect(response.status).toBe(201);
        const { id } = await response.json();
        expect(getDatabase().prepare('SELECT parent_id,nickname,content,status FROM messages WHERE id=?').get(id))
          .toEqual({ parent_id: parentId, nickname: 'Sam', content, status: 'published' });
      }
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it('keeps replies with their root and soft-deletes the complete thread', () => {
    const id = createMessage({ nickname: '访客', content: '较早的留言', fingerprintHash: 'visitor' });
    updateMessageStatus(id, 'published');
    const newer = createMessage({ nickname: '后来', content: '较新的留言', fingerprintHash: 'newer' });
    updateMessageStatus(newer, 'published');
    const reply = createAdminReply(id, '后来的回复');
    expect(listAllMessages(1).map((message) => message.id)).toEqual([newer]);
    expect(listPublishedMessages().find((message) => message.id === id)?.replies?.[0]?.id).toBe(reply);
    expect(deleteMessage(id)).toBe(true);
    expect(listAllMessages().some((message) => message.id === id || message.id === reply)).toBe(false);
    expect(getDatabase().prepare('SELECT count(*) AS count FROM messages WHERE id IN (?, ?) AND deleted_at IS NOT NULL').get(id, reply)).toEqual({ count: 2 });
  });

  it('keeps older moderation threads accessible beyond 200 roots without expanding the public window', () => {
    const parentId = createMessage({ nickname: '旧访客', content: '旧的公开留言', fingerprintHash: 'older-root' });
    updateMessageStatus(parentId, 'published');
    const replyId = createMessage({ parentId, nickname: '回复者', content: '旧线程待审核回复', fingerprintHash: 'older-reply' });
    const pendingId = createMessage({ nickname: '待审核', content: '旧的待审核留言', fingerprintHash: 'older-pending' });
    const newerIds = Array.from({ length: 201 }, (_, index) => {
      const id = createMessage({ nickname: '新访客', content: `较新的留言 ${index}`, fingerprintHash: `newer-${index}` });
      updateMessageStatus(id, 'published');
      return id;
    });
    const messages = listAllMessages();
    expect(messages.find((message) => message.id === parentId)).toBeDefined();
    expect(messages.find((message) => message.id === replyId)?.status).toBe('pending');
    expect(messages.find((message) => message.id === pendingId)?.status).toBe('pending');
    expect(updateMessageStatus(replyId, 'published')).toBe(true);
    expect(updateMessageStatus(pendingId, 'hidden')).toBe(true);
    expect(listAllMessages().find((message) => message.id === replyId)?.status).toBe('published');
    expect(listAllMessages().find((message) => message.id === pendingId)?.status).toBe('hidden');
    expect(listPublishedMessages().map((message) => message.id)).toEqual(newerIds.slice(-60).reverse());
    expect(deleteMessage(parentId)).toBe(true);
    expect(listAllMessages().some((message) => message.id === parentId || message.id === replyId)).toBe(false);
  });

  it('reads all moderation threads without exhausting SQLite parameter limits', () => {
    const database = getDatabase();
    const fingerprintHash = 'large-moderation-fixture';
    let parentId = 0;
    let replyId = 0;
    database.transaction(() => {
      const insert = database.prepare("INSERT INTO messages (nickname,content,fingerprint_hash,status) VALUES ('测试访客','参数边界验证',?,'published')");
      parentId = Number(insert.run(fingerprintHash).lastInsertRowid);
      replyId = createAdminReply(parentId, '边界线程回复');
      for (let index = 0; index < 32766; index += 1) insert.run(fingerprintHash);
    })();
    try {
      const messages = listAllMessages();
      expect(messages.find((message) => message.id === parentId)).toBeDefined();
      expect(messages.find((message) => message.id === replyId)?.parentId).toBe(parentId);
      expect(messages.filter((message) => message.parentId === null).length).toBeGreaterThanOrEqual(32767);
      expect(listPublishedMessages()).toHaveLength(60);
    } finally {
      database.prepare('UPDATE messages SET deleted_at = ? WHERE fingerprint_hash = ? OR id = ?').run(new Date().toISOString(), fingerprintHash, replyId);
    }
  });
});

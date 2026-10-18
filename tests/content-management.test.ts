import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGithubContributions } from '../src/lib/contributions';
import { serverConfig } from '../src/config/server';
import { deleteFriend, listFriends, parseFriendInput, saveFriend } from '../src/lib/friends';
import { getSiteStats, hashVisitorToken, recordPageView } from '../src/lib/stats';
import { createMessage, createAdminReply, deleteMessage, getDatabase, listAllMessages, listPublishedMessages, updateMessageStatus } from '../src/lib/db';

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
    expect(listFriends().find((friend) => friend.url === 'https://yingwutown.top/')?.description).toBe('我的世界玩家社区');
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

  it('preserves existing friends during background migration and allows clearing a background', () => {
    const friend = listFriends().find((item) => item.url === 'https://yingwutown.top/')!;
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
    const existing = listFriends().find((friend) => friend.url === 'https://yingwutown.top/')!;
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
});

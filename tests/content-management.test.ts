import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGithubContributions } from '../src/lib/contributions';
import { serverConfig } from '../src/config/server';
import { deleteFriend, listFriends, parseFriendInput, saveFriend } from '../src/lib/friends';
import { getSiteStats, hashVisitorToken, recordPageView } from '../src/lib/stats';
import { createMessage, createAdminReply, deleteMessage, getDatabase, listAllMessages, listPublishedMessages, updateMessageStatus } from '../src/lib/db';

beforeAll(async () => {
  vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-content-')));
});

describe('SQLite content management', () => {
  it('counts runtime days at Shanghai midnight and stays zero before launch', () => {
    const launch = new Date(`${serverConfig.siteLaunchedAt}T00:00:00+08:00`).getTime();
    expect(getSiteStats(new Date(launch - 1)).runtimeDays).toBe(0);
    expect(getSiteStats(new Date(launch)).runtimeDays).toBe(1);
    expect(getSiteStats(new Date(launch + 86_400_000 - 1)).runtimeDays).toBe(1);
    expect(getSiteStats(new Date(launch + 86_400_000)).runtimeDays).toBe(2);
  });

  it('initializes remaining content and counts visitors without retired content tables', () => {
    expect(getDatabase().prepare("SELECT name FROM sqlite_master WHERE name IN ('articles', 'article_activity', 'media')").all()).toHaveLength(0);
    expect(listFriends().find((friend) => friend.url === 'https://yingwutown.top/')?.description).toBe('我的世界玩家社区');
    const first = hashVisitorToken('first');
    recordPageView(first); recordPageView(first); recordPageView(hashVisitorToken('second'));
    expect(getSiteStats()).toMatchObject({ visitors: 2, pageViews: 3, friends: listFriends().length });
  });

  it('edits, hides and soft-deletes HTTP(S) friend links', () => {
    const input = parseFriendInput({ name: '测试友链', url: 'https://example.com', description: '用于验证友链后台。', iconUrl: 'https://example.com/icon.png', visible: true });
    const id = Number(saveFriend(input));
    expect(saveFriend({ ...input, id, name: '改名友链', visible: false })).toBe(true);
    expect(listFriends().some((friend) => friend.id === id)).toBe(false);
    expect(listFriends({ includeHidden: true }).some((friend) => friend.name === '改名友链')).toBe(true);
    expect(() => parseFriendInput({ ...input, iconUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => parseFriendInput({ ...input, url: 'https://user:password@example.com' })).toThrow();
    expect(deleteFriend(id)).toBe(true);
    expect(listFriends({ includeHidden: true }).some((friend) => friend.id === id)).toBe(false);
    expect(getDatabase().prepare('SELECT deleted_at FROM friends WHERE id = ?').get(id)).toMatchObject({ deleted_at: expect.any(String) });
    expect(saveFriend(input)).toBeGreaterThan(id);
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

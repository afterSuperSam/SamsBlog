import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory: string;
let openDatabase: typeof import('../src/lib/db').getDatabase;
let connection: Database.Database | undefined;
const migration = '20261022-moesam-domain';

beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(path.join(tmpdir(), 'samsblog-domain-migration-'));
  vi.stubEnv('BLOG_DATA_DIR', directory);
  const initial = (await import('../src/lib/db')).getDatabase();
  initial.prepare('DELETE FROM schema_migrations WHERE id = ?').run(migration);
  initial.prepare('DELETE FROM friends').run();
  const insert = initial.prepare(`INSERT INTO friends
    (id,name,url,description,icon_url,background_url,rss_url,visible,created_at,updated_at,deleted_at)
    VALUES (?, ?, ?, '历史简介', 'https://yingwutown.top/icon.png', 'https://yingwutown.top/background.png',
      'https://yingwutown.top/rss.xml', ?, '2026-01-01', '2026-02-02', ?)`);
  insert.run(10, '旧地址', 'https://yingwutown.top/', 1, null);
  insert.run(20, '新地址', 'https://moesam.com/', 0, null);
  insert.run(30, '已删除历史', 'https://yingwutown.top/', 1, '2026-03-03');
  insert.run(40, '没有冲突', 'https://blog.yingwutown.top/', 1, null);
  initial.prepare(`INSERT INTO friend_feed_cache (friend_id,rss_url,title,entry_url,published_at,checked_at)
    VALUES (10,'https://yingwutown.top/rss.xml','历史订阅','https://yingwutown.top/entry','2026-01-01','2026-02-02')`).run();
  initial.close();
  vi.resetModules();
  openDatabase = (await import('../src/lib/db')).getDatabase;
});

afterEach(() => {
  connection?.close();
  connection = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('domain migration transaction', () => {
  it.each([true, false])('retains new-domain records and recoverable history with existing index=%s', async (indexed) => {
    if (!indexed) {
      const legacy = new Database(path.join(directory, 'blog.sqlite'));
      legacy.exec('DROP INDEX friends_active_url_idx');
      legacy.close();
    }
    connection = openDatabase();
    const old = connection.prepare('SELECT * FROM friends WHERE id=10').get() as Record<string, unknown>;
    const current = connection.prepare('SELECT * FROM friends WHERE id=20').get() as Record<string, unknown>;
    expect(old).toMatchObject({ url: 'https://moesam.com/', name: '旧地址', deleted_at: expect.any(String), created_at: '2026-01-01', updated_at: '2026-02-02' });
    expect(current).toMatchObject({ url: 'https://moesam.com/', name: '新地址', visible: 0, deleted_at: null });
    expect(connection.prepare('SELECT deleted_at FROM friends WHERE id=30').get()).toEqual({ deleted_at: '2026-03-03' });
    expect(connection.prepare('SELECT url,deleted_at FROM friends WHERE id=40').get()).toEqual({ url: 'https://blog.moesam.com/', deleted_at: null });
    expect(old).toMatchObject({ id: 10, description: '历史简介', rss_url: 'https://moesam.com/rss.xml', background_url: 'https://moesam.com/background.png' });
    expect(connection.prepare('SELECT title,entry_url FROM friend_feed_cache WHERE friend_id=10').get()).toEqual({ title: '历史订阅', entry_url: 'https://moesam.com/entry' });
    expect(() => connection!.prepare('UPDATE friends SET deleted_at=NULL WHERE id=10').run()).toThrow(/UNIQUE/);
    expect(connection.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migration)).toBeTruthy();
    connection.close();
    connection = undefined;
    vi.resetModules();
    connection = (await import('../src/lib/db')).getDatabase();
    expect(connection.prepare('SELECT * FROM friends WHERE id=10').get()).toEqual(old);
    expect(connection.prepare('SELECT * FROM friends WHERE id=20').get()).toEqual(current);
  });

  it('rolls back soft deletion and migration markers when a later update fails', () => {
    const legacy = new Database(path.join(directory, 'blog.sqlite'));
    legacy.exec(`INSERT INTO messages (nickname,content,fingerprint_hash) VALUES ('访客','https://yingwutown.top/','fixture');
      CREATE TRIGGER reject_domain_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'migration fixture failure'); END;`);
    legacy.close();
    expect(() => openDatabase()).toThrow('migration fixture failure');
    const inspect = new Database(path.join(directory, 'blog.sqlite'));
    try {
      expect(inspect.prepare('SELECT url,deleted_at FROM friends WHERE id=10').get()).toEqual({ url: 'https://yingwutown.top/', deleted_at: null });
      expect(inspect.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migration)).toBeUndefined();
      inspect.exec('DROP TRIGGER reject_domain_update');
    } finally { inspect.close(); }
    connection = openDatabase();
    expect(connection.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migration)).toBeTruthy();
  });
});

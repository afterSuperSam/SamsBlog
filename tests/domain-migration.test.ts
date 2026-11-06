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
  it.each([true, false])('adds or adopts the feed summary column without losing cached entries, existing column=%s', async (existingColumn) => {
    const legacy = new Database(path.join(directory, 'blog.sqlite'));
    legacy.prepare('DELETE FROM schema_migrations WHERE id=?').run('20261107-friend-feed-summary');
    if (existingColumn) legacy.prepare('UPDATE friend_feed_cache SET summary=? WHERE friend_id=10').run('既有摘要');
    else legacy.exec('ALTER TABLE friend_feed_cache DROP COLUMN summary');
    legacy.close();
    connection = openDatabase();
    expect(connection.prepare('SELECT title,summary,published_at,checked_at FROM friend_feed_cache WHERE friend_id=10').get())
      .toEqual({ title: '历史订阅', summary: existingColumn ? '既有摘要' : '', published_at: '2026-01-01', checked_at: '2026-02-02' });
    connection.close();
    connection = undefined;
    vi.resetModules();
    connection = (await import('../src/lib/db')).getDatabase();
    expect(connection.prepare('SELECT summary FROM friend_feed_cache WHERE friend_id=10').get()).toEqual({ summary: existingColumn ? '既有摘要' : '' });
  });

  it.each([true, false])('preserves queue identities, snapshots and existing friend relations when adding acceptance receipts, old queue=%s', async (oldQueue) => {
    const legacy = new Database(path.join(directory, 'blog.sqlite'));
    legacy.prepare('DELETE FROM schema_migrations WHERE id=?').run('20261107-friend-application-receipt');
    legacy.prepare(`INSERT INTO friend_applications(id,name,url,description,icon_url,email,fingerprint_hash,created_at,updated_at,friend_id)
      VALUES (20,'既有申请','https://moesam.com/','保留关联','https://example.com/icon.png','migration@example.com','migration','2026-01-01','2026-02-02',20)`).run();
    if (oldQueue) {
      const schema = legacy.prepare("SELECT sql FROM sqlite_master WHERE name='mail_notifications'").get() as { sql: string };
      legacy.exec(`${schema.sql.replace('mail_notifications', 'mail_notifications_legacy').replaceAll(",'application_accepted'", '')};
        DROP TABLE mail_notifications;
        ALTER TABLE mail_notifications_legacy RENAME TO mail_notifications;`);
    }
    const snapshot = { id: 777, kind: 'application', message_id: null, reply_id: null, application_id: 20, status: 'pending', attempts: 2,
      created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:05:00Z', retry_at: '2026-11-07T00:10:00Z', provider_id: 'old-provider', request_payload: '{"subject":"已保存请求"}' };
    legacy.prepare(`INSERT INTO mail_notifications(id,kind,message_id,reply_id,application_id,status,attempts,created_at,updated_at,retry_at,provider_id,request_payload)
      VALUES (@id,@kind,@message_id,@reply_id,@application_id,@status,@attempts,@created_at,@updated_at,@retry_at,@provider_id,@request_payload)`).run(snapshot);
    legacy.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='mail_notifications'").run();
    legacy.close();
    connection = openDatabase();
    expect(connection.prepare('SELECT * FROM mail_notifications WHERE id=777').get()).toEqual(snapshot);
    expect(connection.prepare('SELECT friend_id FROM friend_applications WHERE id=20').get()).toEqual({ friend_id: 20 });
    expect(connection.prepare("SELECT COUNT(*) AS count FROM mail_notifications WHERE kind='application_accepted'").get()).toEqual({ count: 0 });
    const insert = connection.prepare("INSERT INTO mail_notifications(kind,application_id,created_at,updated_at) VALUES ('application_accepted',20,'','')");
    expect(Number(insert.run().lastInsertRowid)).toBeGreaterThan(900);
    expect(() => insert.run()).toThrow(/UNIQUE/);
    expect(() => connection!.prepare("INSERT INTO mail_notifications(kind,created_at,updated_at) VALUES ('application_accepted','','')").run()).toThrow(/CHECK/);
    connection.close();
    connection = undefined;
    vi.resetModules();
    connection = (await import('../src/lib/db')).getDatabase();
    expect(connection.prepare('SELECT * FROM mail_notifications WHERE id=777').get()).toEqual(snapshot);
  });

  it.each([true, false])('adopts existing recommendation columns and status caches without the current marker, legacy cache=%s', async (legacyCache) => {
    const legacy = new Database(path.join(directory, 'blog.sqlite'));
    legacy.prepare('DELETE FROM schema_migrations WHERE id=?').run('20261107-friend-groups');
    legacy.prepare('UPDATE friends SET recommended=1,starred=1 WHERE id=20').run();
    if (legacyCache) {
      legacy.exec(`DROP TABLE friend_status_cache;
        CREATE TABLE friend_status_cache (
          friend_id INTEGER PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE, url TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('online','slow','offline','restricted','blocked')),
          failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0), checked_at TEXT NOT NULL
        )`);
    }
    legacy.prepare('INSERT INTO friend_status_cache(friend_id,url,status,checked_at) VALUES (?,?,?,?)')
      .run(20, 'https://moesam.com/', 'restricted', '2026-11-07T00:00:00.000Z');
    legacy.close();
    connection = openDatabase();
    expect(connection.prepare('SELECT recommended,starred,visible,created_at,updated_at FROM friends WHERE id=20').get())
      .toEqual({ recommended: 1, starred: 1, visible: 0, created_at: '2026-01-01', updated_at: '2026-02-02' });
    expect(connection.prepare('SELECT friend_id,url,status,checked_at,latency_milliseconds FROM friend_status_cache').get())
      .toEqual({ friend_id: 20, url: 'https://moesam.com/', status: 'restricted', checked_at: '2026-11-07T00:00:00.000Z', latency_milliseconds: null });
    expect(() => connection!.prepare('UPDATE friends SET recommended=2 WHERE id=20').run()).toThrow(/CHECK/);
    expect(() => connection!.prepare("UPDATE friend_status_cache SET status='invalid'").run()).toThrow(/CHECK/);
    expect(connection.prepare("SELECT id FROM schema_migrations WHERE id='20261107-friend-groups'").get()).toBeTruthy();
    expect(connection.prepare("SELECT name FROM sqlite_master WHERE name='friends_active_url_idx'").get()).toBeTruthy();
    connection.close();
    connection = undefined;
    vi.resetModules();
    connection = (await import('../src/lib/db')).getDatabase();
    expect(connection.prepare('SELECT recommended FROM friends WHERE id=20').get()).toEqual({ recommended: 1 });
  });

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

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config/server';
import { siteConfig } from '../config/site';
import { HttpError } from './http';

export type MessageStatus = 'pending' | 'published' | 'hidden';

export interface MessageRecord {
  id: number;
  parentId: number | null;
  nickname: string;
  content: string;
  status: MessageStatus;
  createdAt: string;
  replies?: MessageRecord[];
}

let database: Database.Database | undefined;

export function getDatabase() {
  if (database) return database;
  const dataDir = process.env.BLOG_DATA_DIR || path.resolve('data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'blog.sqlite');
  const connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  try {
    connection.transaction(() => {
      const friendsInitialized = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'friends'").get();
      connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 2 AND 24),
          content TEXT NOT NULL CHECK(length(content) BETWEEN 2 AND 500),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'published', 'hidden')),
          fingerprint_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS messages_status_created_idx ON messages(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS messages_fingerprint_created_idx ON messages(fingerprint_hash, created_at DESC);
        CREATE TABLE IF NOT EXISTS site_visitors (
          visitor_hash TEXT PRIMARY KEY,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          page_views INTEGER NOT NULL DEFAULT 1 CHECK(page_views > 0)
        );
        CREATE INDEX IF NOT EXISTS site_visitors_last_seen_idx ON site_visitors(last_seen DESC);
        CREATE TABLE IF NOT EXISTS friends (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
          url TEXT NOT NULL,
          description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 240),
          icon_url TEXT NOT NULL,
          visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
      `);
      const appliedMigrations = new Set((connection.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((row) => row.id));
      if (!appliedMigrations.has('20261017-blog-articles-v1')) {
        connection.exec(`
          CREATE TABLE IF NOT EXISTS blog_articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL CHECK(length(trim(title)) > 0),
            cover_url TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL CHECK(source IN ('original', 'repost')),
            category TEXT NOT NULL CHECK(category IN ('discussion', 'journal')),
            content TEXT NOT NULL CHECK(length(trim(content)) > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS blog_articles_public_created_idx
            ON blog_articles(created_at DESC, id DESC) WHERE deleted_at IS NULL;
        `);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261017-blog-articles-v1', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261018-project-settings')) {
        connection.exec(`
          CREATE TABLE project_statuses (
            repository TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('active', 'maintenance', 'archived'))
          );
          CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-project-settings', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261018-project-details')) {
        connection.exec(`
          ALTER TABLE project_statuses RENAME TO project_settings;
          ALTER TABLE project_settings ADD COLUMN name TEXT NOT NULL DEFAULT '';
          ALTER TABLE project_settings ADD COLUMN description TEXT NOT NULL DEFAULT '';
          ALTER TABLE project_settings ADD COLUMN url TEXT NOT NULL DEFAULT '';
        `);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-project-details', new Date().toISOString());
      }
      if (!appliedMigrations.has('friends-active-url-v1')) {
        const friendsSchema = connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'friends'").get() as { sql?: string } | undefined;
        if (friendsSchema?.sql?.includes('url TEXT NOT NULL UNIQUE')) {
          const columns = connection.pragma('table_info(friends)') as Array<{ name: string }>;
          const deletedAt = columns.some((column) => column.name === 'deleted_at') ? 'deleted_at' : 'NULL';
          const backgroundUrl = columns.some((column) => column.name === 'background_url') ? 'background_url' : "''";
          connection.exec(`
            DROP INDEX IF EXISTS friends_public_idx;
            ALTER TABLE friends RENAME TO friends_legacy;
            CREATE TABLE friends (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
              url TEXT NOT NULL,
              description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 240),
              icon_url TEXT NOT NULL,
              visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0, 1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT,
              background_url TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO friends (id, name, url, description, icon_url, visible, created_at, updated_at, deleted_at, background_url)
              SELECT id, name, url, description, icon_url, visible, created_at, updated_at, ${deletedAt}, ${backgroundUrl} FROM friends_legacy;
            DROP TABLE friends_legacy;
          `);
        }
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('friends-active-url-v1', new Date().toISOString());
      }
      // 兼容现有数据库：只增加删除标记，不销毁历史内容
      for (const table of ['messages', 'friends']) {
        const columns = connection.pragma(`table_info(${table})`) as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'deleted_at')) connection.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
      }
      if (!appliedMigrations.has('20261015-friend-background-v1')) {
        const friendColumns = connection.pragma('table_info(friends)') as Array<{ name: string }>;
        if (!friendColumns.some((column) => column.name === 'background_url')) {
          connection.exec("ALTER TABLE friends ADD COLUMN background_url TEXT NOT NULL DEFAULT ''");
        }
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261015-friend-background-v1', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261018-friend-rss-v1')) {
        connection.exec("ALTER TABLE friends ADD COLUMN rss_url TEXT NOT NULL DEFAULT ''");
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-friend-rss-v1', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261018-dynamic-projects-v1')) {
        connection.exec(`CREATE TABLE blog_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT, repository TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL CHECK(length(trim(name)) > 0), description TEXT NOT NULL,
          url TEXT NOT NULL, keyword TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('active','maintenance','archived')),
          visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)), position INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
        )`);
        const previous = new Map((connection.prepare('SELECT * FROM project_settings').all() as Array<Record<string, string>>).map((entry) => [entry.repository, entry]));
        const insertProject = connection.prepare(`INSERT INTO blog_projects(repository,name,description,url,keyword,status,position,created_at,updated_at)
          VALUES (@repository,@name,@description,@url,@keyword,@status,@position,@now,@now)`);
        const now = new Date().toISOString();
        siteConfig.projects.forEach((project, position) => {
          const saved = previous.get(project.repository);
          const description = saved?.description || project.description;
          insertProject.run({ repository: project.repository, name: saved?.name || project.name, description,
            url: saved?.url || `https://github.com/${project.repository}`, keyword: description.includes(project.keyword) ? project.keyword : '',
            status: saved?.status || project.status, position, now });
        });
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-dynamic-projects-v1', now);
      }
      if (!appliedMigrations.has('20261018-article-attribution-v1')) {
        connection.exec("ALTER TABLE blog_articles ADD COLUMN original_author TEXT NOT NULL DEFAULT ''; ALTER TABLE blog_articles ADD COLUMN original_url TEXT NOT NULL DEFAULT ''");
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-article-attribution-v1', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261018-friend-feed-cache-v1')) {
        connection.exec(`CREATE TABLE friend_feed_cache (
          friend_id INTEGER PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
          rss_url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', entry_url TEXT NOT NULL DEFAULT '',
          published_at TEXT, checked_at TEXT NOT NULL
        )`);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261018-friend-feed-cache-v1', new Date().toISOString());
      }
      connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS friends_active_url_idx ON friends(url) WHERE deleted_at IS NULL');
      connection.exec('CREATE INDEX IF NOT EXISTS friends_public_idx ON friends(visible, created_at ASC)');
      if (!friendsInitialized) {
        const now = new Date().toISOString();
        connection.prepare(`INSERT INTO friends (name, url, description, icon_url, visible, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
          '楹雾镇', 'https://yingwutown.top/', '我的世界玩家社区',
          'https://yingwutown.top/images/optimized/group/1.jpg', now, now,
        );
      }
      connection.prepare(`UPDATE friends SET description = ?, updated_at = ?
        WHERE deleted_at IS NULL AND name = '楹雾镇' AND url IN ('https://yingwutown.top', 'https://yingwutown.top/')
          AND description = '与这个博客彼此照看的另一座小镇。'`).run('我的世界玩家社区', new Date().toISOString());
      connection.prepare(`UPDATE friends SET url = 'https://yingwutown.top/', updated_at = ?
        WHERE deleted_at IS NULL AND url = 'https://yingwutown.top'
          AND NOT EXISTS (SELECT 1 FROM friends AS existing WHERE existing.url = 'https://yingwutown.top/')`).run(new Date().toISOString());
      connection.prepare(`UPDATE friends SET icon_url = ?, updated_at = ?
        WHERE deleted_at IS NULL AND url IN ('https://yingwutown.top', 'https://yingwutown.top/')
          AND icon_url = 'https://yingwutown.top/favicon.ico'`).run(
        'https://yingwutown.top/images/optimized/group/1.jpg', new Date().toISOString(),
      );
    })();
  } catch (error) {
    connection.close();
    throw error;
  }
  database = connection;
  return database;
}

function mapRow(row: Record<string, unknown>): MessageRecord {
  return {
    id: Number(row.id),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    nickname: String(row.nickname),
    content: String(row.content),
    status: String(row.status) as MessageStatus,
    createdAt: new Date(String(row.created_at).includes('T') ? String(row.created_at) : `${String(row.created_at).replace(' ', 'T')}Z`).toISOString(),
  };
}

// 先截取根留言，再查询对应回复，避免窗口截断父子关系
function listMessageThreads(limit: number, publishedOnly: boolean) {
  const visibility = publishedOnly ? "AND status = 'published'" : '';
  const roots = getDatabase().prepare(`SELECT id, parent_id, nickname, content, status, created_at
    FROM messages WHERE parent_id IS NULL AND deleted_at IS NULL ${visibility}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  if (roots.length === 0) return [];
  const rootIds = roots.map((row) => Number(row.id));
  const replies = getDatabase().prepare(`SELECT id, parent_id, nickname, content, status, created_at
    FROM messages WHERE deleted_at IS NULL ${visibility} AND parent_id IN (${rootIds.map(() => '?').join(',')})
    ORDER BY created_at ASC, id ASC`).all(...rootIds) as Record<string, unknown>[];
  return [...roots, ...replies].map(mapRow);
}

export function listPublishedMessages(limit = 60) {
  const records = listMessageThreads(limit, true);
  const parents = records.filter((message) => message.parentId === null);
  for (const parent of parents) parent.replies = records.filter((reply) => reply.parentId === parent.id);
  return parents;
}

export function listAllMessages(limit = 200) {
  return listMessageThreads(limit, false);
}

export function hasRecentSubmission(fingerprintHash: string, seconds = serverConfig.messageCooldownSeconds) {
  const row = getDatabase()
    .prepare(`SELECT 1 FROM messages
      WHERE fingerprint_hash = ? AND datetime(created_at) >= datetime('now', ?)
      LIMIT 1`)
    .get(fingerprintHash, `-${seconds} seconds`);
  return Boolean(row);
}

export function createMessage(input: {
  parentId?: number | null;
  nickname: string;
  content: string;
  fingerprintHash: string;
}) {
  if (input.parentId) {
    const parent = getDatabase().prepare(`SELECT id FROM messages WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL AND status = 'published'`).get(input.parentId);
    if (!parent) throw new HttpError(404, '回复的留言不存在');
  }
  const result = getDatabase()
    .prepare(`INSERT INTO messages (parent_id, nickname, content, fingerprint_hash)
      VALUES (?, ?, ?, ?)`)
    .run(input.parentId || null, input.nickname, input.content, input.fingerprintHash);
  return Number(result.lastInsertRowid);
}

export function updateMessageStatus(id: number, status: MessageStatus) {
  return getDatabase().prepare('UPDATE messages SET status = ? WHERE id = ? AND deleted_at IS NULL').run(status, id).changes === 1;
}

export function createAdminReply(parentId: number, content: string) {
  const parent = getDatabase().prepare(`SELECT id FROM messages WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL`).get(parentId);
  if (!parent) throw new HttpError(404, '留言不存在');
  const result = getDatabase()
    .prepare(`INSERT INTO messages (parent_id, nickname, content, status, fingerprint_hash)
      VALUES (?, 'Sam', ?, 'published', 'admin')`)
    .run(parentId, content);
  return Number(result.lastInsertRowid);
}

export function deleteMessage(id: number) {
  return getDatabase().transaction(() => {
    const timestamp = new Date().toISOString();
    const result = getDatabase().prepare('UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(timestamp, id);
    if (result.changes === 1) getDatabase().prepare('UPDATE messages SET deleted_at = ? WHERE parent_id = ? AND deleted_at IS NULL').run(timestamp, id);
    return result.changes === 1;
  })();
}

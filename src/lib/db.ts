import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config/server';
import { siteConfig } from '../config/site';
import { HttpError } from './http';

export type MessageStatus = 'pending' | 'published' | 'hidden';

export interface MessageRecord {
  id: number;
  articleId?: number | null;
  isAdmin?: boolean;
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
      // 旧域名只作为迁移源保留，包含隐藏内容，恢复后仍使用新地址
      if (!appliedMigrations.has('20261022-moesam-domain')) {
        // 冲突时优先保留新域名记录，其余记录软删除后迁移地址，保留身份和内容。
        const conflicts = connection.prepare(`WITH ranked AS (
          SELECT id, first_value(id) OVER (
            PARTITION BY replace(url, 'yingwutown.top', 'moesam.com')
            ORDER BY (instr(url, 'yingwutown.top') > 0), id
          ) AS retained_id FROM friends WHERE deleted_at IS NULL
        ) SELECT id FROM ranked WHERE id != retained_id ORDER BY id`).all() as Array<{ id: number }>;
        if (conflicts.length) {
          const retire = connection.prepare('UPDATE friends SET deleted_at = ? WHERE id = ?');
          const timestamp = new Date().toISOString();
          for (const conflict of conflicts) {
            retire.run(timestamp, conflict.id);
          }
        }
        const domainColumns: Record<string, string[]> = {
          friends: ['url', 'icon_url', 'background_url', 'rss_url', 'description'],
          blog_articles: ['cover_url', 'content', 'original_url'],
          blog_projects: ['url', 'description'],
          project_settings: ['url', 'description'],
          site_settings: ['value'],
          messages: ['content'],
          friend_feed_cache: ['rss_url', 'entry_url'],
        };
        for (const [table, columns] of Object.entries(domainColumns)) {
          for (const column of columns) {
            connection.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE instr(${column}, ?) > 0`)
              .run('yingwutown.top', 'moesam.com', 'yingwutown.top');
          }
        }
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261022-moesam-domain', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261023-media-library')) {
        connection.exec(`CREATE TABLE blog_media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          original_name TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
          byte_size INTEGER NOT NULL CHECK(byte_size > 0),
          created_at TEXT NOT NULL,
          deleted_at TEXT
        )`);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261023-media-library', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261024-article-tags')) {
        connection.exec(`ALTER TABLE blog_articles ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(tags) AND json_type(tags) = 'array')`);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261024-article-tags', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261024-article-card-layout')) {
        connection.exec(`ALTER TABLE blog_articles ADD COLUMN card_layout TEXT NOT NULL DEFAULT 'left'
          CHECK(card_layout IN ('left','right','text'))`);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261024-article-card-layout', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261024-article-content-types')) {
        connection.exec(`ALTER TABLE blog_articles ADD COLUMN content_type TEXT NOT NULL DEFAULT 'article'
          CHECK(content_type IN ('article','note','link','update'));
          ALTER TABLE blog_articles ADD COLUMN external_url TEXT NOT NULL DEFAULT ''
          CHECK(content_type != 'link' OR length(trim(external_url)) > 0)`);
        connection.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('20261024-article-content-types', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261024-sponsors')) {
        connection.exec(`CREATE TABLE blog_sponsors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL CHECK(length(trim(name)) > 0),
          minecraft_username TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents) = 'integer' AND amount_cents > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
        );
        CREATE UNIQUE INDEX blog_sponsors_active_name_idx ON blog_sponsors(name COLLATE NOCASE) WHERE deleted_at IS NULL`);
        const now = new Date().toISOString();
        const insert = connection.prepare('INSERT INTO blog_sponsors (name,minecraft_username,amount_cents,created_at,updated_at) VALUES (?,?,?,?,?)');
        for (const sponsor of siteConfig.sponsors) insert.run(sponsor.name, sponsor.name, Math.round(sponsor.amount * 100), now, now);
        connection.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run('20261024-sponsors', now);
      }
      if (!appliedMigrations.has('20261024-publishing-interactions')) {
        connection.exec(`
          ALTER TABLE blog_articles ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'published' CHECK(publication_status IN ('draft','published'));
          ALTER TABLE blog_articles ADD COLUMN summary TEXT NOT NULL DEFAULT '';
          CREATE TABLE blog_article_drafts (
            id TEXT PRIMARY KEY, article_id INTEGER UNIQUE REFERENCES blog_articles(id),
            payload TEXT NOT NULL CHECK(json_valid(payload)), revision INTEGER NOT NULL CHECK(revision > 0), updated_at TEXT NOT NULL
          );
          ALTER TABLE messages ADD COLUMN article_id INTEGER REFERENCES blog_articles(id);
          ALTER TABLE messages ADD COLUMN email TEXT NOT NULL DEFAULT '';
          ALTER TABLE messages ADD COLUMN notify_reply INTEGER NOT NULL DEFAULT 0 CHECK(notify_reply IN (0,1));
          CREATE INDEX messages_article_idx ON messages(article_id, status, created_at);
          CREATE TABLE article_reactions (
            article_id INTEGER NOT NULL REFERENCES blog_articles(id), visitor_hash TEXT NOT NULL,
            reaction TEXT NOT NULL CHECK(reaction IN ('like','helpful','inspired')), updated_at TEXT NOT NULL,
            PRIMARY KEY(article_id, visitor_hash)
          );
          CREATE TABLE article_daily_visitors (
            article_id INTEGER NOT NULL REFERENCES blog_articles(id), day TEXT NOT NULL, visitor_hash TEXT NOT NULL,
            views INTEGER NOT NULL DEFAULT 1 CHECK(views > 0), PRIMARY KEY(article_id, day, visitor_hash)
          );
          CREATE TABLE friend_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, description TEXT NOT NULL,
            icon_url TEXT NOT NULL, rss_url TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
            fingerprint_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
          );
          CREATE UNIQUE INDEX friend_applications_pending_url_idx ON friend_applications(url) WHERE status = 'pending' AND deleted_at IS NULL;
          CREATE INDEX friend_applications_rate_idx ON friend_applications(fingerprint_hash, created_at);
          CREATE TABLE reply_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id),
            reply_id INTEGER NOT NULL REFERENCES messages(id), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(message_id, reply_id)
          );
        `);
        connection.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run('20261024-publishing-interactions', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261025-draft-notification-recovery')) {
        connection.exec(`ALTER TABLE blog_article_drafts ADD COLUMN deleted_at TEXT;
          ALTER TABLE reply_notifications ADD COLUMN retry_at TEXT NOT NULL DEFAULT '';
          ALTER TABLE reply_notifications ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''`);
        connection.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run('20261025-draft-notification-recovery', new Date().toISOString());
      }
      if (!appliedMigrations.has('20261025-notification-request-payload')) {
        connection.exec("ALTER TABLE reply_notifications ADD COLUMN request_payload TEXT NOT NULL DEFAULT ''");
        connection.prepare('INSERT INTO schema_migrations (id,applied_at) VALUES (?,?)').run('20261025-notification-request-payload', new Date().toISOString());
      }
      connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS friends_active_url_idx ON friends(url) WHERE deleted_at IS NULL');
      connection.exec('CREATE INDEX IF NOT EXISTS blog_articles_type_created_idx ON blog_articles(content_type, created_at DESC, id DESC) WHERE deleted_at IS NULL');
      connection.exec('CREATE INDEX IF NOT EXISTS friends_public_idx ON friends(visible, created_at ASC)');
      if (!friendsInitialized) {
        const now = new Date().toISOString();
        connection.prepare(`INSERT INTO friends (name, url, description, icon_url, visible, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
          '楹雾镇', 'https://moesam.com/', '我的世界玩家社区',
          'https://moesam.com/images/optimized/group/1.jpg', now, now,
        );
      }
      connection.prepare(`UPDATE friends SET description = ?, updated_at = ?
        WHERE deleted_at IS NULL AND name = '楹雾镇' AND url IN ('https://moesam.com', 'https://moesam.com/')
          AND description = '与这个博客彼此照看的另一座小镇。'`).run('我的世界玩家社区', new Date().toISOString());
      connection.prepare(`UPDATE friends SET url = 'https://moesam.com/', updated_at = ?
        WHERE deleted_at IS NULL AND url = 'https://moesam.com'
          AND NOT EXISTS (SELECT 1 FROM friends AS existing WHERE existing.url = 'https://moesam.com/')`).run(new Date().toISOString());
      connection.prepare(`UPDATE friends SET icon_url = ?, updated_at = ?
        WHERE deleted_at IS NULL AND url IN ('https://moesam.com', 'https://moesam.com/')
          AND icon_url = 'https://moesam.com/favicon.ico'`).run(
        'https://moesam.com/images/optimized/group/1.jpg', new Date().toISOString(),
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
    articleId: row.article_id == null ? null : Number(row.article_id),
    isAdmin: Boolean(row.is_admin),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    nickname: String(row.nickname),
    content: String(row.content),
    status: String(row.status) as MessageStatus,
    createdAt: new Date(String(row.created_at).includes('T') ? String(row.created_at) : `${String(row.created_at).replace(' ', 'T')}Z`).toISOString(),
  };
}

// 先截取根留言，再查询对应回复，避免窗口截断父子关系
function listMessageThreads(limit: number, publishedOnly: boolean, articleId: number | null = null) {
  const visibility = publishedOnly ? "AND status = 'published'" : '';
  const scope = publishedOnly ? 'AND article_id IS ?' : '';
  const parameters = publishedOnly ? [articleId, limit] : [limit];
  const roots = getDatabase().prepare(`SELECT id, article_id, parent_id, nickname, content, status, created_at, fingerprint_hash = 'admin' AS is_admin
    FROM messages WHERE parent_id IS NULL AND deleted_at IS NULL ${visibility} ${scope}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[];
  if (roots.length === 0) return [];
  const replies = getDatabase().prepare(`SELECT id, article_id, parent_id, nickname, content, status, created_at, fingerprint_hash = 'admin' AS is_admin
    FROM messages WHERE deleted_at IS NULL ${visibility} AND parent_id IN (
      SELECT id FROM messages WHERE parent_id IS NULL AND deleted_at IS NULL ${visibility} ${scope}
      ORDER BY created_at DESC, id DESC LIMIT ?
    ) ORDER BY created_at ASC, id ASC`).all(...parameters) as Record<string, unknown>[];
  return [...roots, ...replies].map(mapRow);
}

export function listPublishedMessages(limit = 60, articleId: number | null = null) {
  const records = listMessageThreads(limit, true, articleId);
  const parents = records.filter((message) => message.parentId === null);
  for (const parent of parents) parent.replies = records.filter((reply) => reply.parentId === parent.id);
  return parents;
}

export function listAllMessages(limit = -1) {
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
  articleId?: number | null;
  email?: string;
  notifyReply?: boolean;
  nickname: string;
  content: string;
  fingerprintHash: string;
}) {
  const articleId = input.articleId || null;
  if (articleId && !getDatabase().prepare("SELECT 1 FROM blog_articles WHERE id = ? AND deleted_at IS NULL AND publication_status = 'published'").get(articleId)) throw new HttpError(404, '文章不存在');
  if (input.parentId) {
    const parent = getDatabase().prepare(`SELECT id FROM messages WHERE id = ? AND article_id IS ? AND parent_id IS NULL AND deleted_at IS NULL AND status = 'published'`).get(input.parentId, articleId);
    if (!parent) throw new HttpError(404, '回复的留言不存在');
  }
  const result = getDatabase()
    .prepare(`INSERT INTO messages (parent_id, article_id, nickname, content, fingerprint_hash, status, email, notify_reply)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.parentId || null, articleId, input.nickname, input.content, input.fingerprintHash, articleId ? 'published' : 'pending', input.email || '', Number(Boolean(input.email && input.notifyReply)));
  return Number(result.lastInsertRowid);
}

export function updateMessageStatus(id: number, status: MessageStatus) {
  return getDatabase().prepare('UPDATE messages SET status = ? WHERE id = ? AND deleted_at IS NULL').run(status, id).changes === 1;
}

export function createAdminReply(parentId: number, content: string) {
  const parent = getDatabase().prepare(`SELECT id, article_id FROM messages WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL`).get(parentId) as { id: number; article_id: number | null } | undefined;
  if (!parent) throw new HttpError(404, '留言不存在');
  const result = getDatabase()
    .prepare(`INSERT INTO messages (parent_id, article_id, nickname, content, status, fingerprint_hash)
      VALUES (?, ?, 'Sam', ?, 'published', 'admin')`)
    .run(parentId, parent.article_id, content);
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

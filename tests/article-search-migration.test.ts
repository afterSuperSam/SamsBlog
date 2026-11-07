import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('backfills a legacy catalog once, excludes private rows and reopens the migration idempotently', async () => {
  vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-search-migration-')));
  vi.resetModules();
  let database = (await import('../src/lib/db')).getDatabase();
  try {
    const insert = database.prepare(`INSERT INTO blog_articles (title,cover_url,source,category,content,created_at,updated_at,publication_status,deleted_at)
      VALUES (?,'','original','discussion',?,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',?,?)`);
    insert.run('旧版公开', '旧版公开正文', 'published', null);
    insert.run('旧版草稿', '不能检索私有正文', 'draft', null);
    insert.run('旧版删除', '不能检索删除正文', 'published', '2026-11-02T00:00:00Z');
    database.exec(`DROP TRIGGER blog_article_search_insert; DROP TRIGGER blog_article_search_update; DROP TRIGGER blog_article_search_delete;
      DROP TABLE blog_article_search_fts; DROP TABLE blog_article_search; DROP TABLE blog_article_search_pending;
      DROP INDEX blog_articles_catalog_created_idx; DROP INDEX blog_articles_catalog_updated_idx;
      DROP INDEX blog_articles_catalog_starred_idx; DROP INDEX blog_articles_catalog_month_idx;
      DELETE FROM schema_migrations WHERE id='20261107-article-search-pagination';`);
    database.close();
    vi.resetModules();
    const markdown = await import('../src/lib/markdown');
    const render = vi.spyOn(markdown, 'articlePlainText');
    database = (await import('../src/lib/db')).getDatabase();
    expect(render).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT article_id, plain_text FROM blog_article_search').all()).toEqual([{ article_id: 1, plain_text: '旧版公开  旧版公开正文' }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM blog_articles').get()).toEqual({ count: 3 });
    render.mockRestore();
    database.close();
    vi.resetModules();
    const nextMarkdown = await import('../src/lib/markdown');
    const nextRender = vi.spyOn(nextMarkdown, 'articlePlainText');
    database = (await import('../src/lib/db')).getDatabase();
    expect(nextRender).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id='20261107-article-search-pagination'").get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT article_id FROM blog_article_search').all()).toEqual([{ article_id: 1 }]);
    nextRender.mockRestore();
  } finally {
    if (database.open) database.close();
    vi.unstubAllEnvs();
  }
});

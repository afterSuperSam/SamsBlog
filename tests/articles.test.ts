import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { APIContext, APIRoute } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/config/server';
import { siteConfig } from '../src/config/site';
import { createAdminSession } from '../src/lib/admin-auth';
import { deleteArticle, getArticle, getAdjacentArticles, getArticlePublicationCounts, getArticleUpdates, getNextFeaturedLink, listArticleMetadata, listArticles, listHomepageArticles, restoreArticle, saveArticle } from '../src/lib/articles';
import { getDatabase } from '../src/lib/db';
import { DELETE, GET, PATCH, POST } from '../src/pages/api/admin/articles.json';
import { getProjectSettings, getProjectCommit, saveProjectSettings } from '../src/lib/projects';
import { PUT as saveProjects } from '../src/pages/api/admin/projects.json';
import { GET as getRss } from '../src/pages/rss.xml';
import { GET as getSiteCard } from '../src/pages/api/public/site-card.json';
import { GET as getFeaturedLink } from '../src/pages/api/public/featured-link.json';
import { listArticleDrafts, saveArticleDraft, publishArticleDraft, deleteArticleDraft, restoreArticleDraft } from '../src/lib/article-drafts';
import { searchArticleIds, withdrawArticle } from '../src/lib/articles';

const input = { title: '验证文章', coverUrl: 'https://images.example.com/cover.webp', source: 'original', category: 'discussion', content: '# 正文\n\n[链接](https://example.com)\n\n![图片](https://images.example.com/body.webp)' };

beforeAll(async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'samsblog-articles-'));
  vi.stubEnv('BLOG_DATA_DIR', dataDirectory);
  const legacy = new Database(path.join(dataDirectory, 'blog.sqlite'));
  legacy.exec("CREATE TABLE articles (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO articles VALUES (1, '历史记录');");
  legacy.close();
});

async function call(handler: APIRoute, method: string, body?: unknown, authorized = true, headers: Record<string, string> = {}) {
  return handler({
    request: new Request('https://blog.example.com/api/admin/articles.json', {
      method, headers: { 'content-type': 'application/json', origin: 'https://blog.example.com', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    cookies: { get: () => authorized ? { value: createAdminSession() } : undefined },
  } as unknown as APIContext) as Promise<Response>;
}

describe('article persistence and authenticated management', () => {
  it('starts empty and preserves retired article data without publishing it', () => {
    expect(listArticles({ includeDeleted: true })).toEqual([]);
    expect(getDatabase().prepare('SELECT * FROM articles').all()).toEqual([{ id: 1, title: '历史记录' }]);
    expect(getDatabase().prepare("SELECT id FROM schema_migrations WHERE id = '20261017-blog-articles-v1'").get()).toBeTruthy();
  });

  it('cycles through public links, skips deleted items and wraps to the newest link', () => {
    const first = saveArticle({ ...input, contentType: 'link', externalUrl: 'https://example.com/first' });
    const removed = saveArticle({ ...input, contentType: 'link', externalUrl: 'https://example.com/removed' });
    const last = saveArticle({ ...input, contentType: 'link', externalUrl: 'https://example.com/last' });
    deleteArticle(removed);
    try {
      expect(getNextFeaturedLink(last)?.id).toBe(first);
      expect(getNextFeaturedLink(first)?.id).toBe(last);
      deleteArticle(last);
      expect(getNextFeaturedLink(first)?.id).toBe(first);
    } finally { [first, removed, last].forEach(deleteArticle); }
  });

  it('stars content independently of publication, dates and unpublished edits', async () => {
    const id = saveArticle(input);
    const initial = getArticle(id)!;
    const draft = saveArticleDraft({ ...initial, title: '未发布修改', draftId: randomUUID(), revision: 0 });
    try {
      expect(initial.starred).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++) expect((await call(PATCH, 'PATCH', { id, starred: true })).status).toBe(200);
      expect(getArticle(id)).toEqual({ ...initial, starred: true });
      expect(listArticleDrafts().find((item) => item.draftId === draft.draftId)).toEqual(draft);
      publishArticleDraft(draft);
      expect(getArticle(id)).toMatchObject({ title: '未发布修改', starred: true });
      withdrawArticle(id);
      expect((await call(PATCH, 'PATCH', { id, starred: false })).status).toBe(200);
      expect(getArticle(id)).toBeUndefined();
      expect(getArticle(id, { includeDrafts: true })).toMatchObject({ starred: false, publicationStatus: 'draft' });
    } finally { deleteArticle(id); }
  });

  it('guards star updates and preserves them through deletion and restoration', async () => {
    const id = saveArticle(input);
    try {
      expect((await call(PATCH, 'PATCH', { id, starred: true }, false)).status).toBe(401);
      expect((await call(PATCH, 'PATCH', { id, starred: true }, true, { origin: 'https://untrusted.example' })).status).toBe(403);
      for (const starred of ['true', 1, null, {}]) expect((await call(PATCH, 'PATCH', { id, starred })).status).toBe(400);
      expect(getArticle(id)?.starred).toBe(false);
      expect((await call(PATCH, 'PATCH', { id, starred: true })).status).toBe(200);
      deleteArticle(id);
      expect((await call(PATCH, 'PATCH', { id, starred: false })).status).toBe(404);
      restoreArticle(id);
      expect(getArticle(id)?.starred).toBe(true);
      expect(() => getDatabase().prepare('UPDATE blog_articles SET starred = 2 WHERE id = ?').run(id)).toThrow();
    } finally { deleteArticle(id); }
  });

  it('returns complete sanitized explanations and star state when shuffling external links', async () => {
    const explanation = '需要完整保留的长链接说明。'.repeat(100);
    const id = saveArticle({ ...input, contentType: 'link', externalUrl: 'https://example.com', content: `第一段\n\n第二段 [引用](https://example.com/read)\n\n${explanation}\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))` });
    try {
      await call(PATCH, 'PATCH', { id, starred: true });
      const response = await getFeaturedLink({ url: new URL('https://blog.example.com/api/public/featured-link.json?after=999999') } as APIContext) as Response;
      const { article } = await response.json();
      expect(article).toMatchObject({ id, starred: true });
      expect(article.html).toContain('<p>第二段');
      expect(article.html).toContain(explanation);
      expect(article.html).toContain('href="https://example.com/read"');
      expect(article.html).not.toContain('<script>');
      expect(article.html).not.toContain('href="javascript:');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    } finally { deleteArticle(id); }
  });

  it('shuffles only published undeleted external links and does not expose private explanations', async () => {
    const identifiers = [
      saveArticle({ ...input, contentType: 'link', externalUrl: 'https://public.example/', content: '公开外链的说明' }),
      saveArticle({ ...input, contentType: 'link', externalUrl: 'https://deleted.example/', content: '已删外链的私有标记' }),
      saveArticle({ ...input, contentType: 'link', externalUrl: 'https://draft.example/', content: '撤回外链的私有标记' }),
      saveArticle({ ...input, contentType: 'article', content: '长文章不会混入精选外链' }),
    ];
    try {
      deleteArticle(identifiers[1]);
      withdrawArticle(identifiers[2]);
      const response = await getFeaturedLink({ url: new URL(`https://blog.example.com/api/public/featured-link.json?after=${identifiers[2]}`) } as APIContext) as Response;
      const serialized = await response.text();
      expect(JSON.parse(serialized).article).toMatchObject({ id: identifiers[0], externalUrl: 'https://public.example/' });
      expect(serialized).not.toContain('私有标记');
      expect(serialized).not.toContain('长文章不会混入');
    } finally { identifiers.forEach((id) => deleteArticle(id)); }
  });
  it.each(['article', 'note', 'link', 'update'])('preserves the %s content type and destination through older clients, deletion and restoration', (contentType) => {
    const externalUrl = contentType === 'link' ? 'https://example.com/read?chapter=1&part=2' : '';
    const id = saveArticle({ ...input, contentType, externalUrl });
    const createdAt = getArticle(id)!.createdAt;
    saveArticle({ ...input, id, title: '保留内容形式' });
    expect(getArticle(id)).toMatchObject({ contentType, externalUrl, createdAt });
    deleteArticle(id);
    expect(getArticle(id)).toBeUndefined();
    restoreArticle(id);
    expect(getArticle(id)).toMatchObject({ contentType, externalUrl, createdAt });
    saveArticle({ ...input, id, contentType: 'article' });
    expect(getArticle(id)).toMatchObject({ contentType: 'article', externalUrl: '' });
    deleteArticle(id);
  });

  it('keeps bounded homepage groups independent and never fills them with deleted content', () => {
    const identifiers: number[] = [];
    try {
      const types = ['article', 'note', 'update', 'link'] as const;
      const count = Math.max(siteConfig.articles.homepageCount, siteConfig.articles.homepageNoteCount, siteConfig.articles.homepageLinkCount) + 1;
      for (let index = 0; index < count; index += 1) {
        for (const contentType of types) identifiers.push(saveArticle({ ...input, contentType, externalUrl: 'https://example.com/' }));
      }
      const deletedLink = identifiers.at(-1)!;
      deleteArticle(deletedLink);
      const homepage = listHomepageArticles();
      expect(homepage.filter((article) => article.contentType === 'article')).toHaveLength(siteConfig.articles.homepageCount);
      expect(homepage.filter((article) => article.contentType === 'note' || article.contentType === 'update')).toHaveLength(siteConfig.articles.homepageNoteCount);
      expect(homepage.filter((article) => article.contentType === 'link')).toHaveLength(siteConfig.articles.homepageLinkCount);
      expect(homepage.some((article) => article.id === deletedLink)).toBe(false);
      const records = listArticles({ contentTypes: ['note', 'update'], limit: 2 });
      expect(records.map((article) => article.id)).toEqual([identifiers.at(-2), identifiers.at(-3)]);
      expect(listArticles({ contentTypes: [] })).toEqual([]);
    } finally { identifiers.forEach(deleteArticle); }
  });

  it('rejects invalid content types and unsafe or missing destinations without changing saved data', async () => {
    const id = saveArticle(input);
    expect(getArticle(id)).toMatchObject({ contentType: 'article', externalUrl: '' });
    for (const contentType of ['unknown', '', null, 1]) {
      expect((await call(PATCH, 'PATCH', { ...input, id, contentType })).status).toBe(400);
    }
    for (const externalUrl of ['', 'javascript:alert(1)', 'data:text/html,hello', '//example.com', 'https://user:secret@example.com', 1]) {
      expect((await call(PATCH, 'PATCH', { ...input, id, contentType: 'link', externalUrl })).status).toBe(400);
    }
    expect(getArticle(id)).toMatchObject({ contentType: 'article', externalUrl: '' });
    expect(() => getDatabase().prepare('UPDATE blog_articles SET content_type = ? WHERE id = ?').run('unknown', id)).toThrow();
    expect(() => getDatabase().prepare('UPDATE blog_articles SET content_type = ? WHERE id = ?').run('link', id)).toThrow();
    deleteArticle(id);
  });

  it('includes the external destination and full explanation in RSS with XML escaping', async () => {
    const id = saveArticle({ ...input, contentType: 'link', externalUrl: 'https://example.com/?first=1&second=2', content: '推荐的完整说明。' });
    const feed = await (getRss({ request: new Request('https://blog.example.com/rss.xml') } as APIContext) as Response).text();
    expect(feed).toContain('<category>外部链接</category>');
    expect(feed).toContain('https://example.com/?first=1&amp;amp;second=2');
    expect(feed).toContain('推荐的完整说明。');
    deleteArticle(id);
  });

  it('does not count notes, external links or updates as long articles in the contribution graph', () => {
    const before = getArticlePublicationCounts().reduce((total, day) => total + day.count, 0);
    const identifiers = ['note', 'link', 'update'].map((contentType) => saveArticle({ ...input, contentType, externalUrl: 'https://example.com/' }));
    expect(getArticlePublicationCounts().reduce((total, day) => total + day.count, 0)).toBe(before);
    identifiers.forEach(deleteArticle);
  });

  it('counts public articles by Beijing publication date and follows deletion and restoration', () => {
    expect(getArticlePublicationCounts()).toEqual([]);
    const timestamps = ['2026-10-23T15:59:59.999Z', '2026-10-23T16:00:00.000Z', '2026-10-24T09:00:00.000Z'];
    const identifiers = timestamps.map((createdAt) => {
      const id = saveArticle(input);
      getDatabase().prepare('UPDATE blog_articles SET created_at = ? WHERE id = ?').run(createdAt, id);
      return id;
    });
    try {
      const expected = [{ date: '2026-10-23', count: 1 }, { date: '2026-10-24', count: 2 }];
      expect(getArticlePublicationCounts()).toEqual(expected);
      saveArticle({ ...input, id: identifiers[0], title: '编辑不会改变发布日期' });
      expect(getArticlePublicationCounts()).toEqual(expected);
      deleteArticle(identifiers[2]);
      expect(getArticlePublicationCounts()).toEqual([{ date: '2026-10-23', count: 1 }, { date: '2026-10-24', count: 1 }]);
      restoreArticle(identifiers[2]);
      expect(getArticlePublicationCounts()).toEqual(expected);
    } finally {
      identifiers.forEach(deleteArticle);
    }
  });

  it('stores repost attribution separately, clears it for originals and preserves source whitespace', () => {
    const content = '\n  保留原始空白\n\n```js\n\treturn 1;\n```\n';
    const id = saveArticle({ ...input, source: 'repost', originalAuthor: ' 原作者 ', originalUrl: 'https://example.com/original?a=1&b=2', content });
    expect(getArticle(id)).toMatchObject({ originalAuthor: '原作者', originalUrl: 'https://example.com/original?a=1&b=2', content });
    saveArticle({ ...input, id, originalAuthor: '应清空', originalUrl: 'javascript:ignored' });
    expect(getArticle(id)).toMatchObject({ originalAuthor: '', originalUrl: '' });
  });

  it('stores tags, preserves them for older editors, and restores them after soft deletion', () => {
    const id = saveArticle({ ...input, tags: [' # TinyML ', 'tinyml', '日常'] });
    const createdAt = getArticle(id)!.createdAt;
    expect(getArticle(id)?.tags).toEqual(['TinyML', '日常']);
    saveArticle({ ...input, id, title: '编辑后' });
    expect(getArticle(id)?.tags).toEqual(['TinyML', '日常']);
    expect(deleteArticle(id)).toBe(true);
    expect(getArticle(id)).toBeUndefined();
    expect(restoreArticle(id)).toBe(true);
    expect(getArticle(id)).toMatchObject({ tags: ['TinyML', '日常'], createdAt });
    saveArticle({ ...input, id, tags: [] });
    expect(getArticle(id)?.tags).toEqual([]);
    expect(() => getDatabase().prepare('UPDATE blog_articles SET tags = ? WHERE id = ?').run('{}', id)).toThrow();
    expect(getArticle(id)?.tags).toEqual([]);
    deleteArticle(id);
  });

  it('rejects malformed tag requests without adding articles', async () => {
    const before = listArticles({ includeDeleted: true }).length;
    const response = await call(POST, 'POST', { ...input, tags: ['a,b'] });
    expect(response.status).toBe(400);
    expect(listArticles({ includeDeleted: true })).toHaveLength(before);
    const id = saveArticle(input);
    expect(getArticle(id)?.tags).toEqual([]);
    deleteArticle(id);
  });

  it('defaults to left covers and preserves selected layouts, covers and dates through edits and restoration', () => {
    const id = saveArticle(input);
    const createdAt = getArticle(id)!.createdAt;
    expect(getArticle(id)?.cardLayout).toBe('left');
    saveArticle({ ...input, id, cardLayout: 'right' });
    saveArticle({ ...input, id, title: '旧编辑器保留布局' });
    expect(getArticle(id)).toMatchObject({ cardLayout: 'right', createdAt });
    saveArticle({ ...input, id, cardLayout: 'text' });
    deleteArticle(id);
    expect(getArticle(id)).toBeUndefined();
    restoreArticle(id);
    expect(getArticle(id)).toMatchObject({ cardLayout: 'text', coverUrl: input.coverUrl, createdAt });
    expect(() => getDatabase().prepare('UPDATE blog_articles SET card_layout = ? WHERE id = ?').run('automatic', id)).toThrow();
    deleteArticle(id);
  });

  it('rejects invalid card layouts without changing saved content', async () => {
    const id = saveArticle({ ...input, cardLayout: 'right' });
    for (const cardLayout of ['automatic', '', null, 1, {}]) {
      expect((await call(PATCH, 'PATCH', { ...input, id, cardLayout })).status).toBe(400);
    }
    expect(getArticle(id)?.cardLayout).toBe('right');
    deleteArticle(id);
  });

  it.each(['javascript:alert(1)', 'https://name:password@example.com', '//example.com', 'https:example.com', 'file:///tmp/article'])('rejects unsafe or incomplete repost URLs: %s', (originalUrl) => {
    expect(() => saveArticle({ ...input, source: 'repost', originalUrl })).toThrow();
  });

  it('publishes on save, preserves creation date, and hides soft-deleted records until restored', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-17T01:00:00Z'));
      const id = saveArticle(input);
      const original = getArticle(id)!;
      expect(original).toMatchObject({ ...input, id, createdAt: '2026-10-17T01:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z', deletedAt: null });
      vi.setSystemTime(new Date('2026-10-18T01:00:00Z'));
      expect(saveArticle({ ...input, id, title: '修改题目', coverUrl: '', source: 'repost', category: 'journal' })).toBe(id);
      expect(getArticle(id)).toMatchObject({ title: '修改题目', coverUrl: '', source: 'repost', category: 'journal', createdAt: original.createdAt, updatedAt: '2026-10-18T01:00:00.000Z' });
      expect(deleteArticle(id)).toBe(true);
      expect(getArticle(id)).toBeUndefined();
      expect(listArticles().some((item) => item.id === id)).toBe(false);
      expect(getArticle(id, { includeDeleted: true })?.deletedAt).toBe('2026-10-18T01:00:00.000Z');
      expect(() => saveArticle({ ...input, id })).toThrow('文章不存在或已删除');
      expect(restoreArticle(id)).toBe(true);
      expect(getArticle(id)?.createdAt).toBe(original.createdAt);
      expect(restoreArticle(id)).toBe(false);
      expect(deleteArticle(999999)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('validates lengths, type choices, ids, and public HTTP image addresses', () => {
    for (const invalid of [null, [], { ...input, title: ' ' }, { ...input, content: '' }, { ...input, title: 'a'.repeat(serverConfig.articleTitleMaxLength + 1) }, { ...input, content: 'a'.repeat(serverConfig.articleContentMaxLength + 1) }, { ...input, source: 'unknown' }, { ...input, category: 'unknown' }, { ...input, id: '1' }, { ...input, id: 0 }]) {
      expect(() => saveArticle(invalid)).toThrow();
    }
    for (const coverUrl of [123, 'javascript:alert(1)', 'https:images.example.com/a', 'https://user:secret@example.com/a', 'https://localhost/a', 'http://127.1/a', 'http://192.168.1.1/a', 'http://[::1]/a', 'https://private.local/a']) {
      expect(() => saveArticle({ ...input, coverUrl })).toThrow();
    }
    const id = saveArticle({ ...input, coverUrl: undefined });
    expect(getArticle(id)?.coverUrl).toBe('');
    expect(() => getDatabase().prepare("INSERT INTO blog_articles(title,source,category,content,created_at,updated_at) VALUES('x','invalid','journal','x','x','x')").run()).toThrow();
  });

  it('orders same-date articles newest first', () => {
    const first = saveArticle(input);
    const second = saveArticle(input);
    getDatabase().prepare("UPDATE blog_articles SET created_at = '2026-10-20T00:00:00.000Z' WHERE id IN (?, ?)").run(first, second);
    expect(listArticles().filter((item) => item.id === first || item.id === second).map((item) => item.id)).toEqual([second, first]);
  });

  it('limits public reads in SQL and resolves metadata and adjacent ties without loading bodies', () => {
    const identifiers = Array.from({ length: 25 }, (_, index) => saveArticle({ ...input, title: `查询边界${index}`, content: '正文'.repeat(1000) }));
    for (const identifier of identifiers) getDatabase().prepare("UPDATE blog_articles SET created_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(identifier);
    const hidden = identifiers.at(-1)!;
    deleteArticle(hidden);
    const expected = identifiers.slice(0, -1).reverse();
    const statements = vi.spyOn(getDatabase(), 'prepare');
    try {
      expect(listArticles({ limit: 2 }).map((article) => article.id)).toEqual(expected.slice(0, 2));
      expect(getArticleUpdates(3).map((article) => article.id)).toEqual(expected.slice(0, 3));
      expect(listArticles({ limit: 20 })).toHaveLength(20);
      expect(statements.mock.calls.slice(0, 3).every(([sql]) => /LIMIT \?/.test(sql))).toBe(true);
      statements.mockClear();
      const metadata = listArticleMetadata();
      expect(statements.mock.calls[0][0]).toMatch(/SELECT id, title, updated_at FROM blog_articles/);
      expect(metadata.find((article) => article.id === expected[0])).toEqual({ id: expected[0], title: '查询边界23', updatedAt: getArticle(expected[0])!.updatedAt });
      expect(metadata.some((article) => article.id === hidden)).toBe(false);
      const middle = getArticle(identifiers[10])!;
      statements.mockClear();
      expect(getAdjacentArticles(middle)).toEqual({
        previous: { id: identifiers[9], title: '查询边界9' }, next: { id: identifiers[11], title: '查询边界11' },
      });
      expect(statements.mock.calls.every(([sql]) => /SELECT id, title/.test(sql) && /LIMIT 1/.test(sql))).toBe(true);
      expect(getAdjacentArticles(getArticle(expected[0])!).next).toBeUndefined();
      expect(() => listArticles({ limit: 0 })).toThrow();
      expect(() => listArticles({ limit: -1 })).toThrow();
    } finally {
      statements.mockRestore();
      identifiers.forEach(deleteArticle);
    }
  });

  it('guards every management method and supports create, edit, delete, restore', async () => {
    for (const [handler, method] of [[GET, 'GET'], [POST, 'POST'], [PATCH, 'PATCH'], [DELETE, 'DELETE']] as const) {
      expect((await call(handler, method, method === 'GET' ? undefined : input, false)).status).toBe(401);
    }
    const draft = await (await call(POST, 'POST', { ...input, action: 'draft', draftId: randomUUID(), revision: 0 })).json();
    const created = await call(POST, 'POST', { action: 'publish', ...draft.draft });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const editedDraft = await (await call(POST, 'POST', { ...getArticle(id), title: '后台修改', action: 'draft', draftId: randomUUID(), revision: 0 })).json();
    expect((await call(POST, 'POST', { action: 'publish', ...editedDraft.draft })).status).toBe(201);
    expect(getArticle(id)?.title).toBe('后台修改');
    expect((await call(DELETE, 'DELETE', { id })).status).toBe(200);
    expect(getArticle(id)).toBeUndefined();
    const all = await (await call(GET, 'GET')).json();
    expect(all.articles.find((article: { id: number }) => article.id === id).deletedAt).toBeTruthy();
    expect((await call(PATCH, 'PATCH', { id, restore: true })).status).toBe(200);
    expect(getArticle(id)?.title).toBe('后台修改');
    expect((await call(POST, 'POST', { ...input, id: 999999, action: 'draft', draftId: randomUUID(), revision: 0 })).status).toBe(404);
    expect((await call(POST, 'POST', { ...input, id })).status).toBe(400);
    expect((await call(POST, 'POST', input, true, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('rejects oversized streams even with missing or misleading content length', async () => {
    const oversized = { ...input, content: 'x'.repeat(serverConfig.articleRequestMaxBytes) };
    expect((await call(POST, 'POST', oversized)).status).toBe(413);
    expect((await call(POST, 'POST', oversized, true, { 'content-length': '1' })).status).toBe(413);
    expect((await call(POST, 'POST', input, true, { 'content-length': String(serverConfig.articleRequestMaxBytes + 1) })).status).toBe(413);
  });
});

describe('private drafts and publication boundaries', () => {
  it('saves incomplete work, rejects stale revisions and recovers soft-deleted drafts', () => {
    const draft = saveArticleDraft({ draftId: randomUUID(), revision: 0, title: '', content: '还没写完', coverUrl: 'https://' });
    expect(listArticleDrafts().find((item) => item.draftId === draft.draftId)?.payload.content).toBe('还没写完');
    expect(() => publishArticleDraft(draft)).toThrow();
    expect(() => saveArticleDraft({ ...draft.payload, draftId: draft.draftId, revision: 0 })).toThrow('其他窗口');
    deleteArticleDraft(draft);
    expect(listArticleDrafts().some((item) => item.draftId === draft.draftId)).toBe(false);
    expect(() => publishArticleDraft(draft)).toThrow();
    restoreArticleDraft(draft);
    const restored = listArticleDrafts().find((item) => item.draftId === draft.draftId)!;
    expect(restored.payload.content).toBe('还没写完');
    expect(restored.revision).toBe(draft.revision + 1);
    deleteArticleDraft(restored);
  });
  it('publishes explicitly once, keeps edits private and withdraws from every public source', async () => {
    const draft = saveArticleDraft({ ...input, draftId: randomUUID(), revision: 0, title: '草稿边界唯一标记', summary: '手写摘要', content: '正文检索独有内容' });
    expect(searchArticleIds('正文检索独有内容')).toEqual([]);
    const id = publishArticleDraft(draft);
    expect(getArticle(id)?.summary).toBe('手写摘要');
    expect(searchArticleIds('正文检索独有内容')).toContain(id);
    expect(() => publishArticleDraft(draft)).toThrow();
    const edited = saveArticleDraft({ ...getArticle(id), title: '未发布的修改', draftId: randomUUID(), revision: 0 });
    expect(getArticle(id)?.title).toBe('草稿边界唯一标记');
    expect(withdrawArticle(id)).toBe(true);
    expect(getArticle(id)).toBeUndefined();
    expect(listArticles().some((item) => item.id === id)).toBe(false);
    expect(listArticleMetadata().some((item) => item.id === id)).toBe(false);
    expect(getArticleUpdates(100).some((item) => item.id === id)).toBe(false);
    expect(searchArticleIds('正文检索独有内容')).toEqual([]);
    expect(await (getRss({ request: new Request('https://blog.example.com/rss.xml') } as APIContext) as Response).text()).not.toContain('草稿边界唯一标记');
    expect(() => publishArticleDraft(edited)).toThrow();
    const resumed = listArticleDrafts().find((item) => item.articleId === id)!;
    expect(publishArticleDraft(resumed)).toBe(id);
    expect(getArticle(id)?.title).toBe('未发布的修改');
    deleteArticle(id);
  });
  it('rejects cross-origin publication and catches changed published versions', async () => {
    expect((await call(POST, 'POST', { ...input, action: 'draft', draftId: randomUUID(), revision: 0 }, true, { origin: 'https://other.example.com' })).status).toBe(403);
    const id = saveArticle(input);
    const draft = saveArticleDraft({ ...getArticle(id), draftId: randomUUID(), revision: 0 });
    saveArticle({ ...input, id, title: '另一个窗口已发布' });
    expect(() => publishArticleDraft(draft)).toThrow('其他窗口');
    expect(getArticle(id)?.title).toBe('另一个窗口已发布');
    deleteArticle(id);
  });
});

describe('project settings and automatically refreshed feeds', () => {
  it('keeps status defaults, validates settings atomically, and requires an admin session', async () => {
    const before = getProjectSettings();
    expect(before.projects.map((project) => project.status)).toEqual(['active', 'maintenance', 'active', 'archived']);
    const projects = before.projects.map((project) => ({ ...project }));
    const payload = { currentWork: '最近在做：测试项目', projects };
    payload.projects[0].name = '项目的新名字';
    payload.projects[0].url = 'https://example.com/project';
    payload.projects[0].description = '新的项目简介';
    payload.projects[0].keyword = '';
    expect((await call(saveProjects, 'PUT', payload, false)).status).toBe(401);
    expect((await call(saveProjects, 'PUT', payload)).status).toBe(200);
    expect(getProjectSettings().currentWork).toBe(payload.currentWork);
    expect(getProjectSettings().projects[0]).toMatchObject(payload.projects[0]);
    expect(() => saveProjectSettings({ ...payload, projects: [...projects, projects[0]] })).toThrow();
    expect(() => saveProjectSettings({ ...payload, projects: projects.map((project) => ({ ...project, status: 'unknown' })) })).toThrow();
    expect(() => saveProjectSettings({ ...payload, projects: projects.map((project) => ({ ...project, url: 'javascript:alert(1)' })) })).toThrow();
    expect(() => saveProjectSettings({ ...payload, currentWork: ' ' })).toThrow();
    expect(getProjectSettings().currentWork).toBe(payload.currentWork);
  });

  it('coalesces commit requests and keeps valid dates when GitHub later fails', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ commit: { committer: { date: '2026-10-17T01:02:03Z' } } }])));
    vi.stubGlobal('fetch', request);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const repository = 'afterSuperSam/SamsBlog';
      expect(await Promise.all([getProjectCommit(repository), getProjectCommit(repository)])).toEqual(['2026-10-17T01:02:03.000Z', '2026-10-17T01:02:03.000Z']);
      expect(request).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(serverConfig.githubCacheSeconds * 1000 + 1);
      request.mockResolvedValue(new Response('', { status: 503 }));
      expect(await getProjectCommit(repository)).toBe('2026-10-17T01:02:03.000Z');
      expect(warning).toHaveBeenCalled();
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); warning.mockRestore(); }
  });

  it('updates RSS and cross-site cards after edits and excludes soft-deleted articles', async () => {
    const id = saveArticle({ ...input, title: 'RSS <更新> & "测试"\u000b' });
    const feed = () => getRss({} as APIContext) as Response;
    expect(await feed().text()).toContain('RSS &lt;更新&gt; &amp; &quot;测试&quot;');
    expect(await feed().text()).not.toContain('\u000b');
    expect(feed().headers.get('Cache-Control')).toBe('no-cache');
    saveArticle({ ...input, id, title: '修改后 RSS 标题' });
    expect(await feed().text()).toContain('修改后 RSS 标题');
    const response = await getSiteCard({ request: new Request('https://blog.example/api/public/site-card.json', { headers: { Origin: 'https://moesam.com' } }) } as APIContext) as Response;
    expect((await response.json()).latest.some((article: { id: number }) => article.id === id)).toBe(true);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://moesam.com');
    deleteArticle(id);
    expect(await feed().text()).not.toContain('修改后 RSS 标题');
  });

  it('colors browser source without changing reader responses or executing content', async () => {
    const headers = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };
    const response = getRss({ request: new Request('https://blog.example/rss.xml', { headers }) } as APIContext) as Response;
    const html = await response.text();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('vary')).toBe('Accept, Sec-Fetch-Dest');
    expect(html).toContain('class="rss-source__tag"');
    expect(html).toContain('class="rss-source__attribute"');
    expect(html).not.toContain('<script');
    for (const request of [new Request('https://blog.example/rss.xml?raw', { headers }), new Request('https://blog.example/rss.xml', { headers: { accept: 'text/html' } })]) {
      const raw = getRss({ request } as APIContext) as Response;
      expect(raw.headers.get('content-type')).toContain('application/rss+xml');
      expect(await raw.text()).toMatch(/^<\?xml/);
    }
  });

  it('publishes complete formatted RSS content without expanding cross-site summaries', async () => {
    const content = `# 完整正文\n\n${'正文内容'.repeat(80)}\n\n**这是文章最后一段**\n\n[站内](/about?a=1&b=2)\n\n![正文图片](/images/body.webp)\n\n<script>alert(1)</script>\n\n:::spoiler 后续情节\n不要直接展示的结局\n:::`;
    const id = saveArticle({ ...input, content });
    const feed = await (getRss({} as APIContext) as Response).text();
    expect(feed).toContain('&lt;h1&gt;完整正文&lt;/h1&gt;');
    expect(feed).toContain('&lt;strong&gt;这是文章最后一段&lt;/strong&gt;');
    expect(feed).toContain('https://images.example.com/cover.webp');
    expect(feed).toContain(new URL('/images/body.webp', siteConfig.rss.siteUrl).href);
    expect(feed).toContain(`${new URL('/about', siteConfig.rss.siteUrl).href}?a=1&amp;amp;b=2`);
    expect(feed).toContain('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
    expect(feed).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(feed).toContain('<description>只是一只大黄狗</description>');
    expect(feed).toContain('<link>https://blog.moesam.com/</link>');
    expect(feed).not.toContain('localhost');
    const item = feed.split('<item>').find((item) => item.includes(`/articles/${id}</link>`))!;
    expect(item).not.toContain('不要直接展示的结局');
    expect(item).toContain('剧透内容，请到原文主动揭开。');
    expect(item.match(/<description>(.*?)<\/description>/s)?.[1]).toMatch(/…$/);
    expect(item.match(/<description>(.*?)<\/description>/s)?.[1]).not.toContain('这是文章最后一段');
    expect(item.match(/<content:encoded>(.*?)<\/content:encoded>/s)?.[1]).toContain('这是文章最后一段');
    const response = await getSiteCard({ request: new Request('https://blog.example/api/public/site-card.json') } as APIContext) as Response;
    const article = (await response.json()).latest.find((entry: { id: number }) => entry.id === id);
    expect(article.description).toMatch(/…$/);
    expect(article).not.toHaveProperty('content');
  });
});

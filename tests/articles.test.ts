import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { APIContext, APIRoute } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/config/server';
import { siteConfig } from '../src/config/site';
import { createAdminSession } from '../src/lib/admin-auth';
import { deleteArticle, getArticle, listArticles, restoreArticle, saveArticle } from '../src/lib/articles';
import { getDatabase } from '../src/lib/db';
import { DELETE, GET, PATCH, POST } from '../src/pages/api/admin/articles.json';
import { getProjectSettings, getProjectCommit, saveProjectSettings } from '../src/lib/projects';
import { PUT as saveProjects } from '../src/pages/api/admin/projects.json';
import { GET as getRss } from '../src/pages/rss.xml';
import { GET as getSiteCard } from '../src/pages/api/public/site-card.json';

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
      method, headers: { 'content-type': 'application/json', ...headers },
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

  it('stores repost attribution separately, clears it for originals and preserves source whitespace', () => {
    const content = '\n  保留原始空白\n\n```js\n\treturn 1;\n```\n';
    const id = saveArticle({ ...input, source: 'repost', originalAuthor: ' 原作者 ', originalUrl: 'https://example.com/original?a=1&b=2', content });
    expect(getArticle(id)).toMatchObject({ originalAuthor: '原作者', originalUrl: 'https://example.com/original?a=1&b=2', content });
    saveArticle({ ...input, id, originalAuthor: '应清空', originalUrl: 'javascript:ignored' });
    expect(getArticle(id)).toMatchObject({ originalAuthor: '', originalUrl: '' });
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

  it('guards every management method and supports create, edit, delete, restore', async () => {
    for (const [handler, method] of [[GET, 'GET'], [POST, 'POST'], [PATCH, 'PATCH'], [DELETE, 'DELETE']] as const) {
      expect((await call(handler, method, method === 'GET' ? undefined : input, false)).status).toBe(401);
    }
    const created = await call(POST, 'POST', input);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await call(PATCH, 'PATCH', { ...input, id, title: '后台修改' })).status).toBe(200);
    expect(getArticle(id)?.title).toBe('后台修改');
    expect((await call(DELETE, 'DELETE', { id })).status).toBe(200);
    expect(getArticle(id)).toBeUndefined();
    const all = await (await call(GET, 'GET')).json();
    expect(all.articles.find((article: { id: number }) => article.id === id).deletedAt).toBeTruthy();
    expect((await call(PATCH, 'PATCH', { id, restore: true })).status).toBe(200);
    expect(getArticle(id)?.title).toBe('后台修改');
    expect((await call(PATCH, 'PATCH', { ...input, id: 999999 })).status).toBe(404);
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
    const content = `# 完整正文\n\n${'正文内容'.repeat(80)}\n\n**这是文章最后一段**\n\n[站内](/about?a=1&b=2)\n\n![正文图片](/images/body.webp)\n\n<script>alert(1)</script>`;
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
    expect(item.match(/<description>(.*?)<\/description>/s)?.[1]).toMatch(/…$/);
    expect(item.match(/<description>(.*?)<\/description>/s)?.[1]).not.toContain('这是文章最后一段');
    expect(item.match(/<content:encoded>(.*?)<\/content:encoded>/s)?.[1]).toContain('这是文章最后一段');
    const response = await getSiteCard({ request: new Request('https://blog.example/api/public/site-card.json') } as APIContext) as Response;
    const article = (await response.json()).latest.find((entry: { id: number }) => entry.id === id);
    expect(article.description).toMatch(/…$/);
    expect(article).not.toHaveProperty('content');
  });
});

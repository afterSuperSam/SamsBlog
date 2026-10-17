import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { APIContext, APIRoute } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/config/server';
import { createAdminSession } from '../src/lib/admin-auth';
import { deleteArticle, getArticle, listArticles, restoreArticle, saveArticle } from '../src/lib/articles';
import { getDatabase } from '../src/lib/db';
import { DELETE, GET, PATCH, POST } from '../src/pages/api/admin/articles.json';

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
    for (const coverUrl of [123, 'javascript:alert(1)', 'https://user:secret@example.com/a', 'https://localhost/a', 'http://127.1/a', 'http://192.168.1.1/a', 'http://[::1]/a', 'https://private.local/a']) {
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
    expect(listArticles().slice(0, 2).map((item) => item.id)).toEqual([second, first]);
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

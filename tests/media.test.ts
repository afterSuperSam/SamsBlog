import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext, APIRoute } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAdminSession } from '../src/lib/admin-auth';
import { deleteArticle, getArticle, saveArticle } from '../src/lib/articles';
import { getDatabase } from '../src/lib/db';
import { changeMediaVisibility, getMedia, listMedia, mediaResponse, saveMedia } from '../src/lib/media';
import { GET, POST, PATCH, DELETE } from '../src/pages/api/admin/media.json';
import { GET as getRss } from '../src/pages/rss.xml';
import { serverConfig } from '../src/config/server';
import { siteConfig } from '../src/config/site';
import { renderMarkdown } from '../src/lib/markdown';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u1sAAAAASUVORK5CYII=', 'base64');
const file = () => new File([png], '../图片<script>.png', { type: 'image/png' });
const address = 'https://blog.example.com/api/admin/media.json';
let dataDirectory: string;
beforeAll(async () => { dataDirectory = await mkdtemp(path.join(tmpdir(), 'samsblog-media-')); vi.stubEnv('BLOG_DATA_DIR', dataDirectory); });
const call = (handler: APIRoute, request: Request, authorized = true) => handler({ request, url: new URL(request.url), cookies: { get: () => authorized ? { value: createAdminSession() } : undefined } } as unknown as APIContext) as Promise<Response>;
const upload = (origin = 'https://blog.example.com', authorized = true, image = file()) => {
  const form = new FormData(); form.set('file', image);
  return call(POST, new Request(address, { method: 'POST', headers: { origin }, body: form }), authorized);
};
const mutation = (handler: APIRoute, method: string, body: unknown) => call(handler, new Request(address, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

describe('authenticated image storage and media management', () => {
  it('rejects unauthenticated access and cross-origin multipart uploads', async () => {
    expect((await upload(undefined, false)).status).toBe(401);
    expect((await upload('https://other.example.com')).status).toBe(403);
    expect((await call(GET, new Request(`${address}?preview=anything`), false)).status).toBe(401);
    expect(listMedia()).toEqual([]);
  });

  it('uses bounded multipart reads and rejects masqueraded active content', async () => {
    expect((await upload(undefined, true, new File(['<svg onload="alert(1)"/>'], 'fake.png', { type: 'image/png' }))).status).toBe(415);
    expect((await call(POST, new Request(address, { method: 'POST', headers: { origin: 'https://blog.example.com', 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(serverConfig.mediaMaxBytes + 65537) }, body: 'x' }))).status).toBe(413);
    const oversized = new Uint8Array(serverConfig.mediaMaxBytes + 65537);
    expect((await call(POST, new Request(address, { method: 'POST', headers: { origin: 'https://blog.example.com', 'Content-Type': 'multipart/form-data; boundary=x' }, body: oversized }))).status).toBe(413);
    expect((await upload(undefined, true, new File([], 'empty.png'))).status).toBe(413);
  });

  it('deduplicates bytes, derives the extension and keeps upload paths inside the data directory', async () => {
    const first = await upload();
    expect(first.status).toBe(201);
    const { media } = await first.json();
    expect(media.filename).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(media.name).toBe('图片<script>.png');
    expect(media.url).toBe(`/uploads/${media.filename}`);
    expect(await readFile(path.join(dataDirectory, 'uploads', media.filename))).toEqual(png);
    const second = await upload(undefined, true, new File([png], 'different.jpg', { type: 'text/html' }));
    expect((await second.json()).media.id).toBe(media.id);
    expect(listMedia()).toHaveLength(1);
    expect((await readdir(path.join(dataDirectory, 'uploads'))).filter(name => name.endsWith('.partial'))).toEqual([]);
    expect(getMedia('../blog.sqlite')).toBeUndefined();
  });

  it('soft-deletes, blocks public and conditional reads, previews privately and restores the same address', async () => {
    const media = listMedia()[0];
    const publicResponse = await mediaResponse(media.filename, new Request(`https://blog.example.com${media.url}`));
    expect(publicResponse.headers.get('Content-Type')).toBe('image/png');
    expect(publicResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(new Uint8Array(png));
    const conditional = new Request(`https://blog.example.com${media.url}`, { headers: { 'if-none-match': publicResponse.headers.get('etag')! } });
    expect((await mediaResponse(media.filename, conditional)).status).toBe(304);
    expect((await mutation(DELETE, 'DELETE', { id: media.id })).status).toBe(200);
    expect((await mediaResponse(media.filename, conditional)).status).toBe(404);
    const preview = await call(GET, new Request(`${address}?preview=${media.filename}`));
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await mutation(PATCH, 'PATCH', { id: media.id, restore: true })).status).toBe(200);
    expect(getMedia(media.filename)?.url).toBe(media.url);
    changeMediaVisibility(media.id, false);
    expect((await saveMedia(file())).id).toBe(media.id);
    expect(getMedia(media.filename)).toBeDefined();
  });

  it('protects article references, supports local covers and emits absolute RSS image addresses', async () => {
    const media = listMedia()[0];
    const id = saveArticle({ title: '本地图片', content: `![图片](${media.url})`, coverUrl: media.url, source: 'original', category: 'journal' });
    expect(getArticle(id)?.coverUrl).toBe(media.url);
    expect((await mutation(DELETE, 'DELETE', { id: media.id })).status).toBe(409);
    const rss = await getRss({ request: new Request('https://blog.example.com/rss.xml') } as APIContext);
    const xml = await rss.text();
    expect(xml).toContain(`https://blog.moesam.com${media.url}`);
    deleteArticle(id);
    expect((await mutation(DELETE, 'DELETE', { id: media.id })).status).toBe(409);
    getDatabase().prepare('DELETE FROM blog_articles WHERE id = ?').run(id);
    changeMediaVisibility(media.id, false);
    const input = { title: '已删除图片', content: `![图片](${media.url})`, source: 'original', category: 'discussion' };
    expect(() => saveArticle(input)).toThrow('已删除或不存在');
    expect(() => saveArticle({ ...input, content: '正文', coverUrl: media.url })).toThrow('首图不存在');
    expect(() => saveArticle({ ...input, content: `![外部图片](https://other.example.com${media.url})` })).not.toThrow();
    expect(getMedia(media.filename)).toBeUndefined();
  });

  it('accepts existing JPG, WebP and GIF files without transcoding', async () => {
    for (const [filename, type] of [['public/media/brand/logo.jpg', 'image/jpeg'], ['public/media/branding/samsblog-wordmark-nav.webp', 'image/webp']]) {
      const bytes = await readFile(filename);
      expect((await saveMedia(new File([bytes], path.basename(filename)))).type).toBe(type);
    }
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    expect((await saveMedia(new File([gif], 'pixel.gif'))).type).toBe('image/gif');
  });

  it('protects encoded local image references and rejects deleted images in angle-bracket destinations', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const media = await saveMedia(new File([gif], 'reference.gif'));
    const encoded = `/uploads/%${media.filename.charCodeAt(0).toString(16)}${media.filename.slice(1)}`;
    const content = `![图片](${encoded})`;
    expect(renderMarkdown(content)).toContain(`<img src="${encoded}"`);
    const articleId = saveArticle({ title: '编码媒体引用', content, source: 'original', category: 'journal' });
    expect(() => changeMediaVisibility(media.id, false)).toThrow('图片仍被文章引用');
    getDatabase().prepare('DELETE FROM blog_articles WHERE id=?').run(articleId);
    getDatabase().prepare('INSERT INTO blog_article_drafts(id,article_id,payload,revision,updated_at) VALUES (?,NULL,?,1,?)')
      .run('encoded-media-fixture', JSON.stringify({ content, coverUrl: '' }), new Date().toISOString());
    expect(() => changeMediaVisibility(media.id, false)).toThrow('草稿引用');
    getDatabase().prepare('DELETE FROM blog_article_drafts WHERE id=?').run('encoded-media-fixture');
    changeMediaVisibility(media.id, false);
    expect(() => saveArticle({ title: '已删媒体尖括号引用', content: `![图片](<${media.url}>)`, source: 'original', category: 'journal' })).toThrow('已删除或不存在');
    expect(() => saveArticle({ title: '已删媒体编码引用', content, source: 'original', category: 'journal' })).toThrow('已删除或不存在');
  });

  it('keeps the homepage background available while the friend application links to it', async () => {
    const filename = siteConfig.friendApplications.backgroundUrl.split('/').pop()!;
    const inserted = getDatabase().prepare('INSERT INTO blog_media(filename,original_name,mime_type,byte_size,created_at) VALUES (?,?,?,?,?)')
      .run(filename, '本站背景.webp', 'image/webp', 1, new Date().toISOString());
    expect((await mutation(DELETE, 'DELETE', { id: Number(inserted.lastInsertRowid) })).status).toBe(409);
    expect(getMedia(filename)?.deletedAt).toBeNull();
  });
});

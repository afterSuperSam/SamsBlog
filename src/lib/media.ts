import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDatabase } from './db';
import { HttpError } from './http';
import { serverConfig } from '../config/server';
import { siteConfig } from '../config/site';
import { renderMarkdown } from './markdown';

export interface MediaRecord {
  id: number;
  filename: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  deletedAt: string | null;
  url: string;
  references?: MediaReference[];
}
export interface MediaReference {
  articleId: number | null;
  draftId?: string;
  title: string;
  location: 'body' | 'cover';
  deleted: boolean;
  filename: string;
}
const filenamePattern = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/;
const directory = () => path.resolve(process.env.BLOG_DATA_DIR || 'data', 'uploads');
const select = 'SELECT id, filename, original_name AS name, mime_type AS type, byte_size AS size, created_at AS createdAt, deleted_at AS deletedAt FROM blog_media';
const withUrl = (row: Omit<MediaRecord, 'url'>): MediaRecord => ({ ...row, url: `/uploads/${row.filename}` });

// 按阅读页实际解析地址识别媒体引用，兼容编码路径和 Markdown 尖括号地址。
export function referencedMediaFilenames(content: string, coverUrl = '') {
  const filenames = new Set<string>();
  const origin = new URL(siteConfig.siteUrl).origin;
  const values = [coverUrl, ...Array.from(renderMarkdown(content).matchAll(/(?:src|href)="([^"]+)"/g), (match) => match[1])];
  for (const value of values) {
    if (!value) continue;
    try {
      const address = new URL(value.replaceAll('&amp;', '&'), new URL('/articles/1', origin));
      if (address.origin !== origin) continue;
      const pathname = decodeURIComponent(address.pathname);
      const filename = pathname.startsWith('/uploads/') ? pathname.slice('/uploads/'.length) : '';
      if (filenamePattern.test(filename)) filenames.add(filename);
    } catch { continue; }
  }
  return filenames;
}

export function listMedia() {
  const database = getDatabase();
  const records = (database.prepare(`${select} ORDER BY created_at DESC, id DESC`).all() as MediaRecord[]).map(withUrl);
  const references = new Map<string, MediaReference[]>();
  const collect = (content: string, coverUrl: string, reference: Omit<MediaReference, 'location' | 'filename'>) => {
    for (const [location, filenames] of [['body', referencedMediaFilenames(content)], ['cover', referencedMediaFilenames('', coverUrl)]] as const) {
      for (const filename of filenames) {
        const items = references.get(filename) || [];
        items.push({ ...reference, location, filename });
        references.set(filename, items);
      }
    }
  };
  const articles = database.prepare('SELECT id,title,content,cover_url AS coverUrl,deleted_at AS deletedAt FROM blog_articles').all() as Array<{ id: number; title: string; content: string; coverUrl: string; deletedAt: string | null }>;
  for (const article of articles) collect(article.content, article.coverUrl, { articleId: article.id, title: article.title, deleted: Boolean(article.deletedAt) });
  const drafts = database.prepare('SELECT id,article_id AS articleId,payload,deleted_at AS deletedAt FROM blog_article_drafts').all() as Array<{ id: string; articleId: number | null; payload: string; deletedAt: string | null }>;
  for (const draft of drafts) {
    const payload = JSON.parse(draft.payload) as { content?: string; coverUrl?: string; title?: string };
    collect(payload.content || '', payload.coverUrl || '', { articleId: draft.articleId, draftId: draft.id, title: payload.title || '未命名草稿', deleted: Boolean(draft.deletedAt) || Boolean(articles.find((article) => article.id === draft.articleId)?.deletedAt) });
  }
  return records.map((record) => ({ ...record, references: references.get(record.filename) || [] }));
}

export function getMedia(filename: string, includeDeleted = false) {
  if (!filenamePattern.test(filename)) return undefined;
  const row = getDatabase().prepare(`${select} WHERE filename = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(filename) as MediaRecord | undefined;
  return row ? withUrl(row) : undefined;
}

// 文件名与类型以实际签名为准，不接受 SVG、HTML 或客户端提供的路径。
function imageFormat(bytes: Buffer) {
  if (bytes.length >= 57 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') return { extension: 'png', type: 'image/png' };
  if (bytes.length >= 20 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) return { extension: 'jpg', type: 'image/jpeg' };
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return { extension: 'webp', type: 'image/webp' };
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes[bytes.length - 1] === 59) return { extension: 'gif', type: 'image/gif' };
  throw new HttpError(415, '请选择有效的 JPG、PNG、WebP 或 GIF 图片');
}

export async function saveMedia(file: File) {
  if (!file.size || file.size > serverConfig.mediaMaxBytes) throw new HttpError(413, `图片不能为空，且不能超过 ${serverConfig.mediaMaxBytes / 1024 / 1024} MB`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const format = imageFormat(bytes);
  const filename = `${createHash('sha256').update(bytes).digest('hex')}.${format.extension}`;
  const name = file.name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180).trim() || `图片.${format.extension}`;
  const destination = directory();
  await mkdir(destination, { recursive: true });
  const temporary = path.join(destination, `${randomUUID()}.partial`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(destination, filename));
    getDatabase().prepare(`INSERT INTO blog_media (filename, original_name, mime_type, byte_size, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(filename) DO UPDATE SET deleted_at = NULL`).run(filename, name, format.type, bytes.length, new Date().toISOString());
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  return getMedia(filename)!;
}

export function changeMediaVisibility(id: number, restore: boolean) {
  const database = getDatabase();
  return database.transaction(() => {
    const row = database.prepare(`${select} WHERE id = ?`).get(id) as MediaRecord | undefined;
    if (!row) throw new HttpError(404, '图片不存在');
    if (!restore) {
      if (siteConfig.friendApplications.backgroundUrl === `/uploads/${row.filename}`) throw new HttpError(409, '图片仍被友链申请页引用，请先更换本站背景图');
      const articles = database.prepare('SELECT content,cover_url AS coverUrl FROM blog_articles').all() as Array<{ content: string; coverUrl: string }>;
      const used = articles.some((article) => article.content.includes(`/uploads/${row.filename}`) || article.coverUrl.includes(`/uploads/${row.filename}`)
        || referencedMediaFilenames(article.content, article.coverUrl).has(row.filename));
      if (used) throw new HttpError(409, '图片仍被文章引用，请先移除首图或正文中的引用（包括已删除文章）');
      const drafts = database.prepare('SELECT payload FROM blog_article_drafts').all() as Array<{ payload: string }>;
      if (drafts.some((draft) => {
        if (draft.payload.includes(`/uploads/${row.filename}`)) return true;
        const payload = JSON.parse(draft.payload) as { content: string; coverUrl: string };
        return referencedMediaFilenames(payload.content, payload.coverUrl).has(row.filename);
      })) throw new HttpError(409, '图片仍被自动保存的草稿引用，请先移除草稿中的引用');
    }
    database.prepare('UPDATE blog_media SET deleted_at = ? WHERE id = ?').run(restore ? null : new Date().toISOString(), id);
  })();
}

export async function mediaResponse(filename: string, request: Request, preview = false) {
  const media = getMedia(filename, preview);
  const headers = new Headers({ 'Cache-Control': preview ? 'private, no-store' : 'public, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff' });
  if (!media) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  headers.set('Content-Type', media.type);
  headers.set('ETag', `"${media.filename}"`);
  if (!preview && request.headers.get('if-none-match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
  try {
    const bytes = await readFile(path.join(directory(), media.filename));
    headers.set('Content-Length', String(bytes.length));
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    throw error;
  }
}

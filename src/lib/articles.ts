import { isIP } from 'node:net';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { isPublicFriendAddress } from './friend-status';
import { HttpError, readPositiveId } from './http';

export interface ArticleRecord {
  id: number;
  title: string;
  coverUrl: string;
  source: 'original' | 'repost';
  category: 'discussion' | 'journal';
  content: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function mapArticle(row: Record<string, unknown>): ArticleRecord {
  return {
    id: Number(row.id), title: String(row.title), coverUrl: String(row.cover_url),
    source: row.source as ArticleRecord['source'], category: row.category as ArticleRecord['category'],
    content: String(row.content), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function parseCoverUrl(value: unknown) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, '首图地址必须是文本');
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new HttpError(400, '首图地址必须是完整的网址'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, '首图仅支持不含账号密码的 http 或 https 地址');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || (!isIP(hostname) && !hostname.includes('.')) || (isIP(hostname) && !isPublicFriendAddress(hostname))) {
    throw new HttpError(400, '首图需要使用公开的图片地址');
  }
  return url.toString();
}

export function listArticles(options: { includeDeleted?: boolean } = {}): ArticleRecord[] {
  return (getDatabase().prepare(`SELECT * FROM blog_articles ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
    ORDER BY created_at DESC, id DESC`).all() as Record<string, unknown>[]).map(mapArticle);
}

export function getArticle(id: number, options: { includeDeleted?: boolean } = {}): ArticleRecord | undefined {
  const row = getDatabase().prepare(`SELECT * FROM blog_articles WHERE id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(readPositiveId(id)) as Record<string, unknown> | undefined;
  return row ? mapArticle(row) : undefined;
}

// 保存即公开，创建时间固定，删除内容只允许恢复后再编辑
export function saveArticle(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '文章内容必须是对象');
  const body = input as Record<string, unknown>;
  const id = body.id === undefined ? undefined : readPositiveId(body.id);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title || title.length > serverConfig.articleTitleMaxLength) {
    throw new HttpError(400, `题目需要 1 至 ${serverConfig.articleTitleMaxLength} 个字符`);
  }
  if (!content || content.length > serverConfig.articleContentMaxLength) {
    throw new HttpError(400, `正文需要 1 至 ${serverConfig.articleContentMaxLength} 个字符`);
  }
  if (body.source !== 'original' && body.source !== 'repost') throw new HttpError(400, '来源请选择原创或搬运');
  if (body.category !== 'discussion' && body.category !== 'journal') throw new HttpError(400, '分类请选择杂谈或日志');
  const values = { id, title, content, source: body.source, category: body.category, coverUrl: parseCoverUrl(body.coverUrl), now: new Date().toISOString() };
  if (id !== undefined) {
    const result = getDatabase().prepare(`UPDATE blog_articles SET title=@title,cover_url=@coverUrl,source=@source,
      category=@category,content=@content,updated_at=@now WHERE id=@id AND deleted_at IS NULL`).run(values);
    if (!result.changes) throw new HttpError(404, '文章不存在或已删除');
    return id;
  }
  return Number(getDatabase().prepare(`INSERT INTO blog_articles (title,cover_url,source,category,content,created_at,updated_at)
    VALUES (@title,@coverUrl,@source,@category,@content,@now,@now)`).run(values).lastInsertRowid);
}

export function deleteArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), readPositiveId(id)).changes === 1;
}

export function restoreArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(readPositiveId(id)).changes === 1;
}

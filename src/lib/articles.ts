import { isIP } from 'node:net';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { isPublicFriendAddress } from './friend-status';
import { HttpError, readPositiveId } from './http';
import { siteConfig } from '../config/site';
import { articleExcerpt } from './markdown';

export interface ArticleRecord {
  id: number;
  title: string;
  coverUrl: string;
  source: 'original' | 'repost';
  originalAuthor: string;
  originalUrl: string;
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
    originalAuthor: String(row.original_author || ''), originalUrl: String(row.original_url || ''),
    content: String(row.content), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function parseCoverUrl(value: unknown) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, '首图地址必须是文本');
  if (!value.trim()) return '';
  if (!/^https?:\/\//i.test(value.trim())) throw new HttpError(400, '首图地址必须是完整的网址');
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

function parseOriginalUrl(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, '原文链接必须是文本');
  if (!value.trim()) return '';
  let address: URL;
  try { address = new URL(value.trim()); }
  catch { throw new HttpError(400, '原文链接必须是完整的网址'); }
  if (!/^https?:\/\//i.test(value.trim()) || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new HttpError(400, '原文链接仅支持不含账号密码的 http 或 https 地址');
  }
  return address.href;
}

export function getArticle(id: number, options: { includeDeleted?: boolean } = {}): ArticleRecord | undefined {
  const row = getDatabase().prepare(`SELECT * FROM blog_articles WHERE id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(readPositiveId(id)) as Record<string, unknown> | undefined;
  return row ? mapArticle(row) : undefined;
}

// 跨站卡片使用公开文章摘要，不暴露软删除内容。
export function getArticleUpdates(limit: number) {
  return listArticles().slice(0, limit).map((article) => ({
    id: article.id, title: article.title, url: new URL(`/articles/${article.id}`, siteConfig.siteUrl).href,
    coverUrl: article.coverUrl, description: articleExcerpt(article.content),
    source: article.source, category: article.category, createdAt: article.createdAt, updatedAt: article.updatedAt,
  }));
}

// 保存即公开，创建时间固定，删除内容只允许恢复后再编辑
export function saveArticle(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '文章内容必须是对象');
  const body = input as Record<string, unknown>;
  const id = body.id === undefined ? undefined : readPositiveId(body.id);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!title || title.length > serverConfig.articleTitleMaxLength) {
    throw new HttpError(400, `题目需要 1 至 ${serverConfig.articleTitleMaxLength} 个字符`);
  }
  if (!content.trim() || content.length > serverConfig.articleContentMaxLength) {
    throw new HttpError(400, `正文需要 1 至 ${serverConfig.articleContentMaxLength} 个字符`);
  }
  if (body.source !== 'original' && body.source !== 'repost') throw new HttpError(400, '来源请选择原创或搬运');
  if (body.category !== 'discussion' && body.category !== 'journal') throw new HttpError(400, '分类请选择杂谈或日志');
  const originalAuthor = body.source === 'repost' && typeof body.originalAuthor === 'string' ? body.originalAuthor.trim() : '';
  if (body.source === 'repost' && body.originalAuthor !== undefined && typeof body.originalAuthor !== 'string') throw new HttpError(400, '原作者必须是文本');
  if (originalAuthor.length > serverConfig.articleTitleMaxLength) throw new HttpError(400, `原作者最多 ${serverConfig.articleTitleMaxLength} 个字符`);
  const originalUrl = body.source === 'repost' ? parseOriginalUrl(body.originalUrl) : '';
  const values = { id, title, content, originalAuthor, originalUrl, source: body.source, category: body.category, coverUrl: parseCoverUrl(body.coverUrl), now: new Date().toISOString() };
  if (id !== undefined) {
    const result = getDatabase().prepare(`UPDATE blog_articles SET title=@title,cover_url=@coverUrl,source=@source,
      original_author=@originalAuthor,original_url=@originalUrl,category=@category,content=@content,updated_at=@now WHERE id=@id AND deleted_at IS NULL`).run(values);
    if (!result.changes) throw new HttpError(404, '文章不存在或已删除');
    return id;
  }
  return Number(getDatabase().prepare(`INSERT INTO blog_articles (title,cover_url,source,original_author,original_url,category,content,created_at,updated_at)
    VALUES (@title,@coverUrl,@source,@originalAuthor,@originalUrl,@category,@content,@now,@now)`).run(values).lastInsertRowid);
}

export function deleteArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), readPositiveId(id)).changes === 1;
}

export function restoreArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(readPositiveId(id)).changes === 1;
}

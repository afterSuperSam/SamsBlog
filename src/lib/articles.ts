import { isIP } from 'node:net';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { isPublicFriendAddress } from './friend-status';
import { HttpError, readPositiveId } from './http';
import { siteConfig } from '../config/site';
import { articleExcerpt, articlePlainText } from './markdown';
import { getMedia, referencedMediaFilenames } from './media';
import { parseArticleTags, articleCardLayouts, articleContentTypes, type ArticleCardLayout, type ArticleContentType } from './article-catalog';

export interface ArticleRecord {
  id: number;
  title: string;
  coverUrl: string;
  cardLayout: ArticleCardLayout;
  contentType: ArticleContentType;
  externalUrl: string;
  source: 'original' | 'repost';
  originalAuthor: string;
  originalUrl: string;
  category: 'discussion' | 'journal';
  tags: string[];
  content: string;
  summary: string;
  publicationStatus: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function mapArticle(row: Record<string, unknown>): ArticleRecord {
  return {
    id: Number(row.id), title: String(row.title), coverUrl: String(row.cover_url),
    cardLayout: row.card_layout as ArticleCardLayout,
    contentType: row.content_type as ArticleContentType, externalUrl: String(row.external_url),
    source: row.source as ArticleRecord['source'], category: row.category as ArticleRecord['category'],
    originalAuthor: String(row.original_author || ''), originalUrl: String(row.original_url || ''),
    tags: JSON.parse(String(row.tags)),
    content: String(row.content), summary: String(row.summary || ''), publicationStatus: row.publication_status as ArticleRecord['publicationStatus'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function parseCoverUrl(value: unknown) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, '首图地址必须是文本');
  if (!value.trim()) return '';
  const referenced = referencedMediaFilenames('', value).values().next().value;
  if (referenced) {
    const media = getMedia(referenced);
    if (!media) throw new HttpError(400, '上传的首图不存在或已删除');
    return media.url;
  }
  if (value.trim().startsWith('/uploads/')) {
    const media = getMedia(value.trim().slice('/uploads/'.length));
    if (!media) throw new HttpError(400, '上传的首图不存在或已删除');
    return media.url;
  }
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

export function listArticles(options: { includeDeleted?: boolean; includeDrafts?: boolean; limit?: number; contentTypes?: readonly ArticleContentType[] } = {}): ArticleRecord[] {
  const limit = options.limit === undefined ? -1 : readPositiveId(options.limit);
  if (options.contentTypes?.length === 0) return [];
  const conditions = options.includeDeleted ? [] : ['deleted_at IS NULL'];
  if (!options.includeDrafts) conditions.push("publication_status = 'published'");
  if (options.contentTypes) conditions.push(`content_type IN (${options.contentTypes.map(() => '?').join(',')})`);
  return (getDatabase().prepare(`SELECT * FROM blog_articles ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...(options.contentTypes || []), limit) as Record<string, unknown>[]).map(mapArticle);
}

// 首页分别限量取三组公开内容，避免短记录挤走长文或加载整库正文。
export function listHomepageArticles(): ArticleRecord[] {
  return [
    ...listArticles({ contentTypes: ['article'], limit: siteConfig.articles.homepageCount }),
    ...listArticles({ contentTypes: ['note', 'update'], limit: siteConfig.articles.homepageNoteCount }),
    ...listArticles({ contentTypes: ['link'], limit: siteConfig.articles.homepageLinkCount }),
  ];
}

// 精选链接按发表顺序轮换，只有公开外链参加，读到末尾后回到最新一条。
export function getNextFeaturedLink(currentId: number): ArticleRecord | undefined {
  const database = getDatabase();
  const current = getArticle(currentId);
  const next = current && database.prepare(`SELECT * FROM blog_articles WHERE deleted_at IS NULL AND publication_status = 'published' AND content_type = 'link'
    AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 1`).get(current.createdAt, current.id);
  return next ? mapArticle(next as Record<string, unknown>) : listArticles({ contentTypes: ['link'], limit: 1 })[0];
}

export function listArticleMetadata(): Array<Pick<ArticleRecord, 'id' | 'title' | 'updatedAt'>> {
  return (getDatabase().prepare(`SELECT id, title, updated_at FROM blog_articles WHERE deleted_at IS NULL AND publication_status = 'published'
    ORDER BY created_at DESC, id DESC`).all() as Array<{ id: number; title: string; updated_at: string }>)
    .map((article) => ({ id: article.id, title: article.title, updatedAt: article.updated_at }));
}

// 按北京时间的发布日期统计公开文章，不读取正文或计入软删除记录。
export function getArticlePublicationCounts(): Array<{ date: string; count: number }> {
  return getDatabase().prepare(`SELECT date(created_at, '+8 hours') AS date, COUNT(*) AS count
    FROM blog_articles WHERE deleted_at IS NULL AND publication_status = 'published' AND content_type = 'article' GROUP BY date ORDER BY date`).all() as Array<{ date: string; count: number }>;
}

export function getAdjacentArticles(article: Pick<ArticleRecord, 'id' | 'createdAt'>) {
  const database = getDatabase();
  const previous = database.prepare(`SELECT id, title FROM blog_articles
    WHERE deleted_at IS NULL AND publication_status = 'published' AND (created_at, id) < (?, ?)
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(article.createdAt, article.id) as Pick<ArticleRecord, 'id' | 'title'> | undefined;
  const next = database.prepare(`SELECT id, title FROM blog_articles
    WHERE deleted_at IS NULL AND publication_status = 'published' AND (created_at, id) > (?, ?)
    ORDER BY created_at ASC, id ASC LIMIT 1`).get(article.createdAt, article.id) as Pick<ArticleRecord, 'id' | 'title'> | undefined;
  return { previous, next };
}

function parseArticleUrl(value: unknown, label: string): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}必须是文本`);
  if (!value.trim()) return '';
  let address: URL;
  try { address = new URL(value.trim()); }
  catch { throw new HttpError(400, `${label}必须是完整的网址`); }
  if (!/^https?:\/\//i.test(value.trim()) || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new HttpError(400, `${label}仅支持不含账号密码的 http 或 https 地址`);
  }
  return address.href;
}

export function getArticle(id: number, options: { includeDeleted?: boolean; includeDrafts?: boolean } = {}): ArticleRecord | undefined {
  const row = getDatabase().prepare(`SELECT * FROM blog_articles WHERE id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'} ${options.includeDrafts ? '' : "AND publication_status = 'published'"}`)
    .get(readPositiveId(id)) as Record<string, unknown> | undefined;
  return row ? mapArticle(row) : undefined;
}

// 跨站卡片使用公开文章摘要，不暴露软删除内容。
export function getArticleUpdates(limit: number) {
  return listArticles({ limit }).map((article) => ({
    id: article.id, title: article.title, url: new URL(`/articles/${article.id}`, siteConfig.siteUrl).href,
    coverUrl: article.coverUrl ? new URL(article.coverUrl, siteConfig.siteUrl).href : '', description: article.summary || articleExcerpt(article.content),
    source: article.source, category: article.category, createdAt: article.createdAt, updatedAt: article.updatedAt,
    contentType: article.contentType, externalUrl: article.externalUrl,
  }));
}

// 手动发布经过完整校验，草稿自动保存不经过这个入口。
export function saveArticle(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '文章内容必须是对象');
  const body = input as Record<string, unknown>;
  const id = body.id === undefined ? undefined : readPositiveId(body.id);
  const current = id === undefined ? undefined : getArticle(id, { includeDrafts: true });
  if (id !== undefined && !current) throw new HttpError(404, '文章不存在或已删除');
  if (current && body.updatedAt !== undefined && body.updatedAt !== current.updatedAt) throw new HttpError(409, '文章已经在其他窗口更新，请重新打开后再发布');
  const summary = body.summary === undefined ? current?.summary || '' : body.summary;
  if (typeof summary !== 'string' || summary.length > serverConfig.articleSummaryMaxLength) throw new HttpError(400, `摘要最多 ${serverConfig.articleSummaryMaxLength} 个字符`);
  const contentType = body.contentType === undefined ? current?.contentType ?? 'article' : body.contentType;
  if (!articleContentTypes.some((type) => type.value === contentType)) throw new HttpError(400, '请选择长文章、短记录、外部链接或更新记录');
  const externalUrl = contentType === 'link' ? parseArticleUrl(body.externalUrl === undefined ? current?.externalUrl : body.externalUrl, '外部链接') : '';
  if (contentType === 'link' && !externalUrl) throw new HttpError(400, '请填写外部链接地址');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!title || title.length > serverConfig.articleTitleMaxLength) {
    throw new HttpError(400, `题目需要 1 至 ${serverConfig.articleTitleMaxLength} 个字符`);
  }
  if (!content.trim() || content.length > serverConfig.articleContentMaxLength) {
    throw new HttpError(400, `正文需要 1 至 ${serverConfig.articleContentMaxLength} 个字符`);
  }
  for (const filename of referencedMediaFilenames(content)) {
    if (!getMedia(filename)) throw new HttpError(400, '正文中有已删除或不存在的图片，请先在媒体库恢复');
  }
  if (body.source !== 'original' && body.source !== 'repost') throw new HttpError(400, '来源请选择原创或搬运');
  if (body.category !== 'discussion' && body.category !== 'journal') throw new HttpError(400, '分类请选择杂谈或日志');
  const originalAuthor = body.source === 'repost' && typeof body.originalAuthor === 'string' ? body.originalAuthor.trim() : '';
  if (body.source === 'repost' && body.originalAuthor !== undefined && typeof body.originalAuthor !== 'string') throw new HttpError(400, '原作者必须是文本');
  if (originalAuthor.length > serverConfig.articleTitleMaxLength) throw new HttpError(400, `原作者最多 ${serverConfig.articleTitleMaxLength} 个字符`);
  const originalUrl = body.source === 'repost' ? parseArticleUrl(body.originalUrl, '原文链接') : '';
  let tags: string | null = null;
  if (body.tags !== undefined) {
    try { tags = JSON.stringify(parseArticleTags(body.tags)); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new HttpError(400, error.message);
    }
  }
  if (body.cardLayout !== undefined && !articleCardLayouts.some((layout) => layout.value === body.cardLayout)) throw new HttpError(400, '卡片布局请选择左图右文、右图左文或纯文字');
  const values = { id, title, content, summary: summary.trim(), tags, contentType, externalUrl, cardLayout: body.cardLayout ?? null, originalAuthor, originalUrl, source: body.source, category: body.category, coverUrl: parseCoverUrl(body.coverUrl), now: new Date(Math.max(Date.now(), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString() };
  if (id !== undefined) {
    const result = getDatabase().prepare(`UPDATE blog_articles SET title=@title,cover_url=@coverUrl,source=@source,
      original_author=@originalAuthor,original_url=@originalUrl,category=@category,tags=COALESCE(@tags,tags),card_layout=COALESCE(@cardLayout,card_layout),content_type=@contentType,external_url=@externalUrl,content=@content,summary=@summary,publication_status='published',updated_at=@now WHERE id=@id AND deleted_at IS NULL`).run(values);
    if (!result.changes) throw new HttpError(404, '文章不存在或已删除');
    return id;
  }
  return Number(getDatabase().prepare(`INSERT INTO blog_articles (title,cover_url,source,original_author,original_url,category,tags,card_layout,content_type,external_url,content,summary,created_at,updated_at)
    VALUES (@title,@coverUrl,@source,@originalAuthor,@originalUrl,@category,COALESCE(@tags,'[]'),COALESCE(@cardLayout,'left'),@contentType,@externalUrl,@content,@summary,@now,@now)`).run(values).lastInsertRowid);
}

export function withdrawArticle(id: number) {
  const database = getDatabase();
  return database.transaction(() => {
    const now = new Date().toISOString();
    const changed = database.prepare("UPDATE blog_articles SET publication_status = 'draft', updated_at = ? WHERE id = ? AND deleted_at IS NULL AND publication_status = 'published'")
      .run(now, readPositiveId(id)).changes === 1;
    if (changed) database.prepare("UPDATE blog_article_drafts SET payload=json_set(payload,'$.updatedAt',?),revision=revision+1 WHERE article_id=?").run(now,id);
    return changed;
  })();
}

let searchVersion = '';
let searchDocuments: Array<{ id: number; text: string }> = [];
export function searchArticleIds(query: string) {
  const version = JSON.stringify(listArticleMetadata());
  if (version !== searchVersion) {
    searchDocuments = listArticles().map((article) => ({ id: article.id, text: `${article.title} ${article.summary} ${articlePlainText(article.content)}`.normalize('NFKC').toLocaleLowerCase('zh-CN') }));
    searchVersion = version;
  }
  const normalized = query.normalize('NFKC').toLocaleLowerCase('zh-CN');
  return searchDocuments.filter((article) => article.text.includes(normalized)).map((article) => article.id);
}

export function deleteArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), readPositiveId(id)).changes === 1;
}

export function restoreArticle(id: number): boolean {
  return getDatabase().prepare('UPDATE blog_articles SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(readPositiveId(id)).changes === 1;
}

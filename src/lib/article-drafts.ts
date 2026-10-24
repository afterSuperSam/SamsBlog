import { getDatabase } from './db';
import { getArticle, saveArticle } from './articles';
import { HttpError, readPositiveId } from './http';
import { serverConfig } from '../config/server';
import { articleCardLayouts, articleContentTypes, parseArticleTags } from './article-catalog';

export interface ArticleDraft {
  draftId: string;
  articleId: number | null;
  payload: Record<string, unknown>;
  revision: number;
  savedAt: string;
  deletedAt: string | null;
}

type DraftReference = { draftId?: unknown; revision?: unknown };

const selection = 'SELECT id AS draftId, article_id AS articleId, payload, revision, updated_at AS savedAt, deleted_at AS deletedAt FROM blog_article_drafts';
const decode = (row: Record<string, unknown>): ArticleDraft => ({ ...row, payload: JSON.parse(String(row.payload)) }) as ArticleDraft;

export function listArticleDrafts(includeDeleted = false) {
  return (getDatabase().prepare(`${selection} WHERE (article_id IS NULL OR article_id IN (SELECT id FROM blog_articles WHERE deleted_at IS NULL)) ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`).all() as Record<string, unknown>[]).map(decode);
}

function draftIdentity(body: DraftReference) {
  if (typeof body.draftId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.draftId)) throw new HttpError(400, '草稿编号不正确');
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new HttpError(400, '草稿版本不正确');
  return { draftId: body.draftId, revision: Number(body.revision) };
}

// 草稿允许尚未写完的题目与网址，仍限制类型和体积，绝不进入公开查询。
export function saveArticleDraft(body: Record<string, unknown>): ArticleDraft {
  const { draftId, revision } = draftIdentity(body);
  const articleId = body.id == null ? null : readPositiveId(body.id);
  if (articleId && !getArticle(articleId, { includeDrafts: true })) throw new HttpError(404, '文章不存在或已删除');
  const payload: Record<string, unknown> = {};
  for (const [name, maximum] of Object.entries({ title: serverConfig.articleTitleMaxLength, content: serverConfig.articleContentMaxLength,
    summary: serverConfig.articleSummaryMaxLength, coverUrl: 4096, externalUrl: 4096, originalUrl: 4096, originalAuthor: serverConfig.articleTitleMaxLength, updatedAt: 40 })) {
    const value = body[name] ?? '';
    if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) throw new HttpError(400, `${name === 'summary' ? '摘要' : '草稿字段'}内容过长或格式不正确`);
    payload[name] = value;
  }
  const choices = { source: ['original','repost'], category: ['discussion','journal'], contentType: articleContentTypes.map((item) => item.value), cardLayout: articleCardLayouts.map((item) => item.value) };
  for (const [name, options] of Object.entries(choices)) {
    const value = body[name] ?? options[0];
    if (typeof value !== 'string' || !(options as string[]).includes(value)) throw new HttpError(400, '草稿选项不正确');
    payload[name] = value;
  }
  try { payload.tags = parseArticleTags(body.tags); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '标签不正确'); }
  const database = getDatabase();
  return database.transaction(() => {
    const current = database.prepare(`${selection} WHERE id = ?`).get(draftId) as Record<string, unknown> | undefined;
    if ((current && (current.deletedAt || current.revision !== revision || current.articleId !== articleId)) || (!current && revision !== 0)) throw new HttpError(409, '草稿已在其他窗口修改，请重新打开；当前输入仍然保留');
    if (!current && articleId && database.prepare('SELECT 1 FROM blog_article_drafts WHERE article_id = ?').get(articleId)) throw new HttpError(409, '这篇文章已有草稿，请重新打开后继续编辑');
    const savedAt = new Date().toISOString();
    database.prepare(`INSERT INTO blog_article_drafts(id,article_id,payload,revision,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(draftId, articleId, JSON.stringify(payload), revision + 1, savedAt);
    return { draftId, articleId, payload, revision: revision + 1, savedAt, deletedAt: null };
  })();
}

// 发布与清理工作副本处于同一个事务，重复请求不能创建第二篇文章。
export function publishArticleDraft(body: DraftReference) {
  const { draftId, revision } = draftIdentity(body);
  const database = getDatabase();
  return database.transaction(() => {
    const row = database.prepare(`${selection} WHERE id = ?`).get(draftId) as Record<string, unknown> | undefined;
    if (!row || row.deletedAt || row.revision !== revision) throw new HttpError(409, '草稿版本已变化，请重新打开后再发布');
    const draft = decode(row);
    const id = saveArticle({ ...draft.payload, ...(draft.articleId ? { id: draft.articleId } : {}) });
    database.prepare('DELETE FROM blog_article_drafts WHERE id = ?').run(draftId);
    return id;
  })();
}

export function deleteArticleDraft(body: DraftReference) {
  const { draftId, revision } = draftIdentity(body);
  if (!getDatabase().prepare('UPDATE blog_article_drafts SET deleted_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL AND article_id IS NULL')
    .run(new Date().toISOString(), draftId, revision).changes) throw new HttpError(409, '草稿版本已变化或已关联文章，请刷新后再删除');
}

export function restoreArticleDraft(body: DraftReference) {
  const { draftId, revision } = draftIdentity(body);
  if (!getDatabase().prepare('UPDATE blog_article_drafts SET deleted_at = NULL, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL')
    .run(draftId, revision).changes) throw new HttpError(409, '草稿版本已变化，请刷新后再恢复');
}

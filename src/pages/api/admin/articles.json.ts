import { deleteArticle, listArticles, restoreArticle, setArticleStarred, withdrawArticle } from '../../../lib/articles';
import { listArticleDrafts, saveArticleDraft, publishArticleDraft, deleteArticleDraft, restoreArticleDraft } from '../../../lib/article-drafts';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, requireSameOrigin } from '../../../lib/http';

const readArticleBody = (request: Request) => { requireSameOrigin(request); return readJsonObject(request); };

export const GET = adminRoute(() => json({ articles: listArticles({ includeDeleted: true, includeDrafts: true }), drafts: listArticleDrafts() }));

export const POST = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.action === 'publish') return json({ ok: true, id: publishArticleDraft(body) }, 201);
  if (body.action !== 'draft') throw new HttpError(400, '请选择保存草稿或发布');
  return json({ ok: true, draft: saveArticleDraft(body) });
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.draftId && body.restore === true) { restoreArticleDraft(body); return json({ ok: true }); }
  const id = readPositiveId(body.id);
  if (body.restore === true) return restoreArticle(id) ? json({ ok: true, id }) : json({ error: '已删除的文章不存在' }, 404);
  if (body.withdraw === true) return withdrawArticle(id) ? json({ ok: true, id }) : json({ error: '公开文章不存在' }, 404);
  if (body.starred !== undefined) { setArticleStarred(id, body.starred); return json({ ok: true, id, starred: body.starred }); }
  throw new HttpError(400, '不支持的文章操作');
});

export const DELETE = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.draftId) { deleteArticleDraft(body); return json({ ok: true }); }
  const id = readPositiveId(body.id);
  return deleteArticle(id) ? json({ ok: true }) : json({ error: '文章不存在' }, 404);
});

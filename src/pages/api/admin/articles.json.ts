import { deleteArticle, listArticles, restoreArticle, setArticleStarred, withdrawArticle } from '../../../lib/articles';
import { listArticleDrafts, saveArticleDraft, publishArticleDraft, deleteArticleDraft, restoreArticleDraft } from '../../../lib/article-drafts';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, requireSameOrigin } from '../../../lib/http';
import { auditAdminMutation, type AdminAuditEvent } from '../../../lib/admin-audit';

const readArticleBody = (request: Request) => { requireSameOrigin(request); return readJsonObject(request); };

export const GET = adminRoute(() => json({ articles: listArticles({ includeDeleted: true, includeDrafts: true }), drafts: listArticleDrafts() }));

export const POST = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.action === 'publish') {
    const event: AdminAuditEvent = { objectType: 'article', objectId: typeof body.id === 'number' ? body.id : null, operation: 'publish', revision: typeof body.revision === 'number' ? body.revision : null };
    const id = auditAdminMutation(event, () => { const id = publishArticleDraft(body); event.objectId = id; return id; });
    return json({ ok: true, id }, 201);
  }
  if (body.action !== 'draft') throw new HttpError(400, '请选择保存草稿或发布');
  const event: AdminAuditEvent = { objectType: 'draft', objectId: typeof body.draftId === 'string' ? body.draftId : null, operation: 'update', revision: typeof body.revision === 'number' ? body.revision : null };
  const draft = auditAdminMutation(event, () => { const draft = saveArticleDraft(body); event.revision = draft.revision; return draft; });
  return json({ ok: true, draft });
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.draftId && body.restore === true) { auditAdminMutation({ objectType: 'draft', objectId: String(body.draftId), operation: 'restore', revision: Number(body.revision) }, () => restoreArticleDraft(body)); return json({ ok: true }); }
  const id = readPositiveId(body.id);
  if (body.restore === true) return auditAdminMutation({ objectType: 'article', objectId: id, operation: 'restore' }, () => restoreArticle(id)) ? json({ ok: true, id }) : json({ error: '已删除的文章不存在' }, 404);
  if (body.withdraw === true) return auditAdminMutation({ objectType: 'article', objectId: id, operation: 'withdraw' }, () => withdrawArticle(id)) ? json({ ok: true, id }) : json({ error: '公开文章不存在' }, 404);
  if (body.starred !== undefined) { auditAdminMutation({ objectType: 'article', objectId: id, operation: 'star' }, () => setArticleStarred(id, body.starred)); return json({ ok: true, id, starred: body.starred }); }
  throw new HttpError(400, '不支持的文章操作');
});

export const DELETE = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if (body.draftId) { auditAdminMutation({ objectType: 'draft', objectId: String(body.draftId), operation: 'delete', revision: Number(body.revision) }, () => deleteArticleDraft(body)); return json({ ok: true }); }
  const id = readPositiveId(body.id);
  return auditAdminMutation({ objectType: 'article', objectId: id, operation: 'delete' }, () => deleteArticle(id)) ? json({ ok: true }) : json({ error: '文章不存在' }, 404);
});

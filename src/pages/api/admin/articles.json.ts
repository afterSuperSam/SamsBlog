import { deleteArticle, listArticles, restoreArticle, saveArticle } from '../../../lib/articles';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';

const readArticleBody = readJsonObject;

export const GET = adminRoute(() => json({ articles: listArticles({ includeDeleted: true }) }));

export const POST = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  if ('id' in body) throw new HttpError(400, '新建文章不能携带编号');
  return json({ ok: true, id: saveArticle(body) }, 201);
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readArticleBody(request);
  const id = readPositiveId(body.id);
  if (body.restore === true) return restoreArticle(id) ? json({ ok: true, id }) : json({ error: '已删除的文章不存在' }, 404);
  return json({ ok: true, id: saveArticle(body) });
});

export const DELETE = adminRoute(async ({ request }) => {
  const id = readPositiveId((await readArticleBody(request)).id);
  return deleteArticle(id) ? json({ ok: true }) : json({ error: '文章不存在' }, 404);
});

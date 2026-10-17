import { serverConfig } from '../../../config/server';
import { deleteArticle, listArticles, restoreArticle, saveArticle } from '../../../lib/articles';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';

// 按实际读取字节限制文章请求，避免伪造或缺失 Content-Length 绕过
async function readArticleBody(request: Request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (contentLength > serverConfig.articleRequestMaxBytes) throw new HttpError(413, '文章内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容无法解析');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > serverConfig.articleRequestMaxBytes) {
        await reader.cancel();
        throw new HttpError(413, '文章内容过大');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return readJsonObject(new Request(request.url, {
    method: 'POST', headers: request.headers, body: Buffer.concat(chunks),
  }));
}

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

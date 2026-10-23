import { serverConfig } from '../../../config/server';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, readRequestBytes } from '../../../lib/http';
import { changeMediaVisibility, listMedia, mediaResponse, saveMedia } from '../../../lib/media';

export const GET = adminRoute(({ url, request }) => url.searchParams.has('preview')
  ? mediaResponse(url.searchParams.get('preview') || '', request, true)
  : json({ media: listMedia() }));

export const POST = adminRoute(async ({ request }) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站后台上传图片');
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new HttpError(415, '请使用图片上传入口');
  const bytes = await readRequestBytes(request, serverConfig.mediaMaxBytes + 65536);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType } }).formData(); }
  catch { throw new HttpError(400, '上传内容无法解析'); }
  const file = form.get('file');
  if (!(file instanceof File) || [...form.keys()].length !== 1) throw new HttpError(400, '每次请选择一张图片');
  return json({ media: await saveMedia(file) }, 201);
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  if (body.restore !== true) throw new HttpError(400, '无效的恢复操作');
  changeMediaVisibility(readPositiveId(body.id), true);
  return json({ ok: true });
});

export const DELETE = adminRoute(async ({ request }) => {
  changeMediaVisibility(readPositiveId((await readJsonObject(request)).id), false);
  return json({ ok: true });
});

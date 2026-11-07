import { serverConfig } from '../../../config/server';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';
import { changeMediaVisibility, listMedia, mediaResponse, readMediaUpload, saveMedia } from '../../../lib/media';

export const GET = adminRoute(({ url, request }) => url.searchParams.has('preview')
  ? mediaResponse(url.searchParams.get('preview') || '', request, true)
  : json({ media: listMedia() }));

export const POST = adminRoute(async ({ request }) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站后台上传图片');
  const file = await readMediaUpload(request, serverConfig.mediaMaxBytes + 65536);
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

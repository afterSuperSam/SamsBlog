import { serverConfig } from '../../../config/server';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';
import { changeMediaVisibility, listMedia, mediaResponse, readMediaUpload, saveMedia } from '../../../lib/media';
import { auditAdminMutation, recordAdminAudit } from '../../../lib/admin-audit';

export const GET = adminRoute(({ url, request }) => url.searchParams.has('preview')
  ? mediaResponse(url.searchParams.get('preview') || '', request, true)
  : json({ media: listMedia() }));

export const POST = adminRoute(async ({ request }) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站后台上传图片');
  const file = await readMediaUpload(request, serverConfig.mediaMaxBytes + 65536);
  try {
    const media = await saveMedia(file, { auditAdmin: true });
    return json({ media }, 201);
  } catch (error) {
    recordAdminAudit({ objectType: 'media', objectId: null, operation: 'create' }, error instanceof HttpError ? 'rejected' : 'failure');
    throw error;
  }
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  if (body.restore !== true) throw new HttpError(400, '无效的恢复操作');
  const id = readPositiveId(body.id);
  auditAdminMutation({ objectType: 'media', objectId: id, operation: 'restore' }, () => changeMediaVisibility(id, true));
  return json({ ok: true });
});

export const DELETE = adminRoute(async ({ request }) => {
  const id = readPositiveId((await readJsonObject(request)).id);
  auditAdminMutation({ objectType: 'media', objectId: id, operation: 'delete' }, () => changeMediaVisibility(id, false));
  return json({ ok: true });
});

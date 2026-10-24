import { listFriendApplications, reviewFriendApplication } from '../../../lib/friends';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';
export const GET = adminRoute(() => json({ applications: listFriendApplications() }));
export const PATCH = adminRoute(async ({ request, url }) => {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, '请从本站后台操作');
  const body = await readJsonObject(request);
  if (typeof body.accepted !== 'boolean') throw new HttpError(400, '请选择通过或拒绝');
  reviewFriendApplication(readPositiveId(body.id), body.accepted, body);
  return json({ ok: true });
});

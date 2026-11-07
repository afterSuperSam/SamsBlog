import { deleteSponsor, listSponsors, saveSponsor } from '../../../lib/sponsors';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';
import { auditAdminMutation, type AdminAuditEvent } from '../../../lib/admin-audit';

const readSponsorBody = async (request: Request) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站后台修改赞助信息');
  return readJsonObject(request);
};

export const GET = adminRoute(() => json({ sponsors: listSponsors() }));
export const POST = adminRoute(async ({ request }) => {
  const input = await readSponsorBody(request);
  if ('id' in input) throw new HttpError(400, '新增赞助不能携带编号');
  const event: AdminAuditEvent = { objectType: 'sponsor', objectId: null, operation: 'create' };
  auditAdminMutation(event, () => { const saved = saveSponsor(input); event.objectId = saved.id; event.revision = Date.parse(saved.updatedAt); });
  return json({ sponsors: listSponsors() }, 201);
});
export const PATCH = adminRoute(async ({ request }) => {
  const input = await readSponsorBody(request);
  readPositiveId(input.id);
  const event: AdminAuditEvent = { objectType: 'sponsor', objectId: Number(input.id), operation: 'update', revision: Date.parse(String(input.updatedAt)) };
  auditAdminMutation(event, () => { const saved = saveSponsor(input); event.revision = Date.parse(saved.updatedAt); });
  return json({ sponsors: listSponsors() });
});
export const DELETE = adminRoute(async ({ request }) => {
  const input = await readSponsorBody(request);
  auditAdminMutation({ objectType: 'sponsor', objectId: Number(input.id), operation: 'delete', revision: Date.parse(String(input.updatedAt)) }, () => deleteSponsor(input));
  return json({ sponsors: listSponsors() });
});

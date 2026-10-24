import { deleteSponsor, listSponsors, saveSponsor } from '../../../lib/sponsors';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId } from '../../../lib/http';

const readSponsorBody = async (request: Request) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站后台修改赞助信息');
  return readJsonObject(request);
};

export const GET = adminRoute(() => json({ sponsors: listSponsors() }));
export const POST = adminRoute(async ({ request }) => {
  const input = await readSponsorBody(request);
  if ('id' in input) throw new HttpError(400, '新增赞助不能携带编号');
  saveSponsor(input);
  return json({ sponsors: listSponsors() }, 201);
});
export const PATCH = adminRoute(async ({ request }) => {
  const input = await readSponsorBody(request);
  readPositiveId(input.id);
  saveSponsor(input);
  return json({ sponsors: listSponsors() });
});
export const DELETE = adminRoute(async ({ request }) => {
  deleteSponsor(await readSponsorBody(request));
  return json({ sponsors: listSponsors() });
});

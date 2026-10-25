import { deleteFriend, listFriends, parseFriendInput, saveFriend, setFriendStarred } from '../../../lib/friends';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, requireSameOrigin } from '../../../lib/http';

export const GET = adminRoute(() => json({ friends: listFriends({ includeHidden: true }) }));

export const POST = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  if ('id' in body) throw new HttpError(400, '新建友链不能携带编号');
  const id = saveFriend(parseFriendInput(body));
  return json({ ok: true, id }, 201);
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  const id = readPositiveId(body.id);
  if (body.action === 'star') {
    requireSameOrigin(request);
    return setFriendStarred(id, body.starred) ? json({ ok: true, id, starred: body.starred }) : json({ error: '友链不存在' }, 404);
  }
  return saveFriend({ ...parseFriendInput(body), id }) ? json({ ok: true, id }) : json({ error: '友链不存在' }, 404);
});

export const DELETE = adminRoute(async ({ request }) => {
  const id = readPositiveId((await readJsonObject(request)).id);
  return deleteFriend(id) ? json({ ok: true }) : json({ error: '友链不存在' }, 404);
});

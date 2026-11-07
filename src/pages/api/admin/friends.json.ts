import { deleteFriend, listFriends, parseFriendInput, saveFriend, setFriendRecommended, setFriendStarred } from '../../../lib/friends';
import { adminRoute, HttpError, json, readJsonObject, readPositiveId, requireSameOrigin } from '../../../lib/http';

export const GET = adminRoute(() => json({ friends: listFriends({ includeHidden: true }) }));

export const POST = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  if ('id' in body) throw new HttpError(400, '新建友链不能携带编号');
  const id = saveFriend(parseFriendInput(body));
  return json({ ok: true, id, revision: 1 }, 201);
});

export const PATCH = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  const id = readPositiveId(body.id);
  const revision = readPositiveId(body.revision);
  if (body.action === 'recommend') {
    requireSameOrigin(request);
    return setFriendRecommended(id, body.recommended, revision) ? json({ ok: true, id, revision: revision + 1, recommended: body.recommended }) : json({ error: '友链不存在' }, 404);
  }
  if (body.action === 'star') {
    requireSameOrigin(request);
    return setFriendStarred(id, body.starred, revision) ? json({ ok: true, id, revision: revision + 1, starred: body.starred }) : json({ error: '友链不存在' }, 404);
  }
  return saveFriend({ ...parseFriendInput(body), id, revision }) ? json({ ok: true, id, revision: revision + 1 }) : json({ error: '友链不存在' }, 404);
});

export const DELETE = adminRoute(async ({ request }) => {
  const body = await readJsonObject(request);
  const id = readPositiveId(body.id);
  return deleteFriend(id, readPositiveId(body.revision)) ? json({ ok: true }) : json({ error: '友链不存在' }, 404);
});

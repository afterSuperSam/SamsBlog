import { getFriendStatuses } from '../../../lib/friend-status';
import { listFriends } from '../../../lib/friends';
import { HttpError, json, route } from '../../../lib/http';

export const GET = route(async ({ url }) => {
  if (url.searchParams.size) throw new HttpError(400, '连通性检测不接受自定义地址');
  const statuses = await getFriendStatuses();
  return json({ statuses, friends: listFriends() });
});

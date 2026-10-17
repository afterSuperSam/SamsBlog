import { getFriendStatuses } from '../../../lib/friend-status';
import { HttpError, json, route } from '../../../lib/http';

export const GET = route(async ({ url }) => {
  if (url.searchParams.size) throw new HttpError(400, '连通性检测不接受自定义地址');
  return json({ statuses: await getFriendStatuses() });
});

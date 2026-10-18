import { getFriendFeeds } from '../../../lib/friend-feeds';
import { HttpError, json, route } from '../../../lib/http';

export const GET = route(async ({ url }) => {
  if (url.searchParams.size) throw new HttpError(400, '友链订阅不接受自定义地址');
  return json({ feeds: await getFriendFeeds() });
});
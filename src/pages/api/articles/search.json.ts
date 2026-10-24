import { searchArticleIds } from '../../../lib/articles';
import { siteConfig } from '../../../config/site';
import { HttpError, json, route } from '../../../lib/http';

export const GET = route(({ url }) => {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query || query.length > siteConfig.articles.searchMaximumLength) throw new HttpError(400, '请输入有效的搜索词');
  return json({ ids: searchArticleIds(query) });
});

import { getArticlePage } from '../../../lib/articles';
import { readArticleFilters } from '../../../lib/article-catalog';
import { siteConfig } from '../../../config/site';
import { HttpError, json, route } from '../../../lib/http';

export const GET = route(({ url }) => {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query || query.length > siteConfig.articles.searchMaximumLength) throw new HttpError(400, '请输入有效的搜索词');
  const result = getArticlePage(readArticleFilters(url.searchParams));
  return json({ ids: result.articles.map((article) => article.id), snippets: result.snippets, page: result.page, pageCount: result.pageCount, total: result.total, pageSize: result.pageSize });
});

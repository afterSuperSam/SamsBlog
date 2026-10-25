import { getNextFeaturedLink } from '../../../lib/articles';
import { articleExcerpt, renderMarkdown } from '../../../lib/markdown';
import { json, readPositiveId, route } from '../../../lib/http';

export const GET = route(({ url }) => {
  const article = getNextFeaturedLink(readPositiveId(Number(url.searchParams.get('after'))));
  return json({ article: article ? {
    id: article.id, title: article.title, externalUrl: article.externalUrl, excerpt: article.summary || articleExcerpt(article.content),
    createdAt: article.createdAt, source: article.source, category: article.category, tags: article.tags,
    starred: article.starred, html: renderMarkdown(article.content, new URL(`/articles/${article.id}`, url).href),
  } : null });
});

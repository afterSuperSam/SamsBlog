import type { APIRoute } from 'astro';
import { siteConfig } from '../../../config/site';
import { getArticleUpdates } from '../../../lib/articles';

export const GET: APIRoute = async ({ request }) => {
  const origin = request.headers.get('origin');
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    'Vary': 'Origin',
  });
  if (origin === 'https://moesam.com') headers.set('Access-Control-Allow-Origin', origin);
  const latest = getArticleUpdates(siteConfig.articles.cardCount);
  return new Response(JSON.stringify({
    name: siteConfig.name,
    url: siteConfig.siteUrl,
    description: siteConfig.description,
    icon: new URL('/media/brand/logo.jpg', siteConfig.siteUrl).toString(),
    status: 'online',
    latest,
    updatedAt: latest.reduce<string | null>((latestDate, article) => !latestDate || article.updatedAt > latestDate ? article.updatedAt : latestDate, null),
  }), { headers });
};

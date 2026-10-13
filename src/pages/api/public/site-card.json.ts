import type { APIRoute } from 'astro';
import { siteConfig } from '../../../config/site';

export const GET: APIRoute = async ({ request }) => {
  const origin = request.headers.get('origin');
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    'Vary': 'Origin',
  });
  if (origin === 'https://yingwutown.top') headers.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({
    name: siteConfig.name,
    url: siteConfig.siteUrl,
    description: siteConfig.description,
    icon: new URL('/media/brand/logo.jpg', siteConfig.siteUrl).toString(),
    status: 'online',
    latest: [],
    updatedAt: new Date().toISOString(),
  }), { headers });
};

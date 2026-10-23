import type { APIRoute } from 'astro';
import { listArticleMetadata } from '../lib/articles';

const routes = ['/', '/about'];

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL('http://localhost:4321');
  const urls = [
    ...routes.map((route) => `<url><loc>${escapeXml(new URL(route, base).toString())}</loc></url>`),
    ...listArticleMetadata().map((article) => `<url><loc>${escapeXml(new URL(`/articles/${article.id}`, base).toString())}</loc><lastmod>${escapeXml(article.updatedAt)}</lastmod></url>`),
  ].join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
};

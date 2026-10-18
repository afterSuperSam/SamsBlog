import type { APIRoute } from 'astro';
import { siteConfig } from '../config/site';
import { listArticles } from '../lib/articles';
import { renderMarkdown } from '../lib/markdown';

const xml = (value: string) => value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

export const GET: APIRoute = () => {
  const articles = listArticles().slice(0, siteConfig.articles.feedCount);
  const items = articles.map((article) => {
    const url = new URL(`/articles/${article.id}`, siteConfig.siteUrl).href;
    const content = `${article.coverUrl ? `<p><img src="${xml(article.coverUrl)}" alt="" /></p>` : ''}${renderMarkdown(article.content, url)}`;
    return `<item><title>${xml(article.title)}</title><link>${xml(url)}</link><guid isPermaLink="true">${xml(url)}</guid><pubDate>${new Date(article.createdAt).toUTCString()}</pubDate><atom:updated>${article.updatedAt}</atom:updated><category>${article.source === 'original' ? '原创' : '搬运'}</category><category>${article.category === 'discussion' ? '杂谈' : '日志'}</category><description>${xml(content)}</description></item>`;
  }).join('');
  const updated = articles.reduce((date, article) => article.updatedAt > date ? article.updatedAt : date, '');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(siteConfig.name)}</title><link>${xml(siteConfig.siteUrl)}</link><description>${xml(siteConfig.description)}</description><language>zh-CN</language><atom:link href="${xml(new URL('/rss.xml', siteConfig.siteUrl).href)}" rel="self" type="application/rss+xml"/>${updated ? `<lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
};

import type { APIRoute } from 'astro';
import { siteConfig } from '../config/site';
import { listArticles } from '../lib/articles';
import { articleExcerpt, renderMarkdown } from '../lib/markdown';
import { version } from '../../package.json';
import stylesheet from '../styles/global.css?url';
import { articleContentTypes } from '../lib/article-catalog';

const xml = (value: string) => value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

// 源码着色仅生成转义后的文本，不执行订阅正文中的 HTML。
function highlightSource(source: string): string {
  return source.split(/(<[^>]*>|&lt;[^<>]*?&gt;)/g).map((part) => {
    if (!part.startsWith('<') && !part.startsWith('&lt;')) return xml(part);
    const attributes = part.split(/("[^"]*"|&quot;.*?&quot;)/g)
      .map((value, index) => index % 2 ? `<span class="rss-source__attribute">${xml(value)}</span>` : xml(value)).join('');
    return `<span class="rss-source__tag">${attributes}</span>`;
  }).join('');
}

export const GET: APIRoute = ({ request }) => {
  const articles = listArticles({ limit: siteConfig.articles.feedCount });
  const items = articles.map((article) => {
    const url = new URL(`/articles/${article.id}`, siteConfig.rss.siteUrl).href;
    const content = `${article.coverUrl ? `<p><img src="${xml(new URL(article.coverUrl, siteConfig.rss.siteUrl).href)}" alt="" /></p>` : ''}${article.contentType === 'link' ? `<p><a href="${xml(article.externalUrl)}">打开推荐链接</a></p>` : ''}${renderMarkdown(article.content, url)}`;
    return `<item>
<title>${xml(article.title)}</title>
<link>${xml(url)}</link>
<guid isPermaLink="true">${xml(url)}</guid>
<description>${xml(article.summary || articleExcerpt(article.content))}</description>
<pubDate>${new Date(article.createdAt).toUTCString()}</pubDate>
<atom:updated>${article.updatedAt}</atom:updated>
<category>${article.source === 'original' ? '原创' : '搬运'}</category>
<category>${article.category === 'discussion' ? '杂谈' : '日志'}</category>
<category>${articleContentTypes.find((type) => type.value === article.contentType)!.label}</category>
<content:encoded>${xml(content)}</content:encoded>
</item>`;
  }).join('\n');
  const updated = articles.reduce((date, article) => article.updatedAt > date ? article.updatedAt : date, '');
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
<channel>
<title>${xml(siteConfig.name)}</title>
<description>${xml(siteConfig.rss.description)}</description>
<link>${xml(siteConfig.rss.siteUrl)}</link>
<templateTheme>${xml(siteConfig.name)}</templateTheme>
<templateThemeVersion>${xml(version)}</templateThemeVersion>
<templateThemeUrl>${xml(siteConfig.rss.siteUrl)}</templateThemeUrl>
<language>zh-CN</language>
<atom:link href="${xml(new URL('/rss.xml', siteConfig.rss.siteUrl).href)}" rel="self" type="application/rss+xml"/>
${updated ? `<lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>` : ''}
${items}
</channel>
</rss>`;
  const preview = request?.headers.get('sec-fetch-dest') === 'document'
    && request.headers.get('accept')?.includes('text/html')
    && !new URL(request.url).searchParams.has('raw');
  let depth = 0;
  const source = feed.split('\n').map((line) => {
    if (/^<\/(rss|channel|item)>$/.test(line)) depth--;
    const indented = `${'  '.repeat(depth)}${line}`;
    if (/^<(rss\b[^>]*|channel|item)>$/.test(line)) depth++;
    return indented;
  }).join('\n');
  const body = preview ? `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SamsBlog · RSS 源码</title><link rel="stylesheet" href="${xml(stylesheet)}"><link rel="alternate" type="application/rss+xml" href="${xml(new URL('/rss.xml', siteConfig.rss.siteUrl).href)}"></head><body class="rss-source"><header><h1>SamsBlog <span>RSS</span></h1><p>${xml(siteConfig.rss.description)}</p><a href="/rss.xml?raw">原始 XML</a></header><main aria-label="RSS 源码"><pre><code>${highlightSource(source)}</code></pre></main></body></html>` : feed;
  return new Response(body, {
    headers: { 'Content-Type': `${preview ? 'text/html' : 'application/rss+xml'}; charset=utf-8`, 'Cache-Control': 'no-cache', Vary: 'Accept, Sec-Fetch-Dest' },
  });
};

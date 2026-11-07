import type Database from 'better-sqlite3';
import { siteConfig } from '../config/site';
import { articlePlainText } from './markdown';

export const normalizeArticleText = (text: string) => text.normalize('NFKC').toLocaleLowerCase('zh-CN');

// 单字与相邻双字编码不依赖分词语言，FTS 查询只接收内部生成的 ASCII token。
export function articleSearchTokens(text: string, query = false): string {
  const characters = Array.from(normalizeArticleText(text));
  const tokens = new Set<string>();
  const encoded = characters.map((character) => character.codePointAt(0)!.toString(16));
  for (let index = 0; index < encoded.length; index += 1) {
    if (!query || encoded.length === 1) tokens.add(`u${encoded[index]}`);
    if (index + 1 < encoded.length) tokens.add(`b${encoded[index]}z${encoded[index + 1]}`);
  }
  return [...tokens].join(query ? ' AND ' : ' ');
}

// 旧数据仅在首次迁移建索引；后续读取只处理写入触发器留下的失效编号。
export function synchronizeArticleSearch(database: Database.Database) {
  const select = database.prepare(`SELECT a.id, a.title, a.summary, a.content FROM blog_article_search_pending p
    JOIN blog_articles a ON a.id = p.article_id WHERE a.deleted_at IS NULL AND a.publication_status = 'published' LIMIT ?`);
  const insert = database.prepare('INSERT OR REPLACE INTO blog_article_search (article_id, plain_text, normalized_text) VALUES (?, ?, ?)');
  const insertIndex = database.prepare('INSERT INTO blog_article_search_fts (rowid, tokens) VALUES (?, ?)');
  const clear = database.prepare('DELETE FROM blog_article_search_pending WHERE article_id = ?');
  database.transaction(() => {
    let rows: Array<{ id: number; title: string; summary: string; content: string }>;
    do {
      rows = select.all(siteConfig.articles.searchIndexBatchSize) as typeof rows;
      for (const row of rows) {
        const text = `${row.title} ${row.summary} ${articlePlainText(row.content)}`.trim();
        insert.run(row.id, text, normalizeArticleText(text));
        insertIndex.run(row.id, articleSearchTokens(text));
        clear.run(row.id);
      }
    } while (rows.length === siteConfig.articles.searchIndexBatchSize);
  })();
}

export interface ArticleTextPart { text: string; highlighted: boolean }

// 原文与规范化字符保留位置映射，模板只输出文本节点与 mark，不拼接 HTML。
export function articleHighlight(text: string, query: string): ArticleTextPart[] {
  const needle = normalizeArticleText(query);
  if (!needle) return [{ text, highlighted: false }];
  const positions: Array<{ start: number; end: number }> = [];
  let normalized = '';
  for (const { segment, index } of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)) {
    const value = normalizeArticleText(segment);
    normalized += value;
    for (let offset = 0; offset < value.length; offset += 1) positions.push({ start: index, end: index + segment.length });
  }
  const parts: ArticleTextPart[] = [];
  let cursor = 0;
  let match = normalized.indexOf(needle);
  while (match !== -1) {
    const start = positions[match].start;
    const end = positions[match + needle.length - 1].end;
    if (start >= cursor) {
      if (start > cursor) parts.push({ text: text.slice(cursor, start), highlighted: false });
      parts.push({ text: text.slice(start, end), highlighted: true });
      cursor = end;
    }
    match = normalized.indexOf(needle, match + needle.length);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

export function articleSearchSnippet(text: string, query: string): ArticleTextPart[] {
  const parts = articleHighlight(text, query);
  const first = parts.findIndex((part) => part.highlighted);
  const before = first < 0 ? '' : parts.slice(0, first).map((part) => part.text).join('');
  const start = Math.max(0, Array.from(before).length - siteConfig.articles.searchSnippetContext);
  const characters = Array.from(text);
  const end = Math.min(characters.length, start + Math.max(siteConfig.articles.searchSnippetLength, Array.from(query).length + siteConfig.articles.searchSnippetContext));
  return articleHighlight(`${start ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`, query);
}

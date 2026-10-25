import { siteConfig } from '../config/site';

export const articleCardLayouts = [
  { value: 'left', label: '左图右文' },
  { value: 'right', label: '右图左文' },
  { value: 'text', label: '纯文字' },
] as const;
export type ArticleCardLayout = typeof articleCardLayouts[number]['value'];

export const articleContentTypes = [
  { value: 'article', label: '长文章' },
  { value: 'note', label: '短记录' },
  { value: 'link', label: '外部链接' },
  { value: 'update', label: '更新记录' },
] as const;
export type ArticleContentType = typeof articleContentTypes[number]['value'];

export function articleDateLabel(value: string, compact = false): string {
  if (!value) return '待发布';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: compact ? '2-digit' : 'long',
    day: compact ? '2-digit' : 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).replaceAll('/', '.');
}

export function articleLinkHost(value: string): string {
  try { return new URL(value).hostname; }
  catch { return ''; }
}

export interface ArticleFilters {
  contentType: string;
  source: string;
  category: string;
  sort: string;
  starred: string;
  tag: string;
  period: string;
  q: string;
  view: string;
}

export interface CatalogArticle {
  id: number;
  contentType: ArticleContentType;
  source: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  search: string;
  starred: boolean;
}

const normalizeText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN');
const monthFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' });

// 编辑器和接口共用标签规则；数据库仅保存去重后的文本数组。
export function parseArticleTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('标签需要使用列表');
  const tags = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('标签必须是文本');
    const normalized = item.normalize('NFKC');
    const tag = normalized.trim().replace(/^#+\s*/, '').replace(/\s+/g, ' ');
    if (!tag || /[\p{Cc}\p{Cf}#,]/u.test(normalized.replace(/^ *#+/, ''))) throw new Error('标签不能为空，也不能包含逗号、井号或控制字符');
    if ([...tag].length > siteConfig.articles.tagMaximumLength) throw new Error(`每个标签最多 ${siteConfig.articles.tagMaximumLength} 个字`);
    tags.set(normalizeText(tag), tags.get(normalizeText(tag)) ?? tag);
    if (tags.size > siteConfig.articles.maximumTags) throw new Error(`每篇文章最多 ${siteConfig.articles.maximumTags} 个标签`);
  }
  return [...tags.values()];
}

export function articleMonth(value: string): string {
  const parts = monthFormatter.formatToParts(new Date(value));
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`;
}

// 每篇内容对同一标签只计一次，筛选栏按使用次数展示常用标签。
export function rankArticleTags(articles: Pick<CatalogArticle, 'tags'>[]) {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const article of articles) {
    const seen = new Set<string>();
    for (const tag of article.tags) {
      const key = normalizeText(tag);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) || { tag, count: 0 };
      entry.count += 1;
      if (tag.localeCompare(entry.tag, 'zh-CN') < 0) entry.tag = tag;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((first, second) => second.count - first.count || first.tag.localeCompare(second.tag, 'zh-CN'));
}

export function readArticleFilters(parameters: URLSearchParams): ArticleFilters {
  const select = (name: string, values: string[], fallback = '') => values.includes(parameters.get(name) || '') ? parameters.get(name)! : fallback;
  const period = parameters.get('period') || '';
  return {
    contentType: select('contentType', articleContentTypes.map((type) => type.value)),
    source: select('source', ['original', 'repost']),
    category: select('category', ['discussion', 'journal']),
    sort: select('sort', ['created-desc', 'created-asc', 'updated-desc', 'updated-asc'], 'created-desc'),
    starred: select('starred', ['1']),
    tag: (parameters.get('tag') || '').normalize('NFKC').trim().slice(0, siteConfig.articles.tagMaximumLength * 2),
    period: /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(period) ? period : '',
    q: (parameters.get('q') || '').trim().slice(0, siteConfig.articles.searchMaximumLength),
    view: select('view', ['archive'], 'list'),
  };
}

export function matchesArticle(article: CatalogArticle, filters: ArticleFilters): boolean {
  return (!filters.contentType || article.contentType === filters.contentType)
    && (!filters.source || article.source === filters.source)
    && (!filters.category || article.category === filters.category)
    && (!filters.starred || article.starred)
    && (!filters.tag || article.tags.some((tag) => normalizeText(tag) === normalizeText(filters.tag)))
    && (!filters.period || articleMonth(article.createdAt).startsWith(filters.period))
    && (!filters.q || normalizeText(article.search).includes(normalizeText(filters.q)));
}

export function compareArticles(first: CatalogArticle, second: CatalogArticle, filters: ArticleFilters): number {
  const direction = filters.sort.endsWith('asc') ? 1 : -1;
  if (filters.view === 'archive') {
    const monthOrder = articleMonth(first.createdAt).localeCompare(articleMonth(second.createdAt));
    if (monthOrder) return monthOrder * direction;
  }
  const key = filters.sort.startsWith('updated') ? 'updatedAt' : 'createdAt';
  return (Date.parse(first[key]) - Date.parse(second[key]) || first.id - second.id) * direction;
}

export function articleFilterParameters(filters: ArticleFilters): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value && !(name === 'sort' && value === 'created-desc') && !(name === 'view' && value === 'list')) parameters.set(name, value);
  }
  return parameters;
}

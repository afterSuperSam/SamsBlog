import { describe, expect, it } from 'vitest';
import { articleMonth, readArticleFilters, parseArticleTags, matchesArticle, compareArticles, articleFilterParameters, rankArticleTags, type CatalogArticle } from '../src/lib/article-catalog';
import { siteConfig } from '../src/config/site';

const article: CatalogArticle = { id: 1, contentType: 'article', source: 'original', category: 'journal', tags: ['TinyML', '日常'], createdAt: '2026-09-30T16:05:00Z', updatedAt: '2026-10-24T00:00:00Z', search: 'TinyML 实验 上海的日常记录', starred: false };

describe('article tags and catalog', () => {
  it('ranks tags by article count, counts equivalent tags once and breaks ties consistently', () => {
    const articles = [{ tags: ['A', 'Ａ', 'D'] }, { tags: ['B', 'D', 'C'] }, { tags: ['B', 'D'] }];
    const tags = rankArticleTags(articles);
    expect(tags.map(({ tag, count }) => [tag.normalize('NFKC'), count])).toEqual([['D', 3], ['B', 2], ['A', 1], ['C', 1]]);
    expect(tags.slice(0, siteConfig.articles.initialVisibleTagCount)).toHaveLength(3);
    expect(rankArticleTags([...articles].reverse())).toEqual(tags);
    expect(rankArticleTags([])).toEqual([]);
  });

  it('combines starred filtering with tags, search and archive state in shareable URLs', () => {
    const filters = readArticleFilters(new URLSearchParams('starred=1&tag=TinyML&q=日常&view=archive&period=2026-10&sort=created-asc'));
    expect(matchesArticle(article, filters)).toBe(false);
    expect(matchesArticle({ ...article, starred: true }, filters)).toBe(true);
    expect(matchesArticle({ ...article, starred: true, tags: ['其他'] }, filters)).toBe(false);
    expect(readArticleFilters(articleFilterParameters(filters))).toEqual(filters);
    expect(articleFilterParameters(filters).get('starred')).toBe('1');
    expect(readArticleFilters(new URLSearchParams('starred=invalid')).starred).toBe('');
    expect(matchesArticle(article, readArticleFilters(new URLSearchParams()))).toBe(true);
  });
  it('combines content type with existing filters and preserves it in shared URLs', () => {
    const filters = readArticleFilters(new URLSearchParams('contentType=note&category=journal&view=archive'));
    expect(matchesArticle(article, filters)).toBe(false);
    expect(matchesArticle({ ...article, contentType: 'note' }, filters)).toBe(true);
    expect(readArticleFilters(articleFilterParameters(filters))).toEqual(filters);
    expect(readArticleFilters(new URLSearchParams('contentType=unknown')).contentType).toBe('');
  });
  it('normalizes optional hashes, full width text and duplicate tags while preserving readable labels', () => {
    expect(parseArticleTags([' # TinyML ', 'tinyml', '＃ＴｉｎｙＭＬ', '生活  日常'])).toEqual(['TinyML', '生活 日常']);
    expect(parseArticleTags(undefined)).toEqual([]);
  });

  it.each([null, '标签', [1], [''], ['#'], ['a,b'], ['a，b'], ['a#b'], ['a\nb'], ['a\u200bb'], ['长'.repeat(siteConfig.articles.tagMaximumLength + 1)], Array.from({ length: siteConfig.articles.maximumTags + 1 }, (_, index) => `tag${index}`)])('rejects invalid or oversized tag input %#', (tags) => {
    expect(() => parseArticleTags(tags)).toThrow();
  });

  it('uses Beijing publication months at the UTC boundary, regardless of host timezone', () => {
    expect(articleMonth('2026-09-30T15:59:59Z')).toBe('2026-09');
    expect(articleMonth(article.createdAt)).toBe('2026-10');
    expect(articleMonth('2026-12-31T16:00:00Z')).toBe('2027-01');
  });

  it('combines search, source, category, tags and publication period', () => {
    const filters = readArticleFilters(new URLSearchParams('source=original&category=journal&tag=tinyml&period=2026-10&q=ＴＩＮＹＭＬ'));
    expect(matchesArticle(article, filters)).toBe(true);
    for (const change of [{ source: 'repost' }, { category: 'discussion' }, { tag: 'Tiny' }, { period: '2026-09' }, { q: '不存在' }]) expect(matchesArticle(article, { ...filters, ...change })).toBe(false);
    expect(matchesArticle(article, { ...filters, period: '2026' })).toBe(true);
  });

  it('normalizes untrusted query parameters and keeps shareable state without defaults', () => {
    const filters = readArticleFilters(new URLSearchParams('source=deleted&category=other&sort=bad&period=2026-13&view=hidden&q=' + 'a'.repeat(200)));
    expect(filters).toMatchObject({ source: '', category: '', sort: 'created-desc', period: '', view: 'list' });
    expect(filters.q.length).toBe(siteConfig.articles.searchMaximumLength);
    const selected = readArticleFilters(new URLSearchParams('tag=C%2B%2B&view=archive&period=2026-10&sort=updated-asc'));
    expect(readArticleFilters(articleFilterParameters(selected))).toEqual(selected);
    expect(articleFilterParameters(readArticleFilters(new URLSearchParams())).toString()).toBe('');
  });

  it('uses stable date ordering and keeps publication months together in archive view', () => {
    const previous = { ...article, id: 2, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
    const filters = readArticleFilters(new URLSearchParams('sort=updated-desc'));
    expect([article, previous].sort((first, second) => compareArticles(first, second, filters))[0].id).toBe(2);
    expect([article, previous].sort((first, second) => compareArticles(first, second, { ...filters, view: 'archive' }))[0].id).toBe(1);
    expect(compareArticles(article, { ...article, id: 3 }, filters)).toBeGreaterThan(0);
  });
});

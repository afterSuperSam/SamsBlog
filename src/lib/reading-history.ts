import { siteConfig } from '../config/site';

export interface ReadingPosition {
  version: string; progress: number; heading: string; offset: number; updatedAt: number;
  title?: string; visitedAt?: number;
}

// 阅读路径和断点共用一个本机存储，兼容没有标题的旧断点。
export function parseReadingHistory(raw: string | null): Record<string, ReadingPosition> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([identifier, value]) => /^\d+$/.test(identifier)
    && Number.isSafeInteger(Number(identifier)) && Number(identifier) > 0
    && value && typeof value.version === 'string' && typeof value.heading === 'string'
    && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1
    && Number.isFinite(value.offset) && Number.isFinite(value.updatedAt) && value.updatedAt > 0 && value.updatedAt <= 8.64e15
    && (value.title === undefined || typeof value.title === 'string')
    && (value.visitedAt === undefined || (Number.isFinite(value.visitedAt) && value.visitedAt > 0 && value.visitedAt <= 8.64e15)))
    .sort((left, right) => (right[1].visitedAt || right[1].updatedAt) - (left[1].visitedAt || left[1].updatedAt))
    .slice(0, siteConfig.articleReading.positionLimit));
}

export function readReadingHistory() {
  return parseReadingHistory(localStorage.getItem(siteConfig.articleReading.positionStorageKey));
}

// 以当前公开目录过滤阅读记录，首页也能找回没有出现在精选列表里的文章。
export function getReadingTrail(history: Record<string, ReadingPosition>, articles: readonly { id: number; title: string; updatedAt: string }[], limit: number) {
  const published = new Map(articles.map((article) => [String(article.id), article]));
  return Object.entries(history).filter(([id]) => published.has(id))
    .sort((first, second) => (second[1].visitedAt || second[1].updatedAt) - (first[1].visitedAt || first[1].updatedAt))
    .slice(0, limit).map(([id, record]) => ({
      id, title: published.get(id)!.title, visitedAt: record.visitedAt || record.updatedAt,
      progress: published.get(id)!.updatedAt === record.version ? record.progress : 0,
    }));
}

export function saveReadingHistory(entries: Record<string, ReadingPosition>) {
  localStorage.setItem(siteConfig.articleReading.positionStorageKey, JSON.stringify(parseReadingHistory(JSON.stringify(entries))));
}

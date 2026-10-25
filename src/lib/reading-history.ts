import { siteConfig } from '../config/site';

export function parseReadingTypography(raw: string | null): { fontSize: number; spacing: 'standard' | 'relaxed' } {
  const configuration = siteConfig.articleReading;
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : null; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const fontSize = typeof record.fontSize === 'number' && Number.isSafeInteger(record.fontSize) && record.fontSize >= configuration.fontSizeMinimum && record.fontSize <= configuration.fontSizeMaximum
    && (record.fontSize - configuration.fontSizeMinimum) % configuration.fontSizeStep === 0 ? record.fontSize : configuration.fontSizeDefault;
  return { fontSize, spacing: record.spacing === 'relaxed' ? 'relaxed' : 'standard' };
}

export interface ReadingPosition {
  version: string; progress: number; heading: string; offset: number; updatedAt: number;
  title?: string; visitedAt?: number;
}

// 章节长度包含其子标题，按实际排版高度计算占比与阅读进度。
export function measureReadingChapters(headings: readonly { top: number; level: number }[], contentEnd: number, readingLine: number) {
  const lengths = headings.map((heading, index) => Math.max(1,
    (headings.slice(index + 1).find((next) => next.level <= heading.level)?.top ?? contentEnd) - heading.top));
  const maximum = Math.max(1, ...lengths);
  return headings.map((heading, index) => ({
    lengthRatio: lengths[index] / maximum,
    progress: Math.max(0, Math.min(1, (readingLine - heading.top) / lengths[index])),
  }));
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

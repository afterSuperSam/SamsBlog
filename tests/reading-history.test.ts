import { describe, expect, it } from 'vitest';
import { parseReadingHistory, getReadingTrail, measureReadingChapters, parseReadingTypography } from '../src/lib/reading-history';
import { siteConfig } from '../src/config/site';

const record = { version: 'v1', progress: .4, heading: 'article-heading-test', offset: 20, updatedAt: 1 };

describe('local reading typography', () => {
  it('restores bounded sizes and supported spacing, falling back independently', () => {
    expect(parseReadingTypography('{')).toEqual({ fontSize: 20, spacing: 'standard' });
    expect(parseReadingTypography(null)).toEqual({ fontSize: 20, spacing: 'standard' });
    expect(parseReadingTypography('[]')).toEqual({ fontSize: 20, spacing: 'standard' });
    expect(parseReadingTypography('{"fontSize":26,"spacing":"relaxed"}')).toEqual({ fontSize: 26, spacing: 'relaxed' });
    for (const fontSize of [17, 19, 99, '22', null]) expect(parseReadingTypography(JSON.stringify({ fontSize, spacing: 'relaxed' }))).toEqual({ fontSize: 20, spacing: 'relaxed' });
    expect(parseReadingTypography('{"fontSize":22,"spacing":"malformed"}')).toEqual({ fontSize: 22, spacing: 'standard' });
  });
});

describe('chapter reading progress', () => {
  it('includes nested sections in their parent length and measures each section independently', () => {
    const progress = measureReadingChapters([{ top: 0, level: 2 }, { top: 200, level: 3 }, { top: 600, level: 2 }], 800, 300);
    expect(progress).toEqual([
      { lengthRatio: 1, progress: .5 },
      { lengthRatio: 2 / 3, progress: .25 },
      { lengthRatio: 1 / 3, progress: 0 },
    ]);
  });
  it('handles empty content and coincident headings without invalid progress', () => {
    expect(measureReadingChapters([], 0, 0)).toEqual([]);
    expect(measureReadingChapters([{ top: 100, level: 2 }, { top: 100, level: 2 }], 100, 0).every((chapter) => chapter.progress === 0)).toBe(true);
    expect(measureReadingChapters([{ top: 100, level: 2 }], 200, 300)[0].progress).toBe(1);
  });
});

describe('local reading trail', () => {
  it('preserves older positions and rejects corrupt or unsafe records', () => {
    expect(parseReadingHistory(null)).toEqual({});
    expect(parseReadingHistory('{')).toEqual({});
    expect(parseReadingHistory('[]')).toEqual({});
    expect(parseReadingHistory(JSON.stringify({ 1: record, 2: { ...record, progress: 2 }, 3: { ...record, visitedAt: 9e30 }, bad: record }))).toEqual({ 1: record });
  });
  it('bounds stored entries by most recent visit while retaining progress', () => {
    const entries = Object.fromEntries(Array.from({ length: siteConfig.articleReading.positionLimit + 10 }, (_, index) => [index + 1, { ...record, visitedAt: index + 1 }]));
    const history = parseReadingHistory(JSON.stringify(entries));
    expect(Object.keys(history)).toHaveLength(siteConfig.articleReading.positionLimit);
    expect(history['1']).toBeUndefined();
    expect(history[String(siteConfig.articleReading.positionLimit + 10)].progress).toBe(.4);
  });
  it('selects the latest public article even when it is not a featured article', () => {
    const history = { 1: { ...record, visitedAt: 1 }, 2: { ...record, visitedAt: 3 }, 3: { ...record, visitedAt: 5 } };
    expect(getReadingTrail(history, [{ id: 1, title: '最新发布', updatedAt: 'v1' }, { id: 2, title: '旧文章的新标题', updatedAt: 'v1' }], 1))
      .toEqual([{ id: '2', title: '旧文章的新标题', visitedAt: 3, progress: .4 }]);
  });
  it('does not display an obsolete position after the article changes', () => {
    expect(getReadingTrail({ 1: record }, [{ id: 1, title: '文章', updatedAt: 'v2' }], 6)[0].progress).toBe(0);
    expect(getReadingTrail({ 1: record }, [], 6)).toEqual([]);
  });
});

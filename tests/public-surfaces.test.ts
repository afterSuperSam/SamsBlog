import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReaderSurfacePath } from '../src/lib/reader-surface-geometry';

const styles = readFileSync(new URL('../src/styles/surfaces.css', import.meta.url), 'utf8');

describe('server-rendered C2 surface masks', () => {
  it('uses all four fixed SVG quadrants from the proven C2 geometry without a stretched whole-box clip', () => {
    const images = [...styles.matchAll(/url\("data:image\/svg\+xml,([^\"]+)"\)/g)].map((match) => decodeURIComponent(match[1]));
    expect(images).toHaveLength(4);
    expect(images.map((image) => image.match(/viewBox="([^"]+)"/)?.[1])).toEqual(['0 0 1 1', '1 0 1 1', '1 1 1 1', '0 1 1 1']);
    for (const image of images) {
      expect(image.match(/ d="([^"]+)"/)?.[1]).toBe(createReaderSurfacePath(2, 2, 1));
      expect(image).toContain('fill="white"');
    }
    expect(styles).toContain('--c2-clip:inset(0)');
    expect(styles).not.toContain('public-c2-fallback');
  });
});

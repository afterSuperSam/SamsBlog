import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReaderSurfacePath, initializeReaderSurfaces, readerCornerControls, type SurfacePoint } from '../src/lib/reader-surface-geometry';

const difference = (first: SurfacePoint, second: SurfacePoint, scale = 1): SurfacePoint => [(first[0] - second[0]) * scale, (first[1] - second[1]) * scale];
const acceleration = (first: SurfacePoint, middle: SurfacePoint, last: SurfacePoint): SurfacePoint => [(last[0] - 2 * middle[0] + first[0]) * 6, (last[1] - 2 * middle[1] + first[1]) * 6];

describe('reader surface geometry', () => {
  it('joins straight edges with zero curvature and both corner halves with equal first/second derivatives', () => {
    const points = readerCornerControls(60);
    expect(acceleration(points[0], points[1], points[2])).toEqual([0, 0]);
    expect(acceleration(points[4], points[5], points[6])).toEqual([0, 0]);
    expect(difference(points[1], points[0], 3)).toEqual([60, 0]);
    expect(difference(points[6], points[5], 3)).toEqual([0, 60]);
    expect(difference(points[3], points[2], 3)).toEqual(difference(points[4], points[3], 3));
    expect(acceleration(points[1], points[2], points[3])).toEqual(acceleration(points[3], points[4], points[5]));
  });
  it('has nonnegative curvature increasing to the corner midpoint then decreasing symmetrically', () => {
    const controls = readerCornerControls(1);
    const curvature = (points: readonly SurfacePoint[], time: number) => {
      const velocity = [0, 1].map((axis) => 3 * ((1 - time) ** 2 * (points[1][axis] - points[0][axis]) + 2 * (1 - time) * time * (points[2][axis] - points[1][axis]) + time ** 2 * (points[3][axis] - points[2][axis])));
      const acceleration = [0, 1].map((axis) => 6 * ((1 - time) * (points[2][axis] - 2 * points[1][axis] + points[0][axis]) + time * (points[3][axis] - 2 * points[2][axis] + points[1][axis])));
      return (velocity[0] * acceleration[1] - velocity[1] * acceleration[0]) / Math.hypot(...velocity) ** 3;
    };
    let previous = -1;
    for (let sample = 0; sample <= 100; sample++) {
      const time = sample / 100;
      const value = curvature(controls.slice(0, 4), time);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeCloseTo(curvature(controls.slice(3), 1 - time), 10);
      previous = value;
    }
  });
  it.each([[940, 260, 64], [320, 700, 64], [72, 100, 40], [96, 108, 40], [110, 44, 100], [1, 1, 50]])('keeps every control point in the box %s × %s and closes a monotone outline', (width, height, radius) => {
    const path = createReaderSurfacePath(width, height, radius);
    expect(path.endsWith(' Z')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(8);
    const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    coordinates.forEach((value, index) => { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(index % 2 ? height : width); });
    const corner = readerCornerControls(Math.min(radius, width / 2, height / 2));
    corner.slice(1).forEach((point, index) => { expect(point[0]).toBeGreaterThanOrEqual(corner[index][0]); expect(point[1]).toBeGreaterThanOrEqual(corner[index][1]); });
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid dimensions %s', (invalid) => {
    expect(() => createReaderSurfacePath(invalid, 10, 2)).toThrow(RangeError);
    expect(() => createReaderSurfacePath(10, invalid, 2)).toThrow(RangeError);
    expect(() => createReaderSurfacePath(10, 10, invalid)).toThrow(RangeError);
  });
});

describe('reader first-frame surface preparation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const initialize = (enabled = true) => {
    const dataset: Record<string, string> = enabled ? { readerSurfaceTimeout: '2000' } : {};
    const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    runInNewContext(readFileSync(new URL('../public/scripts/page-presentation.js', import.meta.url), 'utf8'), {
      document: { documentElement: { dataset, classList: { contains: () => false, toggle: () => {} } }, querySelector: () => null },
      location: { pathname: '/reader' }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null },
      window: { addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, [...(listeners.get(name) || []), listener]) },
      setTimeout, clearTimeout, console,
    });
    return { dataset, emit: (name: string, event = {}) => listeners.get(name)?.forEach((listener) => listener(event)) };
  };
  it('waits only on the account page and clears its fallback deadline when geometry is ready', () => {
    const page = initialize();
    expect(page.dataset.readerSurfaces).toBe('pending');
    page.dataset.readerSurfaces = 'ready'; page.emit('reader:surfaces-ready');
    expect(page.dataset.readerSurfaces).toBe('ready'); expect(vi.getTimerCount()).toBe(0);
    expect(initialize(false).dataset.readerSurfaces).toBeUndefined();
  });
  it('reveals the borderless fallback if the page module fails or never loads', async () => {
    const page = initialize();
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.dataset.readerSurfaces).toBeUndefined();
  });
  it('releases immediately on restored navigation and avoids a snapshot of unfinished geometry', () => {
    const page = initialize(); const skipTransition = vi.fn();
    page.emit('pagereveal', { viewTransition: { skipTransition } });
    expect(skipTransition).toHaveBeenCalledOnce();
    page.emit('pageshow', { persisted: true });
    expect(page.dataset.readerSurfaces).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it('writes the initial path synchronously before revealing, without waiting for ResizeObserver', () => {
    const values = new Map<string, string>();
    const element = { matches: () => false, classList: { add: vi.fn() }, getBoundingClientRect: () => ({ width: 800, height: 200 }), style: { setProperty: (key: string, value: string) => values.set(key, value) } };
    const root = { matches: (selector: string) => selector === '[data-reader-account-page]', querySelectorAll: () => [element] } as unknown as HTMLElement;
    const documentRoot = { dataset: { readerSurfaces: 'pending' } };
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    vi.stubGlobal('MutationObserver', class { observe() {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '52px' }));
    vi.stubGlobal('document', { documentElement: documentRoot });
    vi.stubGlobal('window', { dispatchEvent: () => { expect(values.get('--reader-surface-path')).toContain('path("M '); } });
    initializeReaderSurfaces(root);
    expect(documentRoot.dataset.readerSurfaces).toBe('ready');
  });
});

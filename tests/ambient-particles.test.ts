import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ambientMotePositions, createConstellationConnections, initializeAmbientParticles } from '../src/lib/ambient-particles';
import { siteConfig } from '../src/config/site';

const points = ambientMotePositions.slice(0, siteConfig.effects.particleCount).map(([x, y], index) => ({ index, x, y, desktopOnly: index >= siteConfig.effects.mobileParticleCount }));

function createScene(options: { reduced?: boolean; hidden?: boolean; compact?: boolean } = {}) {
  const classes = new Set<string>();
  const document = Object.assign(new EventTarget(), { hidden: options.hidden ?? false, documentElement: { classList: { contains: (name: string) => classes.has(name) } } });
  const window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720, scrollY: 0, setTimeout, clearTimeout });
  const reduced = Object.assign(new EventTarget(), { matches: options.reduced ?? false });
  const compact = Object.assign(new EventTarget(), { matches: options.compact ?? false });
  const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
  const layers = [0, 1].map(() => {
    const paths = Array.from({ length: siteConfig.effects.constellation.desktopLineCount }, () => {
      const attributes = new Map<string, string>();
      return { attributes, setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) };
    });
    return { paths, style: { opacity: '' }, querySelectorAll: () => paths, animate: vi.fn(() => { const animation = { cancel: vi.fn() }; animations.push(animation); return animation; }) };
  });
  const particles = points.map(({ x, y, desktopOnly }) => ({ dataset: { moteLeft: String(x), moteTop: String(y) }, style: { setProperty: vi.fn() }, classList: { contains: () => desktopOnly } }));
  const scene = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn() }, querySelectorAll: (selector: string) => selector === '[data-constellation]' ? layers : particles };
  let preferenceChanged = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('matchMedia', (query: string) => query.includes('reduced-motion') ? reduced : compact);
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { preferenceChanged = callback; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const dispose = initializeAmbientParticles(scene as unknown as HTMLElement);
  const page = (name: string, persisted: boolean) => window.dispatchEvent(Object.assign(new Event(name), { persisted }));
  return { scene, document, window, reduced, compact, classes, layers, animations, disconnect, dispose, page, preferenceChanged: () => preferenceChanged() };
}

describe('restored sparse particle background', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([[1280, 720, false], [320, 720, true]] as const)('bounds connections by visible points, distance and degree at %i×%i', (width, height, compact) => {
    let seed = 47;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    let totalConnections = 0;
    for (let sample = 0; sample < 40; sample++) {
      const connections = createConstellationConnections(points, width, height, compact, random);
      const configuration = siteConfig.effects.constellation;
      expect(connections.length).toBeLessThanOrEqual(compact ? configuration.mobileLineCount : configuration.desktopLineCount);
      const degrees = new Map<number, number>();
      const pairs = new Set<string>();
      for (const { first, second } of connections) {
        if (compact) expect(first.desktopOnly || second.desktopOnly).toBe(false);
        expect(first.index).not.toBe(second.index);
        expect(Math.hypot((first.x - second.x) * width / 100, (first.y - second.y) * height / 100)).toBeLessThanOrEqual(Math.hypot(width, height) * configuration.maximumDistanceRatio);
        pairs.add([first.index, second.index].sort((left, right) => left - right).join(':'));
        for (const point of [first, second]) degrees.set(point.index, (degrees.get(point.index) ?? 0) + 1);
      }
      expect(pairs.size).toBe(connections.length);
      expect(degrees.size).toBeLessThanOrEqual(compact ? configuration.mobilePointCount : configuration.desktopPointCount);
      expect([...degrees.values()].every((degree) => degree <= configuration.maximumDegree)).toBe(true);
      totalConnections += connections.length;
    }
    expect(totalConnections).toBeGreaterThan(0);
  });

  it('allows empty constellations and ignores invalid viewport dimensions', () => {
    expect(createConstellationConnections(points, 1280, 720, false, () => .99)).toEqual([]);
    expect(createConstellationConnections(points, 0, 720, false)).toEqual([]);
    expect(createConstellationConnections(points, 1280, Number.NaN, false)).toEqual([]);
  });

  it('uses one slow timer, coalesces scroll and stops work for pause, reduction and hidden pages', () => {
    const scene = createScene();
    expect(scene.scene.dataset).toHaveProperty('particlesReady');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(siteConfig.effects.constellation.refreshMilliseconds);
    expect(scene.animations).toHaveLength(2);
    scene.window.dispatchEvent(new Event('scroll')); scene.window.dispatchEvent(new Event('scroll'));
    expect(vi.getTimerCount()).toBe(2);
    scene.classes.add('motion-paused'); scene.preferenceChanged();
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    scene.window.dispatchEvent(new Event('scroll')); expect(vi.getTimerCount()).toBe(0);
    scene.classes.delete('motion-paused'); scene.preferenceChanged();
    expect(vi.getTimerCount()).toBe(1);
    scene.reduced.matches = true; scene.reduced.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(0);
    scene.reduced.matches = false; scene.reduced.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(1);
    scene.document.hidden = true; scene.document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000); expect(scene.animations).toHaveLength(2);
    scene.document.hidden = false; scene.document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(1);
    scene.dispose(); expect(vi.getTimerCount()).toBe(0); expect(scene.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a static reduced-motion scene and resumes bfcache only when motion is allowed', () => {
    const scene = createScene({ reduced: true });
    expect(scene.layers.map((layer) => layer.style.opacity)).toEqual(['1', '0']);
    expect(vi.getTimerCount()).toBe(0);
    scene.page('pagehide', true); scene.page('pageshow', true);
    expect(vi.getTimerCount()).toBe(0);
    scene.reduced.matches = false; scene.reduced.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(1);
    scene.page('pagehide', true); expect(vi.getTimerCount()).toBe(0);
    scene.page('pageshow', true); expect(vi.getTimerCount()).toBe(1);
    scene.page('pagehide', false); expect(vi.getTimerCount()).toBe(0);
    scene.page('pageshow', true); scene.window.dispatchEvent(new Event('scroll'));
    expect(vi.getTimerCount()).toBe(0); expect(scene.disconnect).toHaveBeenCalledOnce();
  });

  it('does not begin background work before a hidden page becomes visible', () => {
    const scene = createScene({ hidden: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.layers.map((layer) => layer.style.opacity)).toEqual(['0', '0']);
    scene.document.hidden = false; scene.document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(1);
    scene.compact.matches = true; scene.compact.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(1);
    scene.dispose();
  });
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';

const component = readFileSync(new URL('../src/components/AmbientScene.astro', import.meta.url), 'utf8');
const script = component.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Ambient scene script not found');
const browserScript = transpile(script);

function createAmbientScene(options: { compact?: boolean; hidden?: boolean; paused?: boolean; reduced?: boolean; positions?: number[][] } = {}) {
  const operations: string[] = [];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const windowEvents = new Map<string, () => void>();
  const documentEvents = new Map<string, () => void>();
  const classes = new Set<string>();
  const media = new Map<string, { matches: boolean; change?: () => void; addEventListener: (type: string, listener: () => void) => void }>();
  let identifier = 0;
  let randomState = 42;
  const createStyle = () => ({
    properties: new Map<string, string>(),
    setProperty(name: string, value: string) { operations.push('write'); this.properties.set(name, value); },
    set opacity(_value: string) { operations.push('write'); },
  });
  const positions = options.positions ?? Array.from({ length: siteConfig.effects.particleCount }, (_, index) => [(7 + index * 37) % 100, (9 + index * 23) % 100]);
  const particles = positions.map(([left, top], index) => ({
    dataset: { moteLeft: String(left), moteTop: String(top) },
    classList: { contains: (name: string) => name === 'ambient-mote--desktop' && index >= siteConfig.effects.mobileParticleCount },
    style: createStyle(),
  }));
  const scene = { dataset: { constellationConfig: JSON.stringify(siteConfig.effects.constellation) }, style: createStyle() };
  const animations: { cancel: ReturnType<typeof vi.fn>; options: { duration: number } }[] = [];
  const layers = [0, 1].map(() => {
    const paths = Array.from({ length: siteConfig.effects.constellation.desktopLineCount }, () => ({
      connection: '',
      setAttribute(_name: string, value: string) { operations.push('write'); this.connection = value; },
      removeAttribute() { operations.push('write'); this.connection = ''; },
    }));
    return {
      style: createStyle(), paths,
      querySelectorAll: () => paths,
      animate: (_frames: unknown, animationOptions: { duration: number }) => {
        const animation = { cancel: vi.fn(), options: animationOptions };
        animations.push(animation);
        return animation;
      },
    };
  });
  const document = {
    hidden: options.hidden ?? false,
    querySelector: (selector: string) => selector === '[data-ambient-scene]' ? scene : null,
    querySelectorAll: (selector: string) => selector === '.ambient-mote' ? particles : selector === '[data-constellation]' ? layers : [],
    documentElement: { classList: {
      toggle(name: string, enabled: boolean) { operations.push('write'); if (enabled) classes.add(name); else classes.delete(name); },
      contains: (name: string) => classes.has(name),
    } },
    addEventListener: (type: string, listener: () => void) => documentEvents.set(type, listener),
  };
  const viewport = { width: options.compact ? 390 : 1280, height: 720, scrollY: 0 };
  runInNewContext(browserScript, {
    document,
    window: {
      get innerWidth() { operations.push('read:width'); return viewport.width; },
      get innerHeight() { operations.push('read:height'); return viewport.height; },
      get scrollY() { operations.push('read:scroll'); return viewport.scrollY; },
      addEventListener: (type: string, listener: () => void) => windowEvents.set(type, listener),
      clearTimeout: (timer: number) => timers.delete(timer),
      setTimeout: (callback: () => void, delay: number) => { timers.set(++identifier, { callback, delay }); return identifier; },
    },
    requestAnimationFrame: (callback: () => void) => { frames.set(++identifier, callback); return identifier; },
    cancelAnimationFrame: (frame: number) => frames.delete(frame),
    getComputedStyle: (particle: typeof particles[number]) => {
      operations.push('read:style');
      return { display: options.compact && particle.classList.contains('ambient-mote--desktop') ? 'none' : 'block' };
    },
    matchMedia: (query: string) => {
      const queryState = {
        matches: query.includes('max-width') ? options.compact ?? false : options.reduced ?? false,
        change: undefined as (() => void) | undefined,
        addEventListener(_type: string, listener: () => void) { this.change = listener; },
      };
      media.set(query, queryState);
      return queryState;
    },
    localStorage: { getItem: () => options.paused ? 'paused' : null },
    Math: Object.assign(Object.create(Math), { random: () => { randomState = (randomState * 16807) % 2147483647; return randomState / 2147483647; } }),
    console,
  });
  return { operations, frames, timers, windowEvents, documentEvents, media, particles, scene, layers, animations, document, viewport, classes };
}

describe('ambient particle positioning under strict CSP', () => {
  it('initializes particle positions through individual CSS properties', () => {
    const { particles } = createAmbientScene({ positions: [[7, 9], [44, 32], [81, 55]], reduced: true });
    expect(particles.map(({ style }) => Object.fromEntries(style.properties))).toEqual([
      { '--mote-left': '7%', '--mote-top': '9%', '--mote-delay': '-0s', '--mote-duration': '15s' },
      { '--mote-left': '44%', '--mote-top': '32%', '--mote-delay': '-1s', '--mote-duration': '16s' },
      { '--mote-left': '81%', '--mote-top': '55%', '--mote-delay': '-2s', '--mote-duration': '17s' },
    ]);
  });

  it('does not put particle coordinates in CSP-blocked inline attributes', () => {
    const particleMarkup = component.match(/return <i[\s\S]*?\/>/)?.[0];
    expect(particleMarkup).toBeDefined();
    expect(particleMarkup).not.toMatch(/\sstyle=/);
    expect(particleMarkup).toContain('data-mote-left={left}');
    expect(particleMarkup).toContain('data-mote-top={top}');
  });
});

describe('ambient scene work scheduling', () => {
  it.each([false, true])('reads geometry before initial mutations without measuring every particle (compact: %s)', (compact) => {
    const { operations, particles } = createAmbientScene({ compact });
    expect(particles).toHaveLength(60);
    const reads = Object.fromEntries(['style', 'width', 'height', 'scroll'].map((type) => [type, operations.filter((operation) => operation === `read:${type}`).length]));
    expect(reads).toEqual({ style: 0, width: 1, height: 1, scroll: 1 });
    expect(operations.lastIndexOf('read:scroll')).toBeLessThan(operations.indexOf('write'));
  });

  it('refreshes randomized connections without further layout reads or changed timing', () => {
    const scene = createAmbientScene();
    expect(scene.animations.map(({ options }) => options.duration)).toEqual([1100, 1100]);
    const timer = [...scene.timers.entries()][0];
    expect(timer[1].delay).toBe(4200);
    const previousConnections = scene.layers[0].paths.map(({ connection }) => connection);
    scene.operations.length = 0;
    scene.timers.delete(timer[0]);
    timer[1].callback();
    expect(scene.operations.filter((operation) => operation.startsWith('read:')).length).toBe(0);
    expect(scene.layers[0].paths.map(({ connection }) => connection)).not.toEqual(previousConnections);
    expect(scene.timers.size).toBe(1);
  });

  it.each([false, true])('preserves visible endpoints, line limits and connection distance (compact: %s)', (compact) => {
    const scene = createAmbientScene({ compact });
    const configuration = siteConfig.effects.constellation;
    const visibleParticles = scene.particles.filter((particle) => !compact || !particle.classList.contains('ambient-mote--desktop'));
    const visibleCoordinates = new Set(visibleParticles.map(({ dataset }) => `${dataset.moteLeft} ${dataset.moteTop}`));
    for (const { paths } of scene.layers) {
      const connections = paths.map(({ connection }) => connection).filter(Boolean);
      expect(connections.length).toBe(compact ? configuration.mobileLineCount : configuration.desktopLineCount);
      const degrees = new Map<string, number>();
      for (const connection of connections) {
        const [, firstX, firstY, secondX, secondY] = connection.match(/^M(\d+) (\d+)L(\d+) (\d+)$/)!;
        for (const coordinate of [`${firstX} ${firstY}`, `${secondX} ${secondY}`]) {
          expect(visibleCoordinates.has(coordinate)).toBe(true);
          degrees.set(coordinate, (degrees.get(coordinate) ?? 0) + 1);
        }
        const distance = Math.hypot((Number(firstX) - Number(secondX)) * scene.viewport.width / 100, (Number(firstY) - Number(secondY)) * scene.viewport.height / 100);
        expect(distance).toBeLessThanOrEqual(Math.hypot(scene.viewport.width, scene.viewport.height) * configuration.maximumDistanceRatio);
      }
      expect(degrees.size).toBeLessThanOrEqual(compact ? configuration.mobilePointCount : configuration.desktopPointCount);
      expect(Math.max(...degrees.values())).toBeLessThanOrEqual(configuration.maximumDegree);
    }
  });

  it('uses the latest viewport and scroll position after resizing', () => {
    const scene = createAmbientScene();
    scene.viewport.height = 1000;
    scene.viewport.scrollY = 1000;
    scene.windowEvents.get('resize')!();
    expect(scene.frames.size).toBe(1);
    const [identifier, callback] = [...scene.frames.entries()][0];
    scene.frames.delete(identifier);
    scene.operations.length = 0;
    callback();
    expect(scene.scene.style.properties.get('--constellation-scroll-opacity')).toBe('1');
    expect(scene.operations).toEqual(['write']);
  });

  it('does not draw or queue frames while initially hidden, then resumes on visibility', () => {
    const scene = createAmbientScene({ hidden: true });
    expect(scene.layers.flatMap(({ paths }) => paths).every(({ connection }) => !connection)).toBe(true);
    scene.windowEvents.get('scroll')!();
    expect(scene.frames.size).toBe(0);
    expect(scene.timers.size).toBe(0);
    expect(scene.animations).toHaveLength(0);
    scene.document.hidden = false;
    scene.documentEvents.get('visibilitychange')!();
    expect(scene.layers.flatMap(({ paths }) => paths).some(({ connection }) => connection)).toBe(true);
    expect(scene.timers.size).toBe(1);
  });

  it.each([{ paused: true }, { reduced: true }])('keeps paused scenes static during scrolling: %j', (preference) => {
    const scene = createAmbientScene(preference);
    scene.operations.length = 0;
    scene.viewport.scrollY = 300;
    scene.windowEvents.get('scroll')!();
    expect(scene.frames.size).toBe(0);
    expect(scene.timers.size).toBe(0);
    expect(scene.operations).not.toContain('write');
    expect(scene.scene.style.properties.get('--constellation-scroll-opacity')).toBe('0.3');
  });

  it('cancels a pending scroll frame when the document becomes hidden', () => {
    const scene = createAmbientScene();
    scene.windowEvents.get('scroll')!();
    scene.windowEvents.get('scroll')!();
    expect(scene.frames.size).toBe(1);
    scene.document.hidden = true;
    scene.documentEvents.get('visibilitychange')!();
    expect(scene.frames.size).toBe(0);
    expect(scene.timers.size).toBe(0);
    expect(scene.animations.every(({ cancel }) => cancel.mock.calls.length > 0)).toBe(true);
  });

  it('cancels queued work on reduced motion and resumes using the current scroll position', () => {
    const scene = createAmbientScene();
    scene.windowEvents.get('scroll')!();
    const preference = scene.media.get('(prefers-reduced-motion: reduce)')!;
    preference.matches = true;
    preference.change!();
    expect(scene.frames.size).toBe(0);
    expect(scene.timers.size).toBe(0);
    scene.viewport.scrollY = scene.viewport.height;
    scene.windowEvents.get('scroll')!();
    preference.matches = false;
    preference.change!();
    expect(scene.timers.size).toBe(1);
    expect(scene.scene.style.properties.get('--constellation-scroll-opacity')).toBe('1');
  });
});

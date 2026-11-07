import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ambientSilkDimensions, initializeAmbientSilk } from '../src/lib/ambient-silk';
import { siteConfig } from '../src/config/site';

function createScene(options: { available?: boolean; reduced?: boolean; compile?: boolean } = {}) {
  const classes = new Set<string>();
  const root = { dataset: { theme: 'dark' }, classList: { contains: (name: string) => classes.has(name) } };
  const document = Object.assign(new EventTarget(), { hidden: false, documentElement: root });
  const window = Object.assign(new EventTarget(), { devicePixelRatio: 3 });
  const media = Object.assign(new EventTarget(), { matches: options.reduced ?? false });
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const gl = new Proxy({}, { get: (_target, name) => {
    if (typeof name === 'string' && /^[A-Z_]+$/.test(name)) return name;
    if (!methods.has(name)) methods.set(name, vi.fn((...args: unknown[]) => {
      if (name === 'getShaderParameter') return options.compile !== false;
      if (name === 'getProgramParameter') return true;
      if (String(name).startsWith('create')) return {};
      if (name === 'getUniformLocation') return args[1];
      if (name === 'getAttribLocation') return 0;
      return undefined;
    }));
    return methods.get(name);
  } }) as WebGL2RenderingContext;
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, dataset: {} as Record<string, string>,
    getContext: vi.fn(() => options.available === false ? null : gl),
    getBoundingClientRect: () => ({ width: 1280, height: 720 }) });
  let preferenceChanged = () => {};
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name.endsWith('color') ? '#61757f' : '#b6aaa0' }));
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { preferenceChanged = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const dispose = initializeAmbientSilk(canvas as unknown as HTMLCanvasElement);
  const page = (type: string, persisted: boolean) => window.dispatchEvent(Object.assign(new Event(type), { persisted }));
  return { canvas, methods, document, media, classes, dispose, page, preferenceChanged: () => preferenceChanged() };
}

describe('low-cost silk background', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('caps resolution and DPR without exceeding the pixel budget on large screens', () => {
    expect(ambientSilkDimensions(1280, 720, 3)).toEqual({ width: 576, height: 324 });
    expect(ambientSilkDimensions(320, 800, 3)).toEqual(ambientSilkDimensions(320, 800, 1));
    const large = ambientSilkDimensions(7680, 4320, 4);
    expect(large.width * large.height).toBeLessThanOrEqual(siteConfig.ambientSilk.maximumPixels);
    expect(large.width / large.height).toBeCloseTo(7680 / 4320, 2);
    expect(ambientSilkDimensions(0, Number.NaN, 1)).toEqual({ width: 1, height: 1 });
  });
  it('uses one low-rate draw pass and stops immediately for global pause, reduced motion and hidden pages', () => {
    const scene = createScene();
    const draw = scene.methods.get('drawArrays')!; draw.mockClear();
    vi.advanceTimersByTime(1000);
    expect(draw.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(draw.mock.calls.length).toBeLessThanOrEqual(12);
    expect(scene.methods.has('createFramebuffer')).toBe(false);
    scene.classes.add('motion-paused'); scene.preferenceChanged(); draw.mockClear();
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(1000); expect(draw).not.toHaveBeenCalled();
    scene.classes.delete('motion-paused'); scene.media.matches = true; scene.media.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(0);
    scene.media.matches = false; scene.media.dispatchEvent(new Event('change'));
    expect(vi.getTimerCount()).toBe(1);
    scene.document.hidden = true; scene.document.dispatchEvent(new Event('visibilitychange')); draw.mockClear();
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(1000); expect(draw).not.toHaveBeenCalled();
    scene.document.hidden = false; scene.document.dispatchEvent(new Event('visibilitychange'));
    expect(draw).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    scene.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a static themed image on initial reduced motion and resumes after bfcache return only when allowed', () => {
    const scene = createScene({ reduced: true });
    expect(scene.canvas.dataset).toHaveProperty('silkReady'); expect(vi.getTimerCount()).toBe(0);
    scene.document.documentElement.dataset.theme = 'light'; scene.preferenceChanged();
    expect(scene.methods.get('uniform1f')).toHaveBeenCalledWith('uLight', 1);
    scene.media.matches = false; scene.media.dispatchEvent(new Event('change'));
    scene.page('pagehide', true); expect(vi.getTimerCount()).toBe(0);
    scene.page('pageshow', true); expect(vi.getTimerCount()).toBe(1);
    scene.page('pagehide', false); expect(vi.getTimerCount()).toBe(0);
    expect(scene.canvas.dataset).not.toHaveProperty('silkReady');
    scene.page('pageshow', true); expect(vi.getTimerCount()).toBe(0);
  });
  it('falls back when WebGL is unavailable and recovers cleanly after context loss', () => {
    const unavailable = createScene({ available: false });
    expect(unavailable.canvas.dataset).not.toHaveProperty('silkReady'); expect(vi.getTimerCount()).toBe(0);
    const scene = createScene();
    const lost = new Event('webglcontextlost', { cancelable: true }); scene.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(scene.canvas.dataset).not.toHaveProperty('silkReady');
    scene.canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(scene.canvas.dataset).toHaveProperty('silkReady'); expect(vi.getTimerCount()).toBe(1);
    scene.dispose();
  });
  it('releases a failed shader once without scheduling an endless retry', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = createScene({ compile: false });
    expect(warning).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(scene.canvas.dataset).not.toHaveProperty('silkReady');
    expect(scene.methods.get('deleteShader')).toHaveBeenCalledOnce();
  });
});

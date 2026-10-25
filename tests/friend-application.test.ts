import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';

const component = readFileSync(new URL('../src/components/FriendApplication.astro', import.meta.url), 'utf8');
const componentScript = component.match(/<script>([\s\S]*?)<\/script>/)![1];
const motionScript = readFileSync(new URL('../src/lib/motion.ts', import.meta.url), 'utf8');
const drawerScript = readFileSync(new URL('../src/lib/admin-drawers.ts', import.meta.url), 'utf8');
const compileScript = (script: string) => transpileModule(script
  .replace(/^\s*import .*;\r?$/gm, '').replace(/\bexport\s+/g, ''), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
}).outputText;
const source = compileScript(`${motionScript}\n${componentScript}`);
const drawerSource = compileScript(`${motionScript}\n${drawerScript}`);

function eventTarget() {
  const listeners = new Map<string, (event: unknown) => unknown>();
  return {
    addEventListener: (name: string, listener: (event: unknown) => unknown) => listeners.set(name, listener),
    trigger: (name: string, event: unknown = {}) => listeners.get(name)?.(event),
  };
}

// 执行组件真实点击路径与共用动效，覆盖生产 CSS 压缩后的时间单位。
function application(timings: { enter: string; exit: string }, paused = false, reduced = false) {
  const opener = { ...eventTarget(), focus: vi.fn() };
  const close = eventTarget();
  const submit = { disabled: true };
  const feedback = { textContent: '', getAnimations: () => [] };
  const field = { name: 'name', value: '测试站点', maxLength: 60 };
  const form = {
    ...eventTarget(),
    querySelector: (selector: string) => selector === '[data-friend-apply-feedback]' ? feedback : submit,
    querySelectorAll: () => [field],
  };
  const content = { scrollTop: 120 };
  const copy = { focus: vi.fn() };
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => ({ finished: Promise.resolve() }));
  const dialog = {
    ...eventTarget(),
    open: false,
    dataset: {} as Record<string, string>,
    animate,
    showModal: () => { dialog.open = true; },
    close: () => { dialog.open = false; },
    hasAttribute: (name: string) => name === 'data-closing' && 'closing' in dialog.dataset,
    querySelectorAll: () => [],
    querySelector: (selector: string) => ({
      '[data-friend-apply-form]': form,
      '[data-copy-name="全部信息"]': copy,
      '.friend-application-content': content,
      '[data-friend-apply-close]': close,
    } as Record<string, unknown>)[selector],
  };
  const storage = new Map<string, string>();
  const parseTime = runInNewContext(`${source}\nparseCssTimeMilliseconds;`, {
    document: {
      documentElement: { classList: { contains: () => paused } },
      querySelector: (selector: string) => selector === '[data-friend-application]' ? dialog : opener,
    },
    window: eventTarget(),
    siteConfig,
    matchMedia: () => ({ matches: reduced, addEventListener: () => {} }),
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => ({
      '--motion-reorder-duration': timings.enter,
      '--motion-disclosure-duration': timings.exit,
      '--ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
    } as Record<string, string>)[name] || '' }),
    attachPaperCaret: () => () => {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    requestJson: vi.fn(),
    setTimeout, clearTimeout, console,
  }) as (value: string, fallback?: number) => number;
  return { opener, close, dialog, animate, content, copy, storage, parseTime };
}

function adminDrawer(timings: { enter: string; exit: string }) {
  class Element {
    isConnected = true;
    focus = vi.fn();
    closest = (_selector: string): unknown => null;
    getClientRects = () => [{}];
  }
  class Dialog extends Element {}
  const opener = new Element();
  const fallback = new Element();
  const document = {
    ...eventTarget(), activeElement: opener,
    documentElement: { classList: { contains: () => false, add: vi.fn(), remove: vi.fn() } },
    querySelector: () => null,
  };
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => ({ finished: Promise.resolve() }));
  const dialog = Object.assign(new Dialog(), eventTarget(), {
    open: false, dataset: {} as Record<string, string>, animate,
    showModal: () => { dialog.open = true; },
    close: () => { dialog.open = false; dialog.trigger('close'); },
    hasAttribute: (name: string) => name === 'data-admin-drawer' || name === 'data-closing' && 'closing' in dialog.dataset,
    closest: (selector: string) => selector === '.admin-panel' ? { querySelectorAll: () => [fallback] } : null,
    querySelector: () => null,
  });
  const open = runInNewContext(`${drawerSource}\nopenAdminDrawer;`, {
    document, siteConfig, HTMLElement: Element, HTMLDialogElement: Dialog,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => ({
      '--motion-spring-duration': timings.enter,
      '--motion-feedback-duration': timings.exit,
      '--ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
    } as Record<string, string>)[name] || '' }),
    confirmAdminDiscard: vi.fn().mockResolvedValue(true),
  }) as (target: unknown) => void;
  return { opener, fallback, dialog, animate, document, open };
}

describe('friend application dialog motion', () => {
  it('preserves zero times and uses the requested fallback for missing or invalid CSS times', () => {
    const { parseTime } = application({ enter: '0ms', exit: '0s' });
    for (const value of ['0ms', '0s', '0']) expect(parseTime(value, 420)).toBe(0);
    for (const value of ['', 'invalid', '-1s']) expect(parseTime(value, 420)).toBe(420);
    expect(parseTime('invalid')).toBe(0);
  });

  it.each([
    { enter: '420ms', exit: '260ms' },
    { enter: '.42s', exit: '.26s' },
  ])('keeps enter and exit durations after CSS time unit normalization: $enter / $exit', async (timings) => {
    const result = application(timings);
    result.opener.trigger('click');
    expect(result.dialog.open).toBe(true);
    expect(result.animate.mock.calls[0]?.[1]).toMatchObject({ duration: 420 });
    expect(result.content.scrollTop).toBe(0);
    expect(result.copy.focus).toHaveBeenCalledWith({ preventScroll: true });
    result.close.trigger('click');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.animate.mock.calls[1]?.[1]).toMatchObject({ duration: 260 });
    expect(result.dialog.open).toBe(false);
    expect(result.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(JSON.parse(result.storage.get(siteConfig.friendApplications.draftStorageKey)!)).toEqual({ name: '测试站点' });
  });

  it.each([{ paused: true, reduced: false }, { paused: false, reduced: true }])('keeps pause and reduced-motion immediate: $paused / $reduced', async ({ paused, reduced }) => {
    const result = application({ enter: '.42s', exit: '.26s' }, paused, reduced);
    result.opener.trigger('click');
    expect(result.dialog.open).toBe(true);
    result.close.trigger('click');
    await Promise.resolve();
    expect(result.dialog.open).toBe(false);
    expect(result.animate).not.toHaveBeenCalled();
  });
});

describe('admin drawer motion', () => {
  it.each([
    { enter: '520ms', exit: '260ms', enterMilliseconds: 520, exitMilliseconds: 260 },
    { enter: '.52s', exit: '.26s', enterMilliseconds: 520, exitMilliseconds: 260 },
    { enter: '0ms', exit: '0s', enterMilliseconds: 0, exitMilliseconds: 0 },
  ])('reads CSS times for opening and closing: $enter / $exit', async ({ enter, exit, enterMilliseconds, exitMilliseconds }) => {
    const result = adminDrawer({ enter, exit });
    result.open(result.dialog);
    expect(result.dialog.open).toBe(true);
    expect(result.animate.mock.calls[0]?.[1]).toMatchObject({ duration: enterMilliseconds });
    result.opener.isConnected = false;
    result.document.trigger('cancel', { target: result.dialog, preventDefault: vi.fn() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.animate.mock.calls[1]?.[1]).toMatchObject({ duration: exitMilliseconds });
    expect(result.dialog.open).toBe(false);
    expect(result.fallback.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeArticleImageViewer } from '../src/lib/article-image-viewer';
import { siteConfig } from '../src/config/site';

class ElementStub extends EventTarget {
  hidden = false;
  disabled = false;
  textContent = '';
  src = '';
  currentSrc = '';
  alt = '';
  naturalWidth = 400;
  clientWidth = 700;
  open = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = { contains: (name: string) => this.classes.has(name), add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  style = { width: '', removeProperty: vi.fn() };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  before = vi.fn();
  append = vi.fn();
  replaceWith = vi.fn();
  focus = vi.fn();
  scrollTo = vi.fn();
  closest = () => null;
  querySelector = (_selector: string): ElementStub | null => null;
  querySelectorAll = (_selector: string): ElementStub[] => [];
  getBoundingClientRect = () => ({ width: 400 });
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
}

function fixture() {
  const image = new ElementStub(); image.src = 'https://images.example/photo.webp'; image.alt = '图片说明';
  const prose = new ElementStub(); prose.querySelectorAll = () => [image];
  const dialog = new ElementStub();
  const elements = Object.fromEntries(['full', 'viewport', 'zoom', 'status', 'retry', 'close', 'caption'].map((name) => [`[data-image-${name}]`, new ElementStub()]));
  dialog.querySelector = (selector) => elements[selector];
  const trigger = new ElementStub();
  const loaders: ElementStub[] = [];
  const body = { style: { overflow: 'auto' } };
  vi.stubGlobal('document', { body, activeElement: null, createElement: () => trigger });
  vi.stubGlobal('Image', class extends ElementStub { constructor() { super(); loaders.push(this); } });
  initializeArticleImageViewer(prose as unknown as HTMLElement, dialog as unknown as HTMLDialogElement);
  trigger.click();
  return { dialog, trigger, elements, loaders, body };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('image viewer loading and retry', () => {
  it('retries in place, ignores a superseded attempt, and enables zoom only after success', () => {
    vi.useFakeTimers();
    const { dialog, elements, loaders } = fixture();
    expect(dialog.open).toBe(true);
    expect(elements['[data-image-zoom]'].disabled).toBe(true);
    expect(elements['[data-image-status]'].textContent).toContain('正在加载');
    const staleLoad = loaders[0].onload!;
    loaders[0].onerror!();
    expect(elements['[data-image-retry]'].hidden).toBe(false);
    elements['[data-image-retry]'].click();
    staleLoad();
    expect(elements['[data-image-full]'].replaceWith).not.toHaveBeenCalled();
    expect(loaders[1].src).toBe('https://images.example/photo.webp');
    loaders[1].onload!();
    expect(elements['[data-image-full]'].replaceWith).toHaveBeenCalledWith(loaders[1]);
    expect(elements['[data-image-zoom]'].disabled).toBe(false);
    expect(elements['[data-image-retry]'].hidden).toBe(true);
    expect(loaders[1].alt).toBe('图片说明');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out without refreshing the page and releases pending loads when closed', () => {
    vi.useFakeTimers();
    const { dialog, trigger, elements, loaders, body } = fixture();
    vi.advanceTimersByTime(siteConfig.articleReading.imageLoadTimeoutMilliseconds);
    expect(elements['[data-image-status]'].textContent).toContain('重试');
    elements['[data-image-retry]'].click();
    const staleLoad = loaders[1].onload!;
    dialog.close(); staleLoad();
    expect(elements['[data-image-full]'].replaceWith).not.toHaveBeenCalled();
    expect(loaders[1].src).toBe('');
    expect(body.style.overflow).toBe('auto');
    expect(trigger.focus).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

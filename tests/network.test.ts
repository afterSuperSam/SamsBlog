import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';
import { getClientIp, getVisitorLocation, maskIp } from '../src/lib/network';
import { onRequest } from '../src/middleware';

const statistics = vi.hoisted(() => ({ recordPageView: vi.fn(), hashVisitorToken: vi.fn(() => 'anonymous-hash') }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (middleware: unknown) => middleware }));
vi.mock('../src/lib/stats', async (original) => ({ ...await original<typeof import('../src/lib/stats')>(), ...statistics }));

const componentScript = readFileSync(new URL('../src/components/NetworkStatus.astro', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!componentScript) throw new Error('Network status script not found');
const networkStatusScript = transpile(componentScript, { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 });

class NetworkElement extends EventTarget {
  hidden = false;
  rendered = true;
  textContent = '';
  parentElement: NetworkElement | null = null;
  children = new Map<string, NetworkElement>();
  attributes = new Map<string, string>();
  rectangle = { top: 1000, bottom: 1040, left: 0, right: 200, width: 200, height: 40 };
  focus = vi.fn();
  querySelector(selector: string) { return this.children.get(selector) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  getClientRects() { return this.rendered && !this.hidden ? [this.rectangle] : []; }
  getBoundingClientRect() { return this.rectangle; }
  contains(node: unknown): boolean { return node === this || [...this.children.values()].some((child) => child.contains(node)); }
}

function createNetworkStatus(options: { observer?: boolean; visible?: boolean; hidden?: boolean; rendered?: boolean } = {}) {
  const root = new NetworkElement();
  root.hidden = true;
  const host = new NetworkElement();
  host.rendered = options.rendered ?? true;
  if (options.visible) host.rectangle = { ...host.rectangle, top: 680, bottom: 720 };
  root.parentElement = host;
  for (const selector of ['trigger', 'details', 'summary-latency', 'latency', 'location', 'ip', 'visitor']) {
    root.children.set(`[data-network-${selector}]`, new NetworkElement());
  }
  const trigger = root.querySelector('[data-network-trigger]')!;
  const details = root.querySelector('[data-network-details]')!;
  trigger.setAttribute('aria-expanded', 'false');
  details.hidden = true;
  let observerCallback: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class MockIntersectionObserver {
    constructor(callback: typeof observerCallback) { observerCallback = callback; }
    observe = observe;
    disconnect = disconnect;
  }
  const document = Object.assign(new EventTarget(), { hidden: options.hidden ?? false, querySelector: () => root });
  const window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720 }, options.observer === false ? {} : { IntersectionObserver: MockIntersectionObserver });
  let time = 0;
  const durations = [90, 30, 60];
  const fetch = vi.fn(async (url: string) => {
    time += durations.shift() ?? 0;
    return url.startsWith('/api/ping.json')
      ? new Response(null, { status: 204 })
      : Response.json({ location: '中国 · 上海', maskedIp: '203.0.*.*' });
  });
  const warn = vi.fn();
  runInNewContext(networkStatusScript, {
    exports: {},
    require: (specifier: string) => {
      if (specifier === '../config/site') return { siteConfig };
      throw new Error(`Unexpected component import: ${specifier}`);
    },
    document, window, Node: NetworkElement, IntersectionObserver: MockIntersectionObserver,
    fetch, performance: { now: () => time }, AbortSignal, console: { warn },
  });
  return { root, host, trigger, details, document, window, fetch, warn, observe, disconnect, intersect: () => observerCallback?.([{ isIntersecting: true }]) };
}

const settleNetwork = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('footer network measurement', () => {
  it('waits for the visible footer host and ignores intersection reports for its hidden layout', async () => {
    const status = createNetworkStatus();
    expect(status.observe).toHaveBeenCalledWith(status.host);
    expect(status.fetch).not.toHaveBeenCalled();
    status.intersect();
    expect(status.fetch).not.toHaveBeenCalled();
    status.host.rectangle = { ...status.host.rectangle, top: 680, bottom: 720 };
    status.host.rendered = false;
    status.intersect();
    expect(status.fetch).not.toHaveBeenCalled();
    status.host.rendered = true;
    status.window.dispatchEvent(new Event('resize'));
    await settleNetwork();
    expect(status.fetch).toHaveBeenCalledTimes(3);
    expect(status.root.hidden).toBe(false);
    expect(status.root.querySelector('[data-network-summary-latency]')?.textContent).toBe('60 ms');
    expect(status.trigger.getAttribute('aria-label')).toBe('站点延迟 60 毫秒，查看网络信息');
    expect(status.disconnect).toHaveBeenCalledOnce();
  });

  it('waits until the tab is visible and keeps visitor details behind the button', async () => {
    const status = createNetworkStatus({ visible: true, hidden: true });
    status.intersect();
    expect(status.fetch).not.toHaveBeenCalled();
    status.document.hidden = false;
    status.document.dispatchEvent(new Event('visibilitychange'));
    await settleNetwork();
    expect(status.fetch).toHaveBeenCalledTimes(3);
    expect(status.fetch.mock.calls.every(([url]) => url.startsWith('/api/ping.json'))).toBe(true);
    status.trigger.dispatchEvent(new Event('click'));
    await settleNetwork();
    expect(status.fetch).toHaveBeenLastCalledWith('/api/network.json', expect.any(Object));
    expect(status.details.hidden).toBe(false);
    expect(status.trigger.getAttribute('aria-expanded')).toBe('true');
    status.document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(status.details.hidden).toBe(true);
    expect(status.trigger.focus).toHaveBeenCalledOnce();
    status.trigger.dispatchEvent(new Event('click'));
    expect(status.fetch).toHaveBeenCalledTimes(4);
  });

  it('pauses the next sample in a background tab and resumes without duplicate probes', async () => {
    const status = createNetworkStatus({ visible: true });
    let resolveProbe!: (response: Response) => void;
    status.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveProbe = resolve; }));
    status.intersect();
    status.intersect();
    status.window.dispatchEvent(new Event('pageshow'));
    expect(status.fetch).toHaveBeenCalledTimes(1);
    status.document.hidden = true;
    resolveProbe(new Response(null, { status: 204 }));
    await settleNetwork();
    expect(status.fetch).toHaveBeenCalledTimes(1);
    expect(status.root.hidden).toBe(true);
    status.document.hidden = false;
    status.document.dispatchEvent(new Event('visibilitychange'));
    await settleNetwork();
    status.intersect();
    status.window.dispatchEvent(new Event('resize'));
    expect(status.fetch).toHaveBeenCalledTimes(3);
    expect(status.root.hidden).toBe(false);
  });

  it('hides failed measurements without starting another probe on subsequent events', async () => {
    const status = createNetworkStatus({ visible: true });
    status.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    status.intersect();
    await settleNetwork();
    status.intersect();
    status.window.dispatchEvent(new Event('pageshow'));
    expect(status.fetch).toHaveBeenCalledTimes(1);
    expect(status.root.hidden).toBe(true);
    expect(status.warn).toHaveBeenCalledWith('Latency probe unavailable', expect.anything());
    expect(status.disconnect).toHaveBeenCalledOnce();
  });

  it('checks the viewport on scroll when intersection observation is unavailable', async () => {
    const status = createNetworkStatus({ observer: false });
    expect(status.fetch).not.toHaveBeenCalled();
    status.host.rectangle = { ...status.host.rectangle, top: 680, bottom: 720 };
    status.window.dispatchEvent(new Event('scroll'));
    await settleNetwork();
    expect(status.fetch).toHaveBeenCalledTimes(3);
    expect(status.root.hidden).toBe(false);
  });

  it('starts when a restored page already shows the footer', async () => {
    const status = createNetworkStatus();
    status.host.rectangle = { ...status.host.rectangle, top: 680, bottom: 720 };
    status.window.dispatchEvent(new Event('pageshow'));
    await settleNetwork();
    expect(status.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('visitor network privacy', () => {
  it('uses the overwritten proxy address instead of a forged forwarded prefix', () => {
    const request = new Request('https://blog.example.com', {
      headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.18', 'x-real-ip': '203.0.113.18' },
    });
    expect(getClientIp(request, '127.0.0.1')).toBe('203.0.113.18');
    expect(getClientIp(request, '203.0.113.44')).toBe('203.0.113.44');
  });

  it('never returns a complete IP address for display', () => {
    expect(maskIp('203.0.113.18')).toBe('203.0.*.*');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3:*:*');
    expect(maskIp('::ffff:203.0.113.18')).toBe('203.0.*.*');
    expect(maskIp('2001:4860::8888')).toBe('2001:4860:0:*:*');
    expect(maskIp('2001:4860:0:0:0:0:0:8888')).toBe('2001:4860:0:*:*');
    expect(maskIp('::ffff:cb00:7112')).toBe('0:0:0:*:*');
    expect(maskIp('::1')).toBe('0:0:0:*:*');
    expect(maskIp('not:an:address')).toBe('未知');
  });

  it('builds only a coarse location from proxy headers', () => {
    const request = new Request('https://blog.example.com', {
      headers: {
        'x-geo-country': encodeURIComponent('中国'),
        'x-geo-region': encodeURIComponent('上海'),
      },
    });
    expect(getVisitorLocation(request)).toBe('中国 · 上海');
  });

  it('prepares cookies for public HTML but never counts page fetches', async () => {
    for (const [pathname, status, contentType, counted] of [
      ['/', 200, 'text/html; charset=utf-8', true],
      ['/about', 200, 'text/html', true],
      ['/missing', 404, 'text/html', false],
      ['/', 500, 'text/html', false],
      ['/health.json', 200, 'application/json', false],
      ['/admin', 200, 'text/html', false],
    ] as const) {
      statistics.recordPageView.mockClear();
      const url = new URL(pathname, 'https://blog.example.com');
      const cookies = { get: vi.fn(), set: vi.fn() };
      const context = { url, cookies, request: new Request(url, { headers: { Accept: 'text/html', 'User-Agent': 'fixture-browser' } }) } as unknown as Parameters<typeof onRequest>[0];
      const response = new Response('', { status, headers: { 'Content-Type': contentType } });
      expect(await onRequest(context, async () => response)).toBe(response);
      expect(statistics.recordPageView).not.toHaveBeenCalled();
      expect(cookies.set).toHaveBeenCalledTimes(counted ? 1 : 0);
      if (counted) expect(cookies.set).toHaveBeenCalledWith('samsblog-visitor', expect.any(String), expect.objectContaining({ secure: true }));
    }
  });
});

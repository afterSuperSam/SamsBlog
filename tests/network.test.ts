import { describe, expect, it, vi } from 'vitest';
import { getClientIp, getVisitorLocation, maskIp } from '../src/lib/network';
import { onRequest } from '../src/middleware';

const statistics = vi.hoisted(() => ({ recordPageView: vi.fn(), hashVisitorToken: vi.fn(() => 'anonymous-hash') }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (middleware: unknown) => middleware }));
vi.mock('../src/lib/stats', () => statistics);

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

  it('counts successful public HTML responses without counting errors or JSON', async () => {
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
      const context = { url, cookies, request: new Request(url, { headers: { Accept: 'text/html' } }) } as unknown as Parameters<typeof onRequest>[0];
      const response = new Response('', { status, headers: { 'Content-Type': contentType } });
      expect(await onRequest(context, async () => response)).toBe(response);
      expect(statistics.recordPageView).toHaveBeenCalledTimes(counted ? 1 : 0);
      expect(cookies.set).toHaveBeenCalledTimes(counted ? 1 : 0);
      if (counted) expect(cookies.set).toHaveBeenCalledWith('samsblog-visitor', expect.any(String), expect.objectContaining({ secure: true }));
    }
  });
});

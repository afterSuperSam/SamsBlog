import { describe, expect, it } from 'vitest';
import { getClientIp, getVisitorLocation, maskIp } from '../src/lib/network';

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
});

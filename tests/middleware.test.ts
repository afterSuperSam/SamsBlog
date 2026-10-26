import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/middleware';
import { createAdminSession } from '../src/lib/admin-auth';

vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../src/lib/reply-notifications', () => ({ scheduleReplyNotifications: vi.fn() }));
const statistics = vi.hoisted(() => ({ recordPageView: vi.fn() }));
vi.mock('../src/lib/stats', async (original) => ({ ...await original<typeof import('../src/lib/stats')>(), ...statistics }));
const token = '11111111-1111-4111-8111-111111111111';
function context(path = '/about', headers: Record<string, string> = {}, values: Record<string,string> = {}) {
  const url = new URL(path, 'https://blog.example.com');
  return { url, request: new Request(url, { headers: { accept: 'text/html', 'user-agent': 'fixture-browser', 'sec-fetch-dest': 'document', ...headers } }),
    cookies: { get: (name: string) => values[name] ? { value: values[name] } : undefined, set: vi.fn() },
  } as unknown as Parameters<typeof onRequest>[0];
}
const page = () => new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html' } });

describe('public page view statistics boundary', () => {
  it('does not count an HTML fetch before a visible browser confirms it', async () => {
    for (let index = 0; index < 3; index++) await onRequest(context(), async () => page());
    expect(statistics.recordPageView).not.toHaveBeenCalled();
  });
  it('prepares identity once and preserves the response', async () => {
    const first = context(); const response = page();
    expect(await onRequest(first, async () => response)).toBe(response);
    expect(first.cookies.set).toHaveBeenCalledWith('samsblog-visitor', expect.any(String), expect.objectContaining({ secure: true, httpOnly: true, sameSite: 'lax' }));
    const returning = context('/about', {}, { 'samsblog-visitor': token });
    await onRequest(returning, async () => page());
    expect(returning.cookies.set).not.toHaveBeenCalled();
  });
  it.each([
    ['/admin', {}], ['/missing', {}], ['/about', { purpose: 'prefetch' }],
    ['/about', { 'sec-purpose': 'prefetch;prerender' }], ['/about', { 'user-agent': 'Googlebot' }],
    ['/about', { 'user-agent': '' }], ['/about', { 'sec-fetch-dest': 'empty' }],
  ] as Array<[string, Record<string,string>]>)('does not prepare tracking for %s %j', async (path, headers) => {
    const request = context(path, headers); await onRequest(request, async () => page());
    expect(request.cookies.set).not.toHaveBeenCalled();
  });
  it('excludes administrators and unsuccessful responses', async () => {
    const administrator = context('/about', {}, { samsblog_admin: createAdminSession() });
    await onRequest(administrator, async () => page());
    expect(administrator.cookies.set).not.toHaveBeenCalled();
    const failure = context(); await onRequest(failure, async () => new Response('', { status: 404, headers: { 'content-type': 'text/html' } }));
    expect(failure.cookies.set).not.toHaveBeenCalled();
  });
  it('does not catch failures from page rendering', async () => {
    await expect(onRequest(context(), async () => { throw new Error('render failed'); })).rejects.toThrow('render failed');
  });
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile, ModuleKind } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8');
const script = transpile(source, { module: ModuleKind.CommonJS });

function createMiddleware(recordPageView = vi.fn(), siteUrl = 'https://blog.example.com') {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const moduleExports: { onRequest?: (context: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response> } = {};
  runInNewContext(script, {
    exports: moduleExports,
    require: (name: string) => {
      if (name === 'astro:middleware') return { defineMiddleware: (handler: unknown) => handler };
      if (name === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' };
      if (name === './lib/stats') return { hashVisitorToken: () => 'anonymous-fingerprint', recordPageView };
      if (name === './lib/reply-notifications') return { scheduleReplyNotifications: vi.fn() };
      if (name === './config/site') return { siteConfig: { siteUrl } };
      throw new Error(`Unexpected test import: ${name}`);
    },
    console: logger,
    Error,
    URL,
  });
  return { onRequest: moduleExports.onRequest!, recordPageView, logger };
}

const requestContext = (origin = 'https://blog.example.com') => ({
  request: new Request(`${origin}/about`, {
    headers: { accept: 'text/html', 'user-agent': 'fixture-browser', 'sec-fetch-dest': 'document', 'x-real-ip': '198.51.100.100' },
  }),
  url: new URL(`${origin}/about`),
  cookies: { get: () => undefined, set: vi.fn() },
});

describe('public page view statistics boundary', () => {
  it('records successful HTML views without replacing the response', async () => {
    const { onRequest, recordPageView, logger } = createMiddleware();
    const response = new Response('<html>fixture</html>', { headers: { 'content-type': 'text/html', 'x-fixture': 'preserved' } });
    expect(await onRequest(requestContext(), async () => response)).toBe(response);
    expect(recordPageView).toHaveBeenCalledOnce();
    expect(recordPageView.mock.calls[0][0]).toBe('anonymous-fingerprint');
    expect(Number.isFinite(Date.parse(recordPageView.mock.calls[0][1].toISOString()))).toBe(true);
    expect(recordPageView.mock.calls[0][2]).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(['SQLITE_BUSY', 'SQLITE_IOERR_WRITE', 'SQLITE_READONLY_DBMOVED'])('keeps the original HTML and headers when storage fails with %s', async (code) => {
    const recordPageView = vi.fn(() => { throw Object.assign(new Error('private diagnostic must not be logged'), { code }); });
    const { onRequest, logger } = createMiddleware(recordPageView);
    const response = new Response('<html>still readable</html>', { status: 203, headers: { 'content-type': 'text/html', 'x-fixture': 'preserved' } });
    expect(await onRequest(requestContext(), async () => response)).toBe(response);
    expect(response.status).toBe(203);
    expect(response.headers.get('x-fixture')).toBe('preserved');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Page view statistics storage unavailable', { code });
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private diagnostic');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('198.51.100.100');
  });

  it('classifies unexpected statistics failures without logging private diagnostics', async () => {
    const { onRequest, logger } = createMiddleware(vi.fn(() => { throw new TypeError('private request body'); }));
    const response = new Response('<html>still readable</html>', { headers: { 'content-type': 'text/html' } });
    expect(await onRequest(requestContext(), async () => response)).toBe(response);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Page view statistics failed unexpectedly', { errorType: 'TypeError' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private request body');
  });

  it('does not catch failures from page rendering', async () => {
    const { onRequest, recordPageView, logger } = createMiddleware();
    const failure = new Error('Page rendering failed');
    await expect(onRequest(requestContext(), async () => { throw failure; })).rejects.toBe(failure);
    expect(recordPageView).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each<[string, string, boolean]>([
    ['https://blog.example.com', 'http://127.0.0.1:4321', true],
    ['http://localhost:4321', 'http://localhost:4321', false],
    ['http://localhost:4321', 'https://blog.example.com', true],
  ])('sets Secure for trusted public HTTPS or actual HTTPS: %s via %s', async (siteUrl, requestOrigin, secure) => {
    const { onRequest } = createMiddleware(vi.fn(), siteUrl);
    const context = requestContext(requestOrigin);
    await onRequest(context, async () => new Response('<html>fixture</html>', { headers: { 'Content-Type': 'text/html' } }));
    expect(context.cookies.set).toHaveBeenCalledWith('samsblog-visitor', expect.any(String), expect.objectContaining({ secure, httpOnly: true, sameSite: 'lax' }));
  });
});

import { createHmac, scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import { allowLoginAttempt, createAdminSession, verifyAdminPassword, verifyAdminSession } from '../src/lib/admin-auth';
import { serverConfig } from '../src/config/server';
import { adminRoute, json, readJsonObject, readPositiveId, readRequestBytes, requirePublicActivityAllowance } from '../src/lib/http';
import { POST as saveFriend } from '../src/pages/api/admin/friends.json';
import { POST as login } from '../src/pages/api/admin/login.json';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('admin boundaries', () => {
  it('accepts signed sessions and rejects tampering and malformed tokens', () => {
    const token = createAdminSession();
    expect(verifyAdminSession(token)).toBe(true);
    expect(verifyAdminSession(`${token}.extra`)).toBe(false);
    expect(verifyAdminSession(`${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`)).toBe(false);
    expect(verifyAdminSession('not-a-session')).toBe(false);
    expect(verifyAdminSession()).toBe(false);
  });

  it('rejects expired sessions', () => {
    const now = Date.now();
    const token = createAdminSession();
    vi.spyOn(Date, 'now').mockReturnValue(now + serverConfig.sessionSeconds * 1000 + 1);
    expect(verifyAdminSession(token)).toBe(false);
  });

  it('checks runtime password hashes and bounds expensive input', async () => {
    const password = 'temporary-test-password'; const salt = 'test-only-salt';
    vi.stubEnv('ADMIN_PASSWORD_HASH', `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    expect(await verifyAdminPassword(password)).toBe(true);
    expect(await verifyAdminPassword('wrong-password')).toBe(false);
    expect(await verifyAdminPassword('x'.repeat(serverConfig.passwordMaxLength + 1))).toBe(false);
  });

  it('refuses authentication with a missing production secret', async () => {
    const token = createAdminSession();
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('BLOG_SECRET', '');
    expect(verifyAdminSession(token)).toBe(false);
    expect(await verifyAdminPassword('any-password')).toBe(false);
    expect(() => createAdminSession()).toThrow('BLOG_SECRET');
  });

  it('rejects invalid JSON objects and non-integer identifiers', async () => {
    for (const body of ['null', '[]', '{']) {
      await expect(readJsonObject(new Request('https://blog.example.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }))).rejects.toMatchObject({ status: 400 });
    }
    for (const value of [0, -1, 1.5, '1']) expect(() => readPositiveId(value)).toThrow();
    expect(readPositiveId(1)).toBe(1);
  });

  it('requires the JSON media type rather than a matching substring', async () => {
    const request = (contentType: string) => new Request('https://blog.example.com', {
      method: 'POST', headers: { 'Content-Type': contentType }, body: '{}',
    });
    for (const contentType of ['text/plain; application/json', 'application/json-invalid']) {
      await expect(readJsonObject(request(contentType))).rejects.toMatchObject({ status: 415 });
    }
    await expect(readJsonObject(request('Application/JSON; charset=utf-8'))).resolves.toEqual({});
  });

  it('requires authorization and rejects update identifiers on create', async () => {
    const context = (token?: string, body = '{}') => ({ request: new Request('https://blog.example.com/api/admin/friends.json', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://blog.example.com' }, body }), cookies: { get: () => token ? { value: token } : undefined } }) as unknown as Parameters<typeof saveFriend>[0];
    expect((await saveFriend(context())).status).toBe(401);
    expect((await saveFriend(context(createAdminSession(), '{"id":1}'))).status).toBe(400);
    expect((await saveFriend(context(createAdminSession(), 'null'))).status).toBe(400);
  });

  it('limits password attempts and allows retry after the window', () => {
    const now = Date.now();
    for (let index = 0; index < serverConfig.loginAttempts; index++) expect(allowLoginAttempt('test-fingerprint', now)).toBe(true);
    expect(allowLoginAttempt('test-fingerprint', now)).toBe(false);
    expect(allowLoginAttempt('test-fingerprint', now + serverConfig.loginWindowSeconds * 1000)).toBe(true);
  });

  it('bounds actual streamed bytes even when the declared length is missing or false', async () => {
    const headerCases: HeadersInit[] = [{}, { 'Content-Length': '1' }];
    for (const headers of headerCases) {
      const request = new Request('https://blog.example.com', { method: 'POST', headers, body: '😀'.repeat(8) });
      await expect(readRequestBytes(request, 16)).rejects.toMatchObject({ status: 413 });
    }
  });

  it('blocks missing or foreign origins before every authenticated mutation handler', async () => {
    const handler = vi.fn(() => json({ ok: true }));
    const guarded = adminRoute(handler);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      for (const origin of ['', 'https://other.example.com']) {
        const response = await guarded({ request: new Request('https://blog.example.com/api/admin/test.json', { method, headers: origin ? { origin } : {} }),
          cookies: { get: () => ({ value: createAdminSession() }) },
        } as unknown as APIContext);
        expect(response.status).toBe(403);
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects cross-origin login and counts malformed login attempts before parsing', async () => {
    const context = (origin = 'https://blog.example.com') => ({ request: new Request('https://blog.example.com/api/admin/login.json', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{',
    }), clientAddress: '198.51.100.99', cookies: { set: vi.fn() } }) as unknown as APIContext;
    expect((await login(context('https://other.example.com'))).status).toBe(403);
    for (let index = 0; index < serverConfig.loginAttempts; index++) expect((await login(context())).status).toBe(400);
    expect((await login(context())).status).toBe(429);
  });

  it('caps authenticated mutations across sessions and keeps reads available', async () => {
    let now = Date.now() + serverConfig.adminMutationWindowSeconds * 1000 + 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const guarded = adminRoute(() => json({ ok: true }));
    const context = (method = 'POST') => ({ request: new Request('https://blog.example.com/api/admin/test.json', { method, headers: { origin: 'https://blog.example.com' } }),
      cookies: { get: () => ({ value: createAdminSession() }) },
    }) as unknown as APIContext;
    for (let index = 0; index < serverConfig.adminMutationLimit; index++) {
      now++;
      expect((await guarded(context())).status).toBe(200);
    }
    expect((await guarded(context())).status).toBe(429);
    expect((await guarded(context('GET'))).status).toBe(200);
    now += serverConfig.adminMutationWindowSeconds * 1000;
    expect((await guarded(context())).status).toBe(200);
  });

  it('bounds public activity rates and tracked sources and releases expired entries', () => {
    const now = Date.now();
    for (let index = 0; index < serverConfig.publicActivityLimit; index++) requirePublicActivityAllowance('source-0', now);
    expect(() => requirePublicActivityAllowance('source-0', now)).toThrow('请求过于频繁');
    for (let index = 1; index < serverConfig.publicActivityTrackedAddresses; index++) requirePublicActivityAllowance(`source-${index}`, now);
    expect(() => requirePublicActivityAllowance('new-source', now)).toThrow('请求过于频繁');
    expect(() => requirePublicActivityAllowance('new-source', now + serverConfig.publicActivityWindowSeconds * 1000)).not.toThrow();
  });

  it('rejects signed malformed payloads and expiration at the exact deadline', () => {
    const secret = 'temporary-session-secret-at-least-32-characters';
    vi.stubEnv('BLOG_SECRET', secret);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const signed = (value: string) => {
      const payload = Buffer.from(value).toString('base64url');
      return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    };
    for (const value of ['{', 'null', '[]', '{}', '{"exp":"9999999999999"}', '{"exp":1e999}', JSON.stringify({ exp: now })]) {
      expect(verifyAdminSession(signed(value))).toBe(false);
    }
    expect(verifyAdminSession(signed(JSON.stringify({ exp: now + 1 })))).toBe(true);
    const token = createAdminSession();
    vi.stubEnv('BLOG_SECRET', 'rotated-session-secret-at-least-32-characters');
    expect(verifyAdminSession(token)).toBe(false);
  });

  it('checks every real admin endpoint before parsing bodies or running data handlers', async () => {
    const modules = import.meta.glob<Record<string, APIRoute>>('../src/pages/api/admin/*.json.ts', { eager: true });
    const cookieWrite = vi.fn();
    let checked = 0;
    for (const [filename, handlers] of Object.entries(modules)) {
      if (filename.endsWith('/login.json.ts')) continue;
      for (const [method, handler] of Object.entries(handlers)) {
        if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
        const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        const url = new URL(`https://blog.example.com/api/admin/${filename.split('/').at(-1)!.replace(/\.ts$/, '')}`);
        const context = (token?: string, origin?: string) => ({
          url, request: new Request(url, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
            ...(mutation ? { body: '{' } : {}), }),
          cookies: { get: () => token ? { value: token } : undefined, set: cookieWrite, delete: cookieWrite },
        }) as unknown as APIContext;
        for (const token of [undefined, 'forged.token']) {
          const response = await handler(context(token, url.origin));
          expect(response.status, `${filename} ${method}`).toBe(401);
          expect(response.headers.get('Cache-Control')).toBe('no-store');
        }
        if (mutation) {
          for (const origin of [undefined, 'null', 'https://other.example.com', `${url.origin}.attacker.example`]) {
            expect((await handler(context(createAdminSession(), origin))).status, `${filename} ${method}`).toBe(403);
          }
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(cookieWrite).not.toHaveBeenCalled();
  });

  it('reserves source and global login quotas before concurrent requests parse their bodies', async () => {
    let now = Date.now() + serverConfig.loginWindowSeconds * 10000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const attempt = (clientAddress: string) => login({
      request: new Request('https://blog.example.com/api/admin/login.json', {
        method: 'POST', headers: { origin: 'https://blog.example.com', 'content-type': 'application/json' }, body: '{',
      }), clientAddress, cookies: { set: vi.fn() },
    } as unknown as APIContext);
    const sourceResponses = await Promise.all(Array.from({ length: serverConfig.loginAttempts * 2 }, () => attempt('198.51.100.20')));
    expect(sourceResponses.filter((response) => response.status === 400)).toHaveLength(serverConfig.loginAttempts);
    expect(sourceResponses.filter((response) => response.status === 429)).toHaveLength(serverConfig.loginAttempts);
    now += serverConfig.loginWindowSeconds * 1000;
    const globalResponses = await Promise.all(Array.from({ length: serverConfig.loginGlobalAttempts * 2 }, (_, index) => attempt(`2001:db8::${index + 1}`)));
    expect(globalResponses.filter((response) => response.status === 400)).toHaveLength(serverConfig.loginGlobalAttempts);
    expect(globalResponses.filter((response) => response.status === 429)).toHaveLength(serverConfig.loginGlobalAttempts);
    now += serverConfig.loginWindowSeconds * 1000;
    expect((await attempt('198.51.100.20')).status).toBe(400);
  });
});

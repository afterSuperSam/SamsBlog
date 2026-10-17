import { scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowLoginAttempt, createAdminSession, verifyAdminPassword, verifyAdminSession } from '../src/lib/admin-auth';
import { serverConfig } from '../src/config/server';
import { readJsonObject, readPositiveId } from '../src/lib/http';
import { POST as saveFriend } from '../src/pages/api/admin/friends.json';

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
    const context = (token?: string, body = '{}') => ({ request: new Request('https://blog.example.com/api/admin/friends.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), cookies: { get: () => token ? { value: token } : undefined } }) as unknown as Parameters<typeof saveFriend>[0];
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
});

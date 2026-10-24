import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext, APIRoute } from 'astro';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';
import { createAdminSession } from '../src/lib/admin-auth';
import { getDatabase } from '../src/lib/db';
import { deleteSponsor, listSponsors, saveSponsor, sponsorAvatarUrl, type SponsorRecord } from '../src/lib/sponsors';
import { DELETE, GET, PATCH, POST } from '../src/pages/api/admin/sponsors.json';

beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-sponsors-'))); });
afterAll(() => { getDatabase().close(); vi.unstubAllEnvs(); });

async function call(handler: APIRoute, method: string, body?: unknown, authorized = true, headers: Record<string, string> = {}) {
  return handler({
    request: new Request('https://blog.example.com/api/admin/sponsors.json', {
      method, headers: { 'content-type': 'application/json', origin: 'https://blog.example.com', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    cookies: { get: () => authorized ? { value: createAdminSession() } : undefined },
  } as unknown as APIContext) as Promise<Response>;
}

describe('sponsor management', () => {
  it('migrates the existing list and keeps a stable descending amount order', () => {
    const sponsors = listSponsors();
    expect(sponsors.map(({ name, amount }) => ({ name, amount }))).toEqual([...siteConfig.sponsors].sort((left, right) => right.amount - left.amount));
    expect(listSponsors()).toEqual(sponsors);
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id='20261024-sponsors'").get()).toEqual({ count: 1 });
  });

  it('creates, edits, reorders and soft deletes without losing cent precision', async () => {
    const created = await call(POST, 'POST', { name: ' 测试赞助 ', minecraftUsername: ' Test_Player ', amount: 12.34 });
    expect(created.status).toBe(201);
    const record = listSponsors().find((item) => item.name === '测试赞助')!;
    expect(record).toMatchObject({ minecraftUsername: 'Test_Player', amount: 12.34 });
    expect(getDatabase().prepare('SELECT amount_cents AS amount FROM blog_sponsors WHERE id=?').get(record.id)).toEqual({ amount: 1234 });
    expect((await call(PATCH, 'PATCH', { ...record, amount: 101.01 })).status).toBe(200);
    const updated = listSponsors()[0];
    expect(updated).toMatchObject({ id: record.id, amount: 101.01 });
    expect(updated.updatedAt).not.toBe(record.updatedAt);
    expect((await call(PATCH, 'PATCH', { ...record, amount: 5 })).status).toBe(409);
    expect((await call(DELETE, 'DELETE', record)).status).toBe(409);
    expect((await call(DELETE, 'DELETE', updated)).status).toBe(200);
    expect(listSponsors().some((item) => item.id === record.id)).toBe(false);
    expect(getDatabase().prepare('SELECT deleted_at AS deletedAt FROM blog_sponsors WHERE id=?').get(record.id)).toEqual({ deletedAt: expect.any(String) });
    expect((await call(PATCH, 'PATCH', updated)).status).toBe(404);
  });

  it('prevents duplicate active names while allowing a new record after soft deletion', () => {
    const input = { name: 'Case_Test', minecraftUsername: '', amount: 1 };
    const record = saveSponsor(input);
    expect(() => saveSponsor({ ...input, name: 'case_test' })).toThrow('这位赞助者已存在');
    deleteSponsor({ ...record });
    const replacement = saveSponsor(input);
    expect(replacement.id).not.toBe(record.id);
    deleteSponsor({ ...replacement });
  });

  it.each([0, -1, 0.001, 1e-10, NaN, Infinity, siteConfig.sponsorFields.maximumAmount + 1, '20'])('rejects invalid amount %s', (amount) => {
    expect(() => saveSponsor({ name: 'Invalid', minecraftUsername: '', amount })).toThrow('金额需要');
  });

  it('rejects invalid names, usernames and identifiers before writing', async () => {
    for (const name of ['', '  ', 'x\n', 'x'.repeat(siteConfig.sponsorFields.nameMaximumLength + 1), null]) {
      expect((await call(POST, 'POST', { name, minecraftUsername: '', amount: 1 })).status).toBe(400);
    }
    for (const minecraftUsername of ['../user', 'x', 'x'.repeat(17), 'https://example.com', null]) {
      expect((await call(POST, 'POST', { name: 'Invalid', minecraftUsername, amount: 1 })).status).toBe(400);
    }
    for (const id of [0, -1, 1.5, '1', null]) {
      expect((await call(PATCH, 'PATCH', { id, name: 'Invalid', minecraftUsername: '', amount: 1 })).status).toBe(400);
    }
  });

  it('requires authentication and same-origin JSON writes', async () => {
    const input = { name: 'Unauthorized', minecraftUsername: '', amount: 1 };
    for (const [method, handler] of Object.entries({ GET, POST, PATCH, DELETE })) {
      expect((await call(handler, method, method === 'GET' ? undefined : input, false)).status).toBe(401);
    }
    for (const origin of ['https://evil.example.com', 'null', '']) {
      expect((await call(POST, 'POST', input, true, { origin })).status).toBe(403);
    }
    expect((await call(POST, 'POST', input, true, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call(POST, 'POST', { ...input, id: 1 })).status).toBe(400);
    const response = await call(GET, 'GET');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json() as { sponsors: SponsorRecord[] }).sponsors).toEqual(listSponsors());
  });

  it('uses only valid Minecraft usernames for the configured avatar service', () => {
    expect(sponsorAvatarUrl({ name: 'Aresgao', minecraftUsername: '' })).toBe('https://minotar.net/helm/Aresgao/64.png');
    expect(sponsorAvatarUrl({ name: '显示名称', minecraftUsername: 'Test_Player' })).toContain('/Test_Player/64.png');
    expect(sponsorAvatarUrl({ name: '显示名称', minecraftUsername: '' })).toBeUndefined();
    expect(sponsorAvatarUrl({ name: 'https://example.com', minecraftUsername: '' })).toBeUndefined();
  });
});

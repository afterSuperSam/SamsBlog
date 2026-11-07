import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext } from 'astro';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { adminCookie, createAdminSession } from '../src/lib/admin-auth';
import { getSiteStats, getArticleAnalytics, getVisitorAnalytics, recordConfirmedPageView, hashVisitorToken } from '../src/lib/stats';
import { POST } from '../src/pages/api/page-view.json';
import { initializePageView } from '../src/lib/page-view';
import { serverConfig } from '../src/config/server';
import { siteConfig } from '../src/config/site';

beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-analytics-'))); });
const readerSession = vi.hoisted(() => ({ value: null as { id: number; displayName: string; avatarUrl: null } | null }));
vi.mock('../src/lib/readers', () => ({ readReaderSession: () => readerSession.value }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const token = '11111111-1111-4111-8111-111111111111';
const submit = (body: unknown = { path: '/' }, values: Record<string,string> = { 'samsblog-visitor': token }, headers: Record<string,string> = {}) => POST({
  request: new Request('https://blog.example.com/api/page-view.json', { method: 'POST', headers: { origin: 'https://blog.example.com', 'content-type': 'application/json', 'user-agent': 'fixture-browser', ...headers }, body: JSON.stringify(body) }),
  cookies: { get: (name: string) => values[name] ? { value: values[name] } : undefined },
} as unknown as APIContext) as Promise<Response>;

describe('confirmed analytics', () => {
  it('preserves legacy counts without mixing them into the new totals', () => {
    const database = getDatabase();
    database.prepare('INSERT INTO site_visitors(visitor_hash,first_seen,last_seen,page_views) VALUES (?,?,?,?)').run('legacy', '2026-01-01', '2026-01-01', 99999);
    expect(getSiteStats()).toMatchObject({ visitors: 0, pageViews: 0 });
    expect(database.prepare('SELECT page_views FROM site_visitors WHERE visitor_hash=?').get('legacy')).toEqual({ page_views: 99999 });
  });
  it('deduplicates refreshes per browser and canonical path, including cross-day refreshes', () => {
    const hash = hashVisitorToken('returning'); const start = new Date('2026-10-26T15:59:59Z');
    expect(recordConfirmedPageView(hash, '/about/', start)).toBe(true);
    expect(recordConfirmedPageView(hash, '/about', new Date(start.getTime() + 2000))).toBe(false);
    expect(recordConfirmedPageView(hash, '/content', new Date(start.getTime() + 3000))).toBe(true);
    expect(recordConfirmedPageView(hash, '/about', new Date(start.getTime() + serverConfig.analyticsDeduplicationSeconds * 1000))).toBe(true);
    expect(getSiteStats()).toMatchObject({ visitors: 1, pageViews: 3 });
  });
  it('validates browser confirmation, same origin, cookies, bots and administrator exclusion', async () => {
    expect(await (await submit()).json()).toMatchObject({ counted: true, totals: { visitors: 2 } });
    expect(await (await submit()).json()).toMatchObject({ counted: false });
    expect(await (await submit({ path: '/' }, {})).json()).toEqual({ counted: false });
    expect(await (await submit({ path: '/' }, { 'samsblog-visitor': token }, { 'user-agent': 'Googlebot' })).json()).toEqual({ counted: false });
    expect(await (await submit({ path: '/about' }, { 'samsblog-visitor': token, [adminCookie.name]: createAdminSession() })).json()).toEqual({ counted: false });
    expect((await submit({ path: '/' }, {}, { origin: 'https://other.example.com' })).status).toBe(403);
    for (const invalid of ['/admin', '/missing', '//evil.example', '/about?x=1']) expect((await submit({ path: invalid })).status).toBe(400);
    expect((await submit({ path: '/', padding: 'x'.repeat(600) })).status).toBe(413);
    const before = getSiteStats();
    expect(await (await submit({ path: '/articles/999999' })).json()).toEqual({ counted: false });
    expect(getSiteStats()).toEqual(before);
  });
  it('keeps site and article counts consistent and ignores withdrawn articles', () => {
    const id = saveArticle({ title: '统计验证', content: '正文', source: 'original', category: 'journal' });
    const hash = hashVisitorToken('reader');
    expect(recordConfirmedPageView(hash, `/articles/${id}`)).toBe(true);
    expect(recordConfirmedPageView(hash, `/articles/${id}/`)).toBe(false);
    expect(getArticleAnalytics().articles.find((entry) => entry.id === id)).toMatchObject({ views: 1, visitors: 1 });
    withdrawArticle(id);
    expect(recordConfirmedPageView(hashVisitorToken('another'), `/articles/${id}`)).toBe(false);
  });
});

describe('anonymous visitor analytics and reader association', () => {
  it('associates only a verified session without transferring browser history or adding duplicate views', async () => {
    const database = getDatabase();
    const create = (name: string) => Number(database.prepare('INSERT INTO readers(display_name,created_at,updated_at) VALUES (?,?,?)').run(name, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    const first = create('读者甲'); const second = create('读者乙');
    const visitorToken = '33333333-3333-4333-8333-333333333333';
    const values = { 'samsblog-visitor': visitorToken };
    const hash = hashVisitorToken(visitorToken);
    expect(await (await submit({ path: '/about', readerId: first }, values)).json()).toEqual({ counted: true });
    expect(database.prepare('SELECT reader_id FROM confirmed_site_visitors WHERE visitor_hash=?').get(hash)).toEqual({ reader_id: null });
    try {
      readerSession.value = { id: first, displayName: '读者甲', avatarUrl: null };
      expect(await (await submit({ path: '/about' }, values)).json()).toEqual({ counted: false });
      readerSession.value = { id: second, displayName: '读者乙', avatarUrl: null };
      expect(await (await submit({ path: '/content' }, values)).json()).toEqual({ counted: true });
      readerSession.value = null;
      await submit({ path: '/content', readerId: first }, values);
      expect(database.prepare('SELECT reader_id,page_views FROM confirmed_site_visitors WHERE visitor_hash=?').get(hash)).toEqual({ reader_id: second, page_views: 2 });
      expect(getVisitorAnalytics().visitors.find((visitor) => visitor.visitorId === hash.slice(0, 12))).toMatchObject({ pageViews: 2, lastReaderDisplayName: '读者乙' });
      database.prepare('UPDATE readers SET deleted_at=? WHERE id=?').run(new Date().toISOString(), second);
      expect(getVisitorAnalytics().visitors.find((visitor) => visitor.visitorId === hash.slice(0, 12))?.lastReaderDisplayName).toBeNull();
    } finally { readerSession.value = null; }
  });

  it('bounds pagination and sorts cumulative browser counts without exposing complete hashes', () => {
    const database = getDatabase();
    const insert = database.prepare('INSERT INTO confirmed_site_visitors(visitor_hash,first_seen,last_seen,page_views) VALUES (?,?,?,?)');
    for (let index = 0; index < serverConfig.analyticsVisitorPageSize + 2; index++) {
      insert.run(hashVisitorToken(`pagination-${index}`), '2020-01-01T00:00:00Z', new Date(Date.UTC(2026, 10, index + 1)).toISOString(), 1000 + index);
    }
    const recent = getVisitorAnalytics();
    const views = getVisitorAnalytics({ sort: 'views' });
    expect(recent.visitors).toHaveLength(serverConfig.analyticsVisitorPageSize);
    expect(views.visitors[0].pageViews).toBe(1000 + serverConfig.analyticsVisitorPageSize + 1);
    expect(views.visitors[0].firstSeen).toBe('2020-01-01T00:00:00Z');
    expect(getVisitorAnalytics({ page: 999999 }).page).toBe(recent.totalPages);
    expect(getVisitorAnalytics({ page: NaN }).page).toBe(1);
    expect(getVisitorAnalytics({ page: 2 }).visitors.map((visitor) => visitor.visitorId).some((id) => recent.visitors.some((visitor) => visitor.visitorId === id))).toBe(false);
    expect(JSON.stringify(views)).not.toMatch(/visitor_hash|reader_id|email|user.agent|fingerprint/);
    expect(views.visitors.every((visitor) => visitor.visitorId.length === 12)).toBe(true);
  });
});

describe('visible browsing confirmation', () => {
  function fixture() {
    vi.useFakeTimers();
    const documentStub = Object.assign(new EventTarget(), { visibilityState: 'visible', body: { classList: { contains: () => false } } });
    const windowStub = new EventTarget(); const fetchStub = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('document', documentStub); vi.stubGlobal('window', windowStub);
    vi.stubGlobal('navigator', { webdriver: false }); vi.stubGlobal('location', { pathname: '/about' }); vi.stubGlobal('fetch', fetchStub);
    return { documentStub, windowStub, fetchStub };
  }
  it('waits ten continuous visible seconds and sends once', async () => {
    const { documentStub, fetchStub } = fixture(); initializePageView();
    await vi.advanceTimersByTimeAsync(siteConfig.analytics.visibleMilliseconds - 1); expect(fetchStub).not.toHaveBeenCalled();
    documentStub.visibilityState = 'hidden'; documentStub.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30000); expect(fetchStub).not.toHaveBeenCalled();
    documentStub.visibilityState = 'visible'; documentStub.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(siteConfig.analytics.visibleMilliseconds - 1); expect(fetchStub).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(fetchStub).toHaveBeenCalledOnce();
    documentStub.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(30000); expect(fetchStub).toHaveBeenCalledOnce();
  });
  it('cancels on leaving and restarts when returning from the browser cache', async () => {
    const { windowStub, fetchStub } = fixture(); initializePageView();
    await vi.advanceTimersByTimeAsync(9000); windowStub.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(30000); expect(fetchStub).not.toHaveBeenCalled();
    windowStub.dispatchEvent(new Event('pageshow')); await vi.advanceTimersByTimeAsync(10000); expect(fetchStub).toHaveBeenCalledOnce();
  });
  it('does not track automated browsers or administrative pages', async () => {
    const { fetchStub } = fixture(); vi.stubGlobal('navigator', { webdriver: true }); initializePageView();
    vi.stubGlobal('navigator', { webdriver: false }); vi.stubGlobal('location', { pathname: '/admin/articles' }); initializePageView();
    await vi.advanceTimersByTimeAsync(30000); expect(fetchStub).not.toHaveBeenCalled();
  });
});

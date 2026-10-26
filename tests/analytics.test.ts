import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext } from 'astro';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { createAdminSession } from '../src/lib/admin-auth';
import { getSiteStats, getArticleAnalytics, recordConfirmedPageView, hashVisitorToken } from '../src/lib/stats';
import { POST } from '../src/pages/api/page-view.json';
import { initializePageView } from '../src/lib/page-view';
import { serverConfig } from '../src/config/server';
import { siteConfig } from '../src/config/site';

beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-analytics-'))); });
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
    expect(await (await submit({ path: '/about' }, { 'samsblog-visitor': token, samsblog_admin: createAdminSession() })).json()).toEqual({ counted: false });
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

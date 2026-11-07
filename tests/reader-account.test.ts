import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readerConfig } from '../src/config/readers';
import { createMessage, listPublishedMessages, updateMessageStatus, deleteMessage } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { getReaderAccount, listReaderComments, updateReaderProfile } from '../src/lib/reader-account';
import { resolveReaderIdentity, startReaderSession, type ReaderCookies, type ReaderPublic } from '../src/lib/readers';
import { GET, PATCH } from '../src/pages/api/reader/account.json';
import { GET as comments } from '../src/pages/api/reader/comments.json';

beforeAll(async () => {
  vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'samsblog-account-')));
  vi.stubEnv('BLOG_SECRET', 'test-reader-profile-secret-never-used-in-production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
});

let sequence = 0;
function fixture() {
  const reader = resolveReaderIdentity('email', `account-${++sequence}`, `账户${sequence}`, null);
  const values = new Map<string, string>();
  const cookies = { get: (name: string) => values.has(name) ? { value: values.get(name)! } : undefined,
    set: (name: string, value: string) => { values.set(name, value); }, delete: (name: string) => { values.delete(name); } } as ReaderCookies;
  startReaderSession(cookies, reader, 'email');
  return { reader, cookies };
}
function context(cookies: ReaderCookies, method = 'GET', body?: unknown, pathname = '/api/reader/account.json', origin = 'https://blog.example.com') {
  const url = new URL(pathname, 'https://blog.example.com');
  return { url, cookies, clientAddress: `203.0.113.${sequence}`, request: new Request(url, { method,
    headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) } as unknown as APIContext;
}
const post = (reader: ReaderPublic, extra = {}) => createMessage({ readerId: reader.id, nickname: reader.displayName, content: '只在临时库中的本人评论', fingerprintHash: `account-${sequence}`, ...extra });

describe('reader account isolation', () => {
  it('requires a reader session and caches neither private data nor errors', async () => {
    const { cookies } = fixture();
    const anonymous = { ...cookies, get: () => undefined } as ReaderCookies;
    for (const handler of [GET, comments]) {
      const denied = await handler(context(anonymous));
      expect(denied.status).toBe(401);
      expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
      expect(denied.headers.get('Vary')).toBe('Cookie');
      expect((await handler(context(cookies))).status).toBe(200);
    }
  });

  it('changes only the session profile and reflects names in old comments and quotes', async () => {
    const { reader, cookies } = fixture(); const other = fixture().reader;
    const articleId = saveArticle({ title: '资料昵称验证', content: '正文', source: 'original', category: 'journal' });
    const root = post(reader, { articleId });
    post(other, { articleId, parentId: root, quoteMessageId: root, quoteContent: '本人评论' });
    const anonymous = createMessage({ nickname: reader.displayName, content: '匿名旧昵称', fingerprintHash: 'anonymous-name' });
    updateMessageStatus(anonymous, 'published');
    const response = await PATCH(context(cookies, 'PATCH', { id: other.id, readerId: other.id, displayName: '新的昵称', websiteUrl: 'https://example.com/path' }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reader).toMatchObject({ id: reader.id, displayName: '新的昵称', loginMethod: 'email' });
    expect(data.account).toMatchObject({ commentCount: 1, passkeys: [], reader: { websiteUrl: 'https://example.com/path', createdAt: expect.any(String) } });
    expect(getReaderAccount(other).reader.displayName).toBe(other.displayName);
    const thread = listPublishedMessages(60, articleId)[0];
    expect(thread.nickname).toBe('新的昵称');
    expect(thread.replies?.[0].quoteNickname).toBe('新的昵称');
    expect(listPublishedMessages().find((message) => message.id === anonymous)?.nickname).toBe(reader.displayName);
    expect(JSON.stringify(thread)).not.toMatch(/reader_id|website_url|loginMethod|email/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates origin, profile strings, actual body bytes and source/account quotas', async () => {
    const { reader, cookies } = fixture();
    const valid = { displayName: '有效昵称', websiteUrl: '' };
    expect((await PATCH(context(cookies, 'PATCH', valid, undefined, 'https://other.example'))).status).toBe(403);
    for (const displayName of ['', '一', '😀'.repeat(25), '坏\u0000名字', 42]) {
      expect(() => updateReaderProfile(reader, { ...valid, displayName })).toThrow();
    }
    for (const websiteUrl of ['javascript:alert(1)', '//example.com', 'https://user:password@example.com', 'https://exam\nple.com/', 'http:example.com', 'https://example.com/\\evil', 42]) {
      expect(() => updateReaderProfile(reader, { ...valid, websiteUrl })).toThrow();
    }
    expect(updateReaderProfile(reader, { ...valid, displayName: '😀'.repeat(24) }).displayName).toHaveLength(48);
    expect((await PATCH(context(cookies, 'PATCH', { ...valid, padding: 'x'.repeat(readerConfig.requestMaximumBytes) }))).status).toBe(413);
    for (let index = 1; index < readerConfig.profileSourceLimit; index++) expect((await PATCH(context(cookies, 'PATCH', valid))).status).toBe(200);
    expect((await PATCH(context(cookies, 'PATCH', valid))).status).toBe(429);
  });

  it('lists only owned undeleted content, protects private article metadata and bounds pages', async () => {
    const { reader, cookies } = fixture(); const other = fixture().reader;
    const articleId = saveArticle({ title: '不再公开的标题', content: '正文', source: 'original', category: 'journal' });
    const publicId = post(reader);
    const hidden = post(reader); updateMessageStatus(hidden, 'hidden');
    const pending = post(reader, { articleId }); updateMessageStatus(pending, 'pending');
    const deleted = post(reader); deleteMessage(deleted);
    const foreign = post(other);
    withdrawArticle(articleId);
    const result = listReaderComments(reader.id);
    expect(result.total).toBe(3);
    expect(result.comments.map((message) => message.id)).not.toContain(deleted);
    expect(result.comments.map((message) => message.id)).not.toContain(foreign);
    expect(result.comments.find((message) => message.id === pending)).toMatchObject({ status: 'pending', articleTitle: null, url: null });
    expect(result.comments.find((message) => message.id === hidden)?.url).toBeNull();
    expect(result.comments.find((message) => message.id === publicId)?.url).toBe('/#guestbook');
    expect(getReaderAccount(reader).commentCount).toBe(3);
    for (let index = 0; index < readerConfig.accountPageSize; index++) post(reader);
    expect(listReaderComments(reader.id).comments).toHaveLength(readerConfig.accountPageSize);
    expect(listReaderComments(reader.id, 999999)).toMatchObject({ page: 2, total: readerConfig.accountPageSize + 3 });
    const response = await comments(context(cookies, 'GET', undefined, `/api/reader/comments.json?readerId=${other.id}&page=2`));
    expect((await response.json()).total).toBe(readerConfig.accountPageSize + 3);
    expect((await comments(context(cookies, 'GET', undefined, '/api/reader/comments.json?page=0'))).status).toBe(400);
  });
});

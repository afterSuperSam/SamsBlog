import { mkdtemp, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIContext } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readerConfig } from '../src/config/readers';
import { createMessage, listPublishedMessages, updateMessageStatus, deleteMessage, getDatabase } from '../src/lib/db';
import { saveArticle, withdrawArticle } from '../src/lib/articles';
import { getReaderAccount, listReaderComments, updateReaderAvatar, updateReaderProfile } from '../src/lib/reader-account';
import { readReaderSession, resolveReaderIdentity, startReaderSession, type ReaderCookies, type ReaderPublic } from '../src/lib/readers';
import { changeMediaVisibility, getMedia, mediaResponse, saveMedia } from '../src/lib/media';
import { GET, PATCH } from '../src/pages/api/reader/account.json';
import { GET as comments } from '../src/pages/api/reader/comments.json';
import { POST as uploadAvatar } from '../src/pages/api/reader/avatar.json';
import { DELETE as deleteMedia } from '../src/pages/api/admin/media.json';
import { POST as postComment } from '../src/pages/api/guestbook/messages.json';
import { GET as session } from '../src/pages/api/reader/session.json';
import { siteConfig } from '../src/config/site';

vi.mock('../src/lib/reply-notifications', async (original) => ({ ...await original<object>(), replyNotificationsConfigured: true, queueReplyNotification: vi.fn(), queueAdminNotification: vi.fn() }));

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
const avatarPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u1sAAAAASUVORK5CYII=', 'base64');
function avatarContext(cookies: ReaderCookies, file = new File([avatarPng], '../../头像.html', { type: 'text/html' }), origin = 'https://blog.example.com') {
  const form = new FormData(); form.set('file', file);
  const result = context(cookies, 'POST', undefined, '/api/reader/avatar.json');
  result.request = new Request(result.url, { method: 'POST', headers: { origin }, body: form });
  return result;
}

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
    for (const displayName of ['', '一', '😀'.repeat(13), '坏\u0000名字', 42]) {
      expect(() => updateReaderProfile(reader, { ...valid, displayName })).toThrow();
    }
    for (const websiteUrl of ['javascript:alert(1)', '//example.com', 'https://user:password@example.com', 'https://exam\nple.com/', 'http:example.com', 'https://example.com/\\evil', 42]) {
      expect(() => updateReaderProfile(reader, { ...valid, websiteUrl })).toThrow();
    }
    expect(updateReaderProfile(reader, { ...valid, displayName: '😀'.repeat(12) }).displayName).toHaveLength(24);
    expect((await PATCH(context(cookies, 'PATCH', { ...valid, padding: 'x'.repeat(readerConfig.requestMaximumBytes) }))).status).toBe(413);
    for (let index = 1; index < readerConfig.profileSourceLimit; index++) expect((await PATCH(context(cookies, 'PATCH', valid))).status).toBe(200);
    expect((await PATCH(context(cookies, 'PATCH', valid))).status).toBe(429);
  });

  it('keeps notification email private, optional and separate from login identity', async () => {
    const { reader, cookies } = fixture(); const other = fixture().reader;
    const profile = { displayName: reader.displayName, websiteUrl: '' };
    expect(getReaderAccount(reader).notificationEmail).toBe('');
    const saved = await PATCH(context(cookies, 'PATCH', { ...profile, notificationEmail: '  Private.Notify@Example.com  ', readerId: other.id }));
    expect(saved.status).toBe(200);
    const data = await saved.json();
    expect(data.account.notificationEmail).toBe('private.notify@example.com');
    expect(data.reader).not.toHaveProperty('notificationEmail');
    expect(data.account.reader).not.toHaveProperty('notificationEmail');
    expect(getReaderAccount(other).notificationEmail).toBe('');
    expect((await (await GET(context(cookies))).json()).notificationEmail).toBe('private.notify@example.com');
    expect(await (await session(context(cookies))).text()).not.toContain('private.notify@example.com');
    expect(getDatabase().prepare('SELECT subject FROM reader_identities WHERE reader_id=?').all(reader.id)).not.toEqual(expect.arrayContaining([{ subject: 'private.notify@example.com' }]));
    updateReaderProfile(reader, profile);
    expect(getReaderAccount(reader).notificationEmail).toBe('private.notify@example.com');
    for (const notificationEmail of [null, 42, [], 'invalid', 'test@example.com\r\nBcc:other@example.com', 'x'.repeat(255)]) {
      expect(() => updateReaderProfile(reader, { ...profile, notificationEmail })).toThrow();
    }
    expect(getReaderAccount(reader).notificationEmail).toBe('private.notify@example.com');
    updateReaderProfile(reader, { ...profile, notificationEmail: '' });
    expect(getReaderAccount(reader).notificationEmail).toBe('');
    expect(getDatabase().prepare('SELECT notification_email AS email FROM readers WHERE id=?').get(reader.id)).toEqual({ email: null });
  });

  it('uses the current account notification address only for future consented submissions', async () => {
    const { reader, cookies } = fixture();
    const profile = { displayName: reader.displayName, websiteUrl: '' };
    const articleId = saveArticle({ title: '通知邮箱验证', content: '正文', source: 'original', category: 'journal' });
    let submission = 0;
    const postWith = async (extra = {}, caller = cookies) => {
      const response = await postComment({ ...context(caller, 'POST', { content: '通知地址隔离验证', nickname: '匿名访客', notifyReply: true, email: { forged: 'attacker@example.com' }, ...extra }, '/api/guestbook/messages.json'), clientAddress: `198.51.100.${++submission}` });
      expect(response.status).toBe(201);
      const { id } = await response.json();
      return getDatabase().prepare('SELECT id,email,notify_reply AS notifyReply FROM messages WHERE id=?').get(id) as { id: number; email: string; notifyReply: number };
    };
    const unset = await postWith();
    expect(unset).toMatchObject({ email: '', notifyReply: 0 });
    updateReaderProfile(reader, { ...profile, notificationEmail: 'first@example.com' });
    const root = await postWith({ articleId });
    expect(root).toMatchObject({ email: 'first@example.com', notifyReply: 1 });
    expect(await postWith({ articleId, parentId: root.id })).toMatchObject({ email: 'first@example.com', notifyReply: 1 });
    expect(await postWith({ notifyReply: false })).toMatchObject({ email: '', notifyReply: 0 });
    updateReaderProfile(reader, { ...profile, notificationEmail: 'second@example.com' });
    expect(await postWith()).toMatchObject({ email: 'second@example.com', notifyReply: 1 });
    updateReaderProfile(reader, { ...profile, notificationEmail: '' });
    expect(await postWith()).toMatchObject({ email: '', notifyReply: 0 });
    expect(getDatabase().prepare('SELECT email FROM messages WHERE id=?').get(root.id)).toEqual({ email: 'first@example.com' });
    expect(JSON.stringify(listPublishedMessages(60, articleId))).not.toMatch(/first@example.com|notificationEmail|notify_reply|email/);
    const anonymous = { ...cookies, get: () => undefined } as ReaderCookies;
    expect(await postWith({ email: 'anonymous@example.com' }, anonymous)).toMatchObject({ email: 'anonymous@example.com', notifyReply: 1 });
    expect((await postComment(context(anonymous, 'POST', { content: '匿名校验', nickname: '匿名访客', email: { invalid: true } }, '/api/guestbook/messages.json'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves historical long names until an explicit valid profile edit', () => {
    const { reader, cookies } = fixture();
    const legacyName = '旧'.repeat(24);
    getDatabase().prepare('UPDATE readers SET display_name=? WHERE id=?').run(legacyName, reader.id);
    expect(readReaderSession(cookies)?.displayName).toBe(legacyName);
    expect(() => updateReaderProfile(reader, { displayName: legacyName, websiteUrl: '' })).toThrow('2–12');
    expect(getReaderAccount(reader).reader.displayName).toBe(legacyName);
  });

  it('uploads a content-checked avatar only for its authenticated owner without media administration', async () => {
    const { reader, cookies } = fixture(); const otherAccount = fixture(); const other = otherAccount.reader;
    const anonymous = { ...cookies, get: () => undefined } as ReaderCookies;
    expect((await uploadAvatar(avatarContext(anonymous))).status).toBe(401);
    expect((await uploadAvatar(avatarContext(cookies, undefined, 'https://other.example'))).status).toBe(403);
    const response = await uploadAvatar(avatarContext(cookies));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    const result = await response.json();
    expect(result.reader.id).toBe(reader.id);
    expect(result.reader.avatarUrl).toMatch(/^\/uploads\/[a-f0-9]{64}\.png$/);
    expect(result.account.reader.avatarUrl).toBe(result.reader.avatarUrl);
    expect(readReaderSession(cookies)?.avatarUrl).toBe(result.reader.avatarUrl);
    expect(getReaderAccount(other).reader.avatarUrl).toBeNull();
    const media = getMedia(result.reader.avatarUrl.split('/').pop())!;
    expect((await uploadAvatar(avatarContext(otherAccount.cookies))).status).toBe(200);
    expect(getReaderAccount(other).reader.avatarUrl).toBe(media.url);
    expect((await mediaResponse(media.filename, new Request(`https://blog.example.com${media.url}`))).headers.get('Content-Type')).toBe('image/png');
    expect(() => changeMediaVisibility(media.id, false)).toThrow('读者头像引用');
    expect((await deleteMedia(context(cookies, 'DELETE', { id: media.id }, '/api/admin/media.json'))).status).toBe(401);
    const replacement = new File([Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')], '头像.gif');
    expect((await uploadAvatar(avatarContext(cookies, replacement))).status).toBe(200);
    expect(getMedia(media.filename)).toBeDefined();
    getDatabase().prepare('UPDATE readers SET deleted_at=? WHERE id=?').run(new Date().toISOString(), other.id);
    expect(() => changeMediaVisibility(media.id, false)).toThrow('读者头像引用');
    expect((await uploadAvatar(avatarContext(otherAccount.cookies))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects active content, extra form fields and actual oversized avatar bytes', async () => {
    const { cookies } = fixture();
    for (const content of ['<svg onload="alert(1)"/>', '<html><script>alert(1)</script></html>']) {
      expect((await uploadAvatar(avatarContext(cookies, new File([content], '头像.png', { type: 'image/png' })))).status).toBe(415);
    }
    expect((await uploadAvatar(avatarContext(cookies, new File([], 'empty.png')))).status).toBe(413);
    const extra = avatarContext(cookies);
    const form = new FormData(); form.set('file', new File([avatarPng], 'avatar.png')); form.set('readerId', '1');
    extra.request = new Request(extra.url, { method: 'POST', headers: { origin: extra.url.origin }, body: form });
    expect((await uploadAvatar(extra)).status).toBe(400);
    expect((await uploadAvatar(avatarContext(cookies, new File([new Uint8Array(readerConfig.avatarMaximumBytes + 1)], 'oversized.png')))).status).toBe(413);
    const oversized = avatarContext(cookies);
    oversized.request = new Request(oversized.url, { method: 'POST', headers: { origin: oversized.url.origin, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': '1' }, body: new Uint8Array(readerConfig.avatarMaximumBytes + readerConfig.avatarMultipartOverheadBytes + 1) });
    expect((await uploadAvatar(oversized)).status).toBe(413);
    const maximum = new Uint8Array(readerConfig.avatarMaximumBytes);
    maximum.set(new TextEncoder().encode('GIF89a')); maximum[maximum.length - 1] = 59;
    expect((await uploadAvatar(avatarContext(cookies, new File([maximum], 'maximum.gif')))).status).toBe(200);
  });

  it('does not restore removed media and enforces the reader upload quota', async () => {
    const { cookies } = fixture();
    const removedBytes = new Uint8Array(14); removedBytes.set(new TextEncoder().encode('GIF87a')); removedBytes[13] = 59;
    const removedFile = new File([removedBytes], 'removed.gif');
    const media = await saveMedia(removedFile);
    changeMediaVisibility(media.id, false);
    expect((await uploadAvatar(avatarContext(cookies, removedFile))).status).toBe(409);
    expect(getMedia(media.filename)).toBeUndefined();
    for (let index = 1; index < readerConfig.avatarReaderLimit; index++) {
      const upload = avatarContext(cookies); upload.clientAddress = `198.51.100.${index}`;
      expect((await uploadAvatar(upload)).status).toBe(200);
    }
    const limited = avatarContext(cookies); limited.clientAddress = '198.51.100.250';
    expect((await uploadAvatar(limited)).status).toBe(429);
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

let avatarSequence = 100;
function uniqueAvatar() {
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  bytes.writeUInt16LE(++avatarSequence, 6);
  return new File([bytes], `fixture-${avatarSequence}.gif`);
}
const storedAvatar = (address: string) => path.join(process.env.BLOG_DATA_DIR!, 'uploads', address.split('/').pop()!);

describe('unused avatar ownership and references', () => {
  it('reclaims only the previous unreferenced avatar after a successful committed replacement', async () => {
    const { reader } = fixture();
    const original = await updateReaderAvatar(reader, uniqueAvatar());
    const previous = original.reader.avatarUrl!;
    const replacementFile = uniqueAvatar();
    const replacement = await updateReaderAvatar(reader, replacementFile);
    expect(replacement.reader.avatarUrl).not.toBe(previous);
    expect(getMedia(previous.split('/').pop()!, true)).toBeUndefined();
    await expect(stat(storedAvatar(previous))).rejects.toMatchObject({ code: 'ENOENT' });
    await updateReaderAvatar(reader, replacementFile);
    expect((await stat(storedAvatar(replacement.reader.avatarUrl!))).isFile()).toBe(true);
    await expect(updateReaderAvatar(reader, new File(['<svg/>'], 'bad.png'))).rejects.toMatchObject({ status: 415 });
    expect(getReaderAccount(reader).reader.avatarUrl).toBe(replacement.reader.avatarUrl);
    expect((await stat(storedAvatar(replacement.reader.avatarUrl!))).isFile()).toBe(true);
  });

  it.each(['account', 'deleted-account', 'article', 'deleted-article', 'draft', 'library', 'promoted-library', 'configuration', 'external'] as const)('preserves old files referenced by %s', async (reference) => {
    const { reader } = fixture();
    const originalFile = uniqueAvatar();
    if (reference === 'library') await saveMedia(originalFile);
    const original = await updateReaderAvatar(reader, originalFile);
    const address = original.reader.avatarUrl!;
    const filename = address.split('/').pop()!;
    const database = getDatabase();
    const previousBackground = siteConfig.friendApplications.backgroundUrl;
    if (reference === 'account' || reference === 'deleted-account') {
      const other = fixture().reader;
      database.prepare('UPDATE readers SET avatar_url=?,deleted_at=? WHERE id=?').run(address, reference === 'deleted-account' ? new Date().toISOString() : null, other.id);
    } else if (reference === 'article' || reference === 'deleted-article') {
      const articleId = saveArticle({ title: '隔离头像引用', content: `![引用](<${address}>)`, source: 'original', category: 'journal' });
      if (reference === 'deleted-article') database.prepare('UPDATE blog_articles SET deleted_at=? WHERE id=?').run(new Date().toISOString(), articleId);
    } else if (reference === 'draft') {
      const encoded = address.replace(filename, '%' + filename.charCodeAt(0).toString(16) + filename.slice(1));
      database.prepare('INSERT INTO blog_article_drafts(id,payload,revision,updated_at) VALUES (?,?,1,?)').run(randomUUID(), JSON.stringify({ content: `![草稿](${encoded})`, coverUrl: '' }), new Date().toISOString());
    } else if (reference === 'promoted-library') await saveMedia(originalFile);
    else if (reference === 'configuration') (siteConfig.friendApplications as { backgroundUrl: string }).backgroundUrl = address;
    else if (reference === 'external') database.prepare('UPDATE readers SET avatar_url=? WHERE id=?').run(`https://other.example${address}`, reader.id);
    try {
      await updateReaderAvatar(reader, uniqueAvatar());
      expect(getMedia(filename)).toBeDefined();
      expect((await stat(storedAvatar(address))).isFile()).toBe(true);
    } finally { (siteConfig.friendApplications as { backgroundUrl: string }).backgroundUrl = previousBackground; }
  });

  it('retains the original file when the authenticated reader is removed before replacement', async () => {
    const { reader } = fixture();
    const original = await updateReaderAvatar(reader, uniqueAvatar());
    getDatabase().prepare('UPDATE readers SET deleted_at=? WHERE id=?').run(new Date().toISOString(), reader.id);
    await expect(updateReaderAvatar(reader, uniqueAvatar())).rejects.toMatchObject({ status: 401 });
    expect(getMedia(original.reader.avatarUrl!.split('/').pop()!)).toBeDefined();
    expect((await stat(storedAvatar(original.reader.avatarUrl!))).isFile()).toBe(true);
  });
});

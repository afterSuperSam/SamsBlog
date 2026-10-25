import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import type { APIContext } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/config/server';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), listFriends: vi.fn(), database: null as unknown as Database.Database }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('../src/lib/friends', () => ({ listFriends: mocks.listFriends }));
vi.mock('../src/lib/db', () => ({ getDatabase: () => mocks.database }));

const rss = (title = '文章', date = '2026-10-18T00:00:00Z') => `<rss><channel><item><title>${title}</title><link>/posts/latest</link>${date ? `<pubDate>${date}</pubDate>` : ''}</item></channel></rss>`;

function friends(values: Array<{ id: number; rssUrl: string }>) {
  mocks.listFriends.mockReturnValue(values);
  const save = mocks.database.prepare('INSERT INTO friends(id,rss_url) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET rss_url=excluded.rss_url');
  values.forEach((friend) => save.run(friend.id, friend.rssUrl));
}

function respond(body = rss(), statusCode = 200, headers: Record<string, string> = {}) {
  return (_url: URL, _options: unknown, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = vi.fn();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      response.statusCode = statusCode;
      response.headers = headers;
      let destroyed = false;
      response.destroy = vi.fn(() => { destroyed = true; });
      callback(response);
      queueMicrotask(() => {
        if (destroyed) return;
        response.emit('data', Buffer.from(body));
        if (!destroyed) response.emit('end');
      });
    });
    return request;
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockReset().mockImplementation(respond());
  mocks.listFriends.mockReset();
  mocks.database = new Database(':memory:');
  mocks.database.exec(`CREATE TABLE friends(id INTEGER PRIMARY KEY,rss_url TEXT NOT NULL,visible INTEGER NOT NULL DEFAULT 1,deleted_at TEXT);
    CREATE TABLE friend_feed_cache(friend_id INTEGER PRIMARY KEY,rss_url TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',entry_url TEXT NOT NULL DEFAULT '',published_at TEXT,checked_at TEXT NOT NULL);`);
  friends([{ id: 1, rssUrl: 'https://example.com/feed.xml' }]);
});
afterEach(() => { mocks.database.close(); vi.useRealTimers(); });

describe('bounded RSS and Atom parsing', () => {
  it('processes long ampersand runs without consuming the next valid entity', async () => {
    const { parseFriendFeed } = await import('../src/lib/friend-feeds');
    const ampersands = '&'.repeat(100_000);
    expect(parseFriendFeed(rss(`${ampersands}&amp;`), 'https://example.com/feed')?.title).toBe(`${ampersands}&`);
    expect(parseFriendFeed(rss(ampersands), 'https://example.com/feed')?.title).toBe(ampersands);
  });

  it('extracts only metadata, decodes XML entities and CDATA, and chooses the newest dated item', async () => {
    const { parseFriendFeed } = await import('../src/lib/friend-feeds');
    const xml = `<rss><channel>
      <item><title>Older &amp; &#65;</title><link>/old</link><pubDate>2025-01-01</pubDate></item>
      <item><title><![CDATA[New & personal]]></title><link>../new?x=1&amp;y=2</link><dc:date>2026-10-18T03:00:00Z</dc:date><description><![CDATA[<script>ignored()</script>]]></description></item>
      <item><title>Unknown date</title><link>/undated</link></item>
    </channel></rss>`;
    expect(parseFriendFeed(xml, 'https://example.com/feeds/rss.xml')).toEqual({ title: 'New & personal', url: 'https://example.com/new?x=1&y=2', publishedAt: '2026-10-18T03:00:00.000Z' });
    expect(parseFriendFeed(rss('A &amp; &#x42; &quot;C&quot;', ''), 'https://example.com/feed')).toMatchObject({ title: 'A & B "C"', publishedAt: null });
  });

  it('supports Atom alternate href links, XHTML title text and fallback dates', async () => {
    const { parseFriendFeed } = await import('../src/lib/friend-feeds');
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title type="xhtml"><div>New <b>entry</b></div></title><link rel="self" href="/api/entry"/><link rel="alternate" href="../post?x=&quot;a&gt;b&quot;"/>
      <published>invalid</published><updated>2026-10-18T04:00:00+08:00</updated>
    </entry></feed>`;
    expect(parseFriendFeed(xml, 'https://example.com/feeds/atom')).toEqual({ title: 'New entry', url: 'https://example.com/post?x=%22a%3Eb%22', publishedAt: '2026-10-17T20:00:00.000Z' });
  });

  it('keeps the first undated valid item and rejects unsafe entry links', async () => {
    const { parseFriendFeed } = await import('../src/lib/friend-feeds');
    const item = (title: string, link: string) => `<item><title>${title}</title><link>${link}</link></item>`;
    const xml = `<rss><channel>${item('unsafe', 'javascript:alert(1)')}${item('credentials', 'https://user:password@example.com/')}${item('first', '/first')}${item('second', '/second')}</channel></rss>`;
    expect(parseFriendFeed(xml, 'https://example.com/feed')).toEqual({ title: 'first', url: 'https://example.com/first', publishedAt: null });
    expect(parseFriendFeed('<feed/>', 'https://example.com/feed')).toBeNull();
  });

  it('rejects declarations, entity expansion, malformed XML and configured resource limits', async () => {
    const { parseFriendFeed } = await import('../src/lib/friend-feeds');
    for (const xml of ['<!DOCTYPE rss [<!ENTITY steal SYSTEM "file:///etc/passwd">]><rss/>', '<!ENTITY x "evil"><rss/>', '<rss><channel></rss>', '<html/>', '<rss/><feed/>', '<rss><channel>&unknown;<item><title>&undefined;</title></item></channel></rss>']) {
      expect(() => parseFriendFeed(xml, 'https://example.com/feed')).toThrow();
    }
    expect(() => parseFriendFeed(`<rss>${'<x>'.repeat(serverConfig.friendFeedMaximumDepth)}${'</x>'.repeat(serverConfig.friendFeedMaximumDepth)}</rss>`, 'https://example.com/feed')).toThrow('nesting limit');
    expect(() => parseFriendFeed(`<rss>${'x'.repeat(serverConfig.friendFeedMaximumBytes)}</rss>`, 'https://example.com/feed')).toThrow('oversized');
    expect(() => parseFriendFeed(`<rss><channel>${'<item/>'.repeat(serverConfig.friendFeedMaximumEntries + 1)}</channel></rss>`, 'https://example.com/feed')).toThrow('entry limit');
  });
});

describe('pinned feed requests and persistent caching', () => {
  it('builds a public cached timeline with recent dates first and source links', async () => {
    const { getCachedFriendFeeds } = await import('../src/lib/friend-feeds');
    const entries = [
      { id: 1, rssUrl: 'https://a.example/feed', name: '甲', url: 'https://a.example/' },
      { id: 2, rssUrl: 'https://b.example/feed', name: '乙', url: 'https://b.example/' },
      { id: 3, rssUrl: 'https://c.example/feed', name: '丙', url: 'https://c.example/' },
    ];
    friends(entries);
    const insert = mocks.database.prepare('INSERT INTO friend_feed_cache(friend_id,rss_url,title,entry_url,published_at,checked_at) VALUES (?,?,?,?,?,?)');
    entries.forEach((entry, index) => insert.run(entry.id, entry.rssUrl, `文章${entry.id}`, `${entry.url}post`, [null, '2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z'][index], '2026-10-25T01:00:00Z'));
    expect(getCachedFriendFeeds().map(({ id, sourceName, sourceUrl }) => [id, sourceName, sourceUrl])).toEqual([[3, '丙', 'https://c.example/'], [2, '乙', 'https://b.example/'], [1, '甲', 'https://a.example/']]);
    mocks.listFriends.mockReturnValue([entries[0]]);
    expect(getCachedFriendFeeds()).toHaveLength(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('shares requests, pins validated DNS, caches dates and never blocks synchronous cache reads', async () => {
    const { getCachedFriendFeed, getFriendFeeds } = await import('../src/lib/friend-feeds');
    expect(getCachedFriendFeed(1, 'https://example.com/feed.xml')).toBeNull();
    const [first, second] = await Promise.all([getFriendFeeds(), getFriendFeeds()]);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ id: 1, title: '文章', url: 'https://example.com/posts/latest', publishedAt: '2026-10-18T00:00:00.000Z' });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const options = mocks.request.mock.calls[0]![1];
    const callback = vi.fn();
    options.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.headers['Accept-Encoding']).toBe('identity');
    await getFriendFeeds();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('retains valid cached metadata after failure and caches failures to prevent retry storms', async () => {
    const { getFriendFeeds } = await import('../src/lib/friend-feeds');
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await getFriendFeeds();
    vi.setSystemTime(Date.now() + serverConfig.friendFeedCacheSeconds * 1000 + 1);
    mocks.request.mockImplementation(respond('', 503));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = await getFriendFeeds();
    expect(failed[0]).toMatchObject({ title: first[0]!.title, url: first[0]!.url, publishedAt: first[0]!.publishedAt });
    expect(failed[0]!.checkedAt).not.toBe(first[0]!.checkedAt);
    expect(warning).toHaveBeenCalledWith('Friend feed refresh failed', expect.objectContaining({ id: 1 }));
    await getFriendFeeds();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('invalidates old feed URLs immediately and excludes nonpublic friends', async () => {
    const { getCachedFriendFeed, getFriendFeeds } = await import('../src/lib/friend-feeds');
    await getFriendFeeds();
    friends([{ id: 1, rssUrl: 'https://example.com/new.xml' }]);
    expect(getCachedFriendFeed(1, 'https://example.com/new.xml')).toBeNull();
    mocks.request.mockImplementation(respond('', 503));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getFriendFeeds()).toEqual([]);
    expect(getCachedFriendFeed(1, 'https://example.com/feed.xml')).toBeNull();
    await getFriendFeeds();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    mocks.listFriends.mockReturnValue([]);
    expect(await getFriendFeeds()).toEqual([]);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('rejects private redirects and oversized or compressed bodies without a second outbound request', async () => {
    const { getFriendFeeds } = await import('../src/lib/friend-feeds');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.request.mockImplementation(respond('', 302, { location: 'http://169.254.169.254/latest' }));
    expect(await getFriendFeeds()).toEqual([]);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const { requestFriendResource } = await import('../src/lib/friend-status');
    mocks.request.mockImplementation(respond('oversized payload'));
    await expect(requestFriendResource(new URL('https://example.com/feed'), AbortSignal.timeout(1000), 4)).rejects.toThrow('byte limit');
    mocks.request.mockImplementation(respond('', 200, { 'content-length': '999999999' }));
    await expect(requestFriendResource(new URL('https://example.com/feed'), AbortSignal.timeout(1000), 4)).rejects.toThrow('byte limit');
    mocks.request.mockImplementation(respond('compressed', 200, { 'content-encoding': 'gzip' }));
    await expect(requestFriendResource(new URL('https://example.com/feed'), AbortSignal.timeout(1000), 100)).rejects.toThrow('Compressed');
  });

  it('resolves relative entry links against the validated final feed URL', async () => {
    const { getFriendFeeds } = await import('../src/lib/friend-feeds');
    mocks.request.mockImplementationOnce(respond('', 302, { location: 'https://other.example.com/feeds/final.xml' })).mockImplementationOnce(respond(rss()));
    expect((await getFriendFeeds())[0]!.url).toBe('https://other.example.com/posts/latest');
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('rejects truncated response streams before publishing partial metadata', async () => {
    const { requestFriendResource } = await import('../src/lib/friend-status');
    mocks.request.mockImplementation((_url, _options, callback) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      request.destroy = vi.fn();
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: () => void };
        response.statusCode = 200;
        response.headers = {};
        response.destroy = vi.fn();
        callback(response);
        response.emit('data', Buffer.from('<rss>'));
        response.emit('close');
      });
      return request;
    });
    await expect(requestFriendResource(new URL('https://example.com/feed'), AbortSignal.timeout(1000), 1024)).rejects.toThrow('prematurely');
  });

  it('caps concurrent refreshes and refuses arbitrary query destinations', async () => {
    const { getFriendFeeds } = await import('../src/lib/friend-feeds');
    friends(Array.from({ length: 8 }, (_, index) => ({ id: index + 1, rssUrl: `https://site${index}.example.com/feed` })));
    let active = 0;
    let maximum = 0;
    const responder = respond();
    mocks.request.mockImplementation((url, options, callback) => {
      maximum = Math.max(maximum, ++active);
      return responder(url, options, (response) => {
        (response as EventEmitter).once('end', () => { active--; });
        callback(response);
      });
    });
    expect(await getFriendFeeds()).toHaveLength(8);
    expect(maximum).toBeLessThanOrEqual(serverConfig.friendStatusConcurrency);
    const { GET } = await import('../src/pages/api/friends/feeds.json');
    const calls = mocks.request.mock.calls.length;
    const response = await GET({ url: new URL('https://blog.example/api/friends/feeds.json?url=http://127.0.0.1') } as APIContext) as Response;
    expect(response.status).toBe(400);
    expect(mocks.request).toHaveBeenCalledTimes(calls);
  });
});

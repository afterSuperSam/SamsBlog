import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { listFriends } from './friends';
import { requestFriendResource } from './friend-status';

export interface FriendFeedRecord { id: number; title: string; url: string; publishedAt: string | null; checkedAt: string }
export interface FriendFeedUpdate extends FriendFeedRecord { sourceName: string; sourceUrl: string }
interface FeedEntry { title: string; url: string; publishedAt: string | null }
interface FeedCacheRow { title: string; entry_url: string; published_at: string | null; checked_at: string }

function decodeXmlText(value: string) {
  return value.replace(/&([^;&\s]+);/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    const point = /^#x[\da-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(point) || point < 1 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('Unsupported feed XML entity');
    return String.fromCodePoint(point);
  });
}

function readXmlTag(value: string) {
  const name = /^[A-Za-z_][\w.:-]*/.exec(value)?.[0];
  if (!name) throw new Error('Invalid feed XML tag');
  const attributes: Record<string, string> = Object.create(null);
  const whitespace = /\s*/y;
  const attribute = /([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/y;
  let cursor = name.length;
  while (cursor < value.length) {
    whitespace.lastIndex = cursor;
    whitespace.exec(value);
    if (whitespace.lastIndex === value.length) break;
    if (whitespace.lastIndex === cursor) throw new Error('Invalid feed XML attributes');
    attribute.lastIndex = whitespace.lastIndex;
    const match = attribute.exec(value);
    if (!match || Object.hasOwn(attributes, match[1]!)) throw new Error('Invalid feed XML attributes');
    attributes[match[1]!] = decodeXmlText(match[3]!);
    cursor = attribute.lastIndex;
  }
  return { name, attributes };
}

function entryUrl(value: string, feedUrl: string) {
  try {
    const url = new URL(value.trim(), feedUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// 受限 XML 只提取条目元数据，不展开声明，也不把任何内容当 HTML 渲染。
export function parseFriendFeed(xml: string, feedUrl: string): FeedEntry | null {
  if (Buffer.byteLength(xml) > serverConfig.friendFeedMaximumBytes || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Unsafe or oversized feed XML');
  const stack: string[] = [];
  const entries: FeedEntry[] = [];
  let root = '';
  let closedRoot = false;
  let entryCount = 0;
  let active: { depth: number; title: string; link: string; dates: Record<string, string> } | null = null;
  const localName = (name: string) => name.split(':').at(-1)!.toLowerCase();
  const appendText = (value: string, cdata = false) => {
    if (!stack.length && value.trim()) throw new Error('Unexpected text outside feed root');
    if (!active || stack.length <= active.depth) return;
    const field = localName(stack[active.depth]!);
    const text = cdata ? value : decodeXmlText(value);
    if (field === 'title') active.title += text;
    else if (field === 'link' && stack.length === active.depth + 1) active.link += text;
    else if (['pubdate', 'date', 'published', 'updated'].includes(field)) active.dates[field] = (active.dates[field] || '') + text;
  };
  const finishElement = (name: string) => {
    if (stack.at(-1) !== name) throw new Error('Mismatched feed XML tags');
    if (active && stack.length === active.depth) {
      const url = active.link.trim() ? entryUrl(active.link, feedUrl) : null;
      const title = active.title.replace(/\s+/g, ' ').trim();
      const timestamp = ['pubdate', 'date', 'published', 'updated'].map((field) => Date.parse(active!.dates[field] || '')).find(Number.isFinite);
      if (url && title) entries.push({ title, url, publishedAt: timestamp !== undefined ? new Date(timestamp).toISOString() : null });
      active = null;
    }
    stack.pop();
    if (!stack.length) closedRoot = true;
  };
  let cursor = 0;
  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    if (opening < 0) { appendText(xml.slice(cursor)); break; }
    appendText(xml.slice(cursor, opening));
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end < 0) throw new Error('Unclosed feed XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      const end = xml.indexOf(']]>', opening + 9);
      if (end < 0 || !stack.length) throw new Error('Invalid feed CDATA');
      appendText(xml.slice(opening + 9, end), true);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end < 0) throw new Error('Unclosed feed processing instruction');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) throw new Error('Unsupported feed XML declaration');
    let end = opening + 1;
    let quote = '';
    for (; end < xml.length; end++) {
      const character = xml[end]!;
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') throw new Error('Invalid feed XML tag');
    }
    if (end === xml.length) throw new Error('Unclosed feed XML tag');
    const raw = xml.slice(opening + 1, end);
    cursor = end + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw new Error('Invalid feed closing tag');
      finishElement(name);
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const { name, attributes } = readXmlTag(selfClosing ? raw.slice(0, -1) : raw);
    const local = localName(name);
    if (!stack.length) {
      if (closedRoot || !['rss', 'rdf', 'feed'].includes(local)) throw new Error('Unsupported feed XML root');
      root = local;
    }
    const parent = localName(stack.at(-1) || '');
    stack.push(name);
    if (stack.length > serverConfig.friendFeedMaximumDepth) throw new Error('Feed XML exceeds nesting limit');
    if (!active && (local === 'item' && (parent === 'channel' || root === 'rdf' && stack.length === 2) || local === 'entry' && root === 'feed' && stack.length === 2)) {
      if (++entryCount > serverConfig.friendFeedMaximumEntries) throw new Error('Feed exceeds entry limit');
      active = { depth: stack.length, title: '', link: '', dates: Object.create(null) };
    } else if (active && local === 'link' && stack.length === active.depth + 1 && attributes.href && (!attributes.rel || attributes.rel === 'alternate')) {
      if (!active.link) active.link = attributes.href;
    }
    if (selfClosing) finishElement(name);
  }
  if (!root || stack.length) throw new Error('Incomplete feed XML');
  return entries.reduce<FeedEntry | null>((latest, entry) => !latest || entry.publishedAt && (!latest.publishedAt || entry.publishedAt > latest.publishedAt) ? entry : latest, null);
}

function cachedRow(id: number, rssUrl: string) {
  return getDatabase().prepare('SELECT title,entry_url,published_at,checked_at FROM friend_feed_cache WHERE friend_id=? AND rss_url=?').get(id, rssUrl) as FeedCacheRow | undefined;
}

export function getCachedFriendFeed(id: number, rssUrl: string): FriendFeedRecord | null {
  const row = cachedRow(id, rssUrl);
  return row?.title && row.entry_url ? { id, title: row.title, url: row.entry_url, publishedAt: row.published_at, checkedAt: row.checked_at } : null;
}

// 首页动态复用每个公开订阅的最新缓存，不为页面渲染等待外部网络。
export function getCachedFriendFeeds(): FriendFeedUpdate[] {
  return listFriends().filter((friend) => friend.rssUrl).flatMap((friend) => {
    const entry = getCachedFriendFeed(friend.id, friend.rssUrl);
    return entry ? [{ ...entry, sourceName: friend.name, sourceUrl: friend.url }] : [];
  }).sort((left, right) => (Date.parse(right.publishedAt || '') || 0) - (Date.parse(left.publishedAt || '') || 0) || left.id - right.id);
}

async function refreshFriendFeed(friend: { id: number; rssUrl: string }) {
  const previous = cachedRow(friend.id, friend.rssUrl);
  let entry: FeedEntry | null = previous?.title && previous.entry_url ? { title: previous.title, url: previous.entry_url, publishedAt: previous.published_at } : null;
  const signal = AbortSignal.timeout(serverConfig.friendStatusTimeoutMilliseconds);
  try {
    let url = new URL(friend.rssUrl);
    for (let redirects = 0; ; redirects++) {
      const response = await requestFriendResource(url, signal, serverConfig.friendFeedMaximumBytes);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.location) {
        if (redirects >= serverConfig.friendStatusMaxRedirects) throw new Error('Feed exceeds redirect limit');
        url = new URL(response.location, url);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) throw new Error(`Feed request returned ${response.statusCode}`);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      const parsed = parseFriendFeed(decoded, url.href);
      if (!parsed) throw new Error('Feed has no valid entries');
      entry = parsed;
      break;
    }
  } catch (error) {
    console.warn('Friend feed refresh failed', { id: friend.id, error: error instanceof Error ? error.message : String(error) });
  }
  getDatabase().prepare(`INSERT INTO friend_feed_cache(friend_id,rss_url,title,entry_url,published_at,checked_at)
    SELECT @id,@rssUrl,@title,@url,@publishedAt,@checkedAt FROM friends WHERE id=@id AND rss_url=@rssUrl AND visible=1 AND deleted_at IS NULL
    ON CONFLICT(friend_id) DO UPDATE SET rss_url=excluded.rss_url,title=excluded.title,entry_url=excluded.entry_url,published_at=excluded.published_at,checked_at=excluded.checked_at`)
    .run({ ...friend, title: entry?.title || '', url: entry?.url || '', publishedAt: entry?.publishedAt ?? null, checkedAt: new Date().toISOString() });
}

let pending: Promise<void> | undefined;

// 公开接口只刷新后台公开的订阅，成功和失败都受同一缓存期限约束。
export async function getFriendFeeds(): Promise<FriendFeedUpdate[]> {
  if (pending) { await pending; return getFriendFeeds(); }
  const friends = listFriends().filter((friend) => friend.rssUrl);
  const stale = friends.filter((friend) => {
    const row = cachedRow(friend.id, friend.rssUrl);
    return !row || !Number.isFinite(Date.parse(row.checked_at)) || Date.now() - Date.parse(row.checked_at) >= serverConfig.friendFeedCacheSeconds * 1000;
  });
  if (stale.length) {
    pending = (async () => {
      let next = 0;
      const worker = async () => { while (next < stale.length) await refreshFriendFeed(stale[next++]!); };
      await Promise.all(Array.from({ length: Math.min(stale.length, serverConfig.friendStatusConcurrency) }, worker));
    })();
    try { await pending; }
    finally { pending = undefined; }
  }
  return getCachedFriendFeeds();
}

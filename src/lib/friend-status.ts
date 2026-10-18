import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { serverConfig } from '../config/server';
import { listFriends } from './friends';

export interface FriendStatus {
  id: number;
  status: 'online' | 'slow' | 'offline' | 'restricted' | 'blocked';
  latencyMilliseconds: number | null;
  checkedAt: string;
}

class UnsafeFriendAddress extends Error {}

// 检测只允许公网地址，连接固定到已校验的 DNS 结果
export function isPublicFriendAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [first, second, third] = address.split('.').map(Number);
    return first !== 0 && first !== 10 && first !== 127 && first! < 224
      && !(first === 100 && second! >= 64 && second! <= 127)
      && !(first === 169 && second === 254)
      && !(first === 172 && second! >= 16 && second! <= 31)
      && !(first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)) || (second === 88 && third === 99)))
      && !(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      && !(first === 203 && second === 0 && third === 113);
  }
  if (family === 6) {
    const first = Number.parseInt(address.split(':')[0]!, 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && !(first === 0x2001 && Number.parseInt(address.split(':')[1] || '0', 16) <= 0x1ff)
      && !/^2001:0?db8:/i.test(address) && !address.includes('%');
  }
  return false;
}

async function resolveFriendAddress(url: URL, signal: AbortSignal) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new UnsafeFriendAddress('Unsupported friend URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some(({ address }) => !isPublicFriendAddress(address))) {
      throw new UnsafeFriendAddress('Non-public friend address');
    }
    return addresses.find(({ family }) => family === 4) || addresses[0]!;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function requestFriendResource(url: URL, signal: AbortSignal, maximumBytes?: number) {
  const address = await resolveFriendAddress(url, signal);
  signal.throwIfAborted();
  return new Promise<{ statusCode: number; location?: string; body?: Buffer }>((resolve, reject) => {
    const sendRequest = url.protocol === 'https:' ? requestHttps : requestHttp;
    const request = sendRequest(url, {
      method: 'GET', agent: false, signal, family: address.family,
      headers: { 'User-Agent': 'SamsBlog-FriendCheck/1.0', Accept: maximumBytes ? 'application/atom+xml, application/rss+xml, application/xml, text/xml' : 'text/html', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const result = { statusCode: response.statusCode || 0, location: response.headers.location };
      if (maximumBytes === undefined || result.statusCode < 200 || result.statusCode >= 300) {
        resolve(result);
        response.destroy();
        request.destroy();
        return;
      }
      const fail = (error: Error) => { reject(error); response.destroy(); request.destroy(); };
      if (Number(response.headers['content-length']) > maximumBytes) {
        fail(new Error('Friend response exceeds byte limit'));
        return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        fail(new Error('Compressed friend responses are unsupported'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) fail(new Error('Friend response exceeds byte limit'));
        else chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('aborted', () => fail(new Error('Friend response aborted')));
      response.once('close', () => { if (!ended) fail(new Error('Friend response ended prematurely')); });
      response.once('end', () => {
        ended = true;
        resolve({ ...result, body: Buffer.concat(chunks) });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

export async function checkFriendStatus(friend: { id: number; url: string }): Promise<FriendStatus> {
  const start = performance.now();
  const signal = AbortSignal.timeout(serverConfig.friendStatusTimeoutMilliseconds);
  let status: FriendStatus['status'] = 'offline';
  let latencyMilliseconds: number | null = null;
  try {
    let url = new URL(friend.url);
    for (let redirects = 0; redirects <= serverConfig.friendStatusMaxRedirects; redirects++) {
      const response = await requestFriendResource(url, signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.location) {
        if (redirects === serverConfig.friendStatusMaxRedirects) break;
        url = new URL(response.location, url);
        continue;
      }
      latencyMilliseconds = Math.max(1, Math.round(performance.now() - start));
      if (response.statusCode >= 200 && response.statusCode < 300) {
        status = latencyMilliseconds >= serverConfig.friendStatusSlowMilliseconds ? 'slow' : 'online';
      } else if ([401, 403, 429].includes(response.statusCode)) {
        status = 'restricted';
      }
      break;
    }
  } catch (error) {
    if (error instanceof UnsafeFriendAddress) status = 'blocked';
    else if (!signal.aborted) {
      const code = error instanceof Error && 'code' in error ? error.code : 'UNKNOWN';
      console.warn('Friend connectivity check failed', { id: friend.id, code });
    }
  }
  return { id: friend.id, status, latencyMilliseconds, checkedAt: new Date().toISOString() };
}

let cached: { key: string; expiresAt: number; results: FriendStatus[] } | undefined;
let pending: Promise<void> | undefined;

// 共用检测任务与短期缓存，公开请求不能指定任意探测地址
export async function getFriendStatuses(): Promise<FriendStatus[]> {
  const friends = listFriends();
  if (!friends.length) return [];
  const key = JSON.stringify(friends.map(({ id, url }) => [id, url]));
  if (cached?.key === key && cached.expiresAt > Date.now()) return cached.results;
  if (pending) {
    await pending;
    return getFriendStatuses();
  }
  pending = (async () => {
    const results: FriendStatus[] = [];
    let next = 0;
    const worker = async () => {
      while (next < friends.length) {
        const friend = friends[next++]!;
        results.push(await checkFriendStatus(friend));
      }
    };
    await Promise.all(Array.from({ length: Math.min(friends.length, serverConfig.friendStatusConcurrency) }, worker));
    cached = { key, expiresAt: Date.now() + serverConfig.friendStatusCacheSeconds * 1000, results };
  })();
  try { await pending; }
  finally { pending = undefined; }
  return getFriendStatuses();
}

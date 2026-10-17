import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), listFriends: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('../src/lib/friends', () => ({ listFriends: mocks.listFriends }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockReset();
  mocks.listFriends.mockReset().mockReturnValue([{ id: 1, url: 'https://example.com/' }]);
});

function respond(statusCode: number, location?: string) {
  return (_url: URL, _options: unknown, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = vi.fn();
    request.end = () => queueMicrotask(() => callback({ statusCode, headers: { location }, destroy: vi.fn() }));
    return request;
  };
}

describe('friend connectivity', () => {
  it('blocks loopback, private, reserved and mapped addresses', async () => {
    const { isPublicFriendAddress } = await import('../src/lib/friend-status');
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1', '2001::1']) {
      expect(isPublicFriendAddress(address), address).toBe(false);
    }
    expect(isPublicFriendAddress('1.1.1.1')).toBe(true);
    expect(isPublicFriendAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects unsafe destinations before sending any HTTP request', async () => {
    const { checkFriendStatus } = await import('../src/lib/friend-status');
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'https://example.com:8443/', 'file:///etc/passwd', 'https://user:password@example.com/']) {
      expect((await checkFriendStatus({ id: 1, url })).status).toBe('blocked');
    }
    mocks.lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }]);
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('blocked');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('pins the validated DNS address and classifies successful, slow and restricted responses', async () => {
    const { checkFriendStatus } = await import('../src/lib/friend-status');
    mocks.request.mockImplementation(respond(200));
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('online');
    const options = mocks.request.mock.calls[0]![1];
    const callback = vi.fn();
    options.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options).toMatchObject({ family: 4, agent: false, method: 'GET' });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2000);
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('slow');
    mocks.request.mockImplementation(respond(403));
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('restricted');
    mocks.request.mockImplementation(respond(503));
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('offline');
  });

  it('revalidates redirects and never follows one into the local network', async () => {
    const { checkFriendStatus } = await import('../src/lib/friend-status');
    mocks.request.mockImplementation(respond(302, 'http://169.254.169.254/'));
    expect((await checkFriendStatus({ id: 1, url: 'https://example.com/' })).status).toBe('blocked');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('ends a stalled DNS lookup when the overall deadline expires', async () => {
    const { checkFriendStatus } = await import('../src/lib/friend-status');
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    mocks.lookup.mockImplementation(() => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    });
    expect(await checkFriendStatus({ id: 1, url: 'https://example.com/' })).toMatchObject({ status: 'offline', latencyMilliseconds: null });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('shares in-flight checks, caches results, and invalidates on public link changes', async () => {
    const { getFriendStatuses } = await import('../src/lib/friend-status');
    mocks.request.mockImplementation(respond(200));
    const [first, second] = await Promise.all([getFriendStatuses(), getFriendStatuses()]);
    expect(first).toEqual(second);
    await getFriendStatuses();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const current = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(current + 301000);
    await getFriendStatuses();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    mocks.listFriends.mockReturnValue([{ id: 1, url: 'https://other.example.com/' }]);
    await getFriendStatuses();
    expect(mocks.request).toHaveBeenCalledTimes(3);
    mocks.listFriends.mockReturnValue([]);
    expect(await getFriendStatuses()).toEqual([]);
  });

  it('caps concurrent outbound connections for a longer friend list', async () => {
    const { getFriendStatuses } = await import('../src/lib/friend-status');
    const { serverConfig } = await import('../src/config/server');
    mocks.listFriends.mockReturnValue(Array.from({ length: 8 }, (_, index) => ({ id: index + 1, url: `https://site${index}.example.com/` })));
    let active = 0;
    let maximum = 0;
    mocks.request.mockImplementation((_url, _options, callback) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      request.destroy = vi.fn();
      request.end = () => {
        maximum = Math.max(maximum, ++active);
        setTimeout(() => {
          active--;
          callback({ statusCode: 200, headers: {}, destroy: vi.fn() });
        }, 1);
      };
      return request;
    });
    expect(await getFriendStatuses()).toHaveLength(8);
    expect(maximum).toBeLessThanOrEqual(serverConfig.friendStatusConcurrency);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';
import { requestJson, RequestTimeoutError } from '../src/lib/client-request';

const failureMessage = '保存失败，请稍后重试';
const address = '/api/admin/articles.json';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('client JSON requests', () => {
  it('lets the browser add multipart boundaries without encoding the file as JSON', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(Response.json({ media: { id: 1 } }));
    vi.stubGlobal('fetch', fetchRequest);
    const payload = new FormData(); payload.set('file', new File(['image'], 'sample.png'));
    await requestJson('/api/admin/media.json', 'POST', payload, failureMessage);
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith('/api/admin/media.json', {
      method: 'POST', headers: undefined, body: payload, signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends the original payload once and clears the deadline after success', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(Response.json({ id: 7 }));
    vi.stubGlobal('fetch', fetchRequest);
    const payload = { title: '保留的输入', content: '文章正文' };
    expect(await requestJson(address, 'POST', payload, failureMessage)).toEqual({ id: 7 });
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith(address, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: expect.any(AbortSignal),
    });
    const signal = fetchRequest.mock.calls[0][1].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(siteConfig.interactions.requestTimeoutMilliseconds * 2);
    expect(signal.aborted).toBe(false);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({ title: '保留的输入', content: '文章正文' });
  });

  it.each([
    { body: { error: '题目不能为空', message: '不应优先显示' }, expected: '题目不能为空' },
    { body: { message: '需要重新登录' }, expected: '需要重新登录' },
    { body: {}, expected: failureMessage },
  ])('preserves the server error or fallback without retrying: $expected', async ({ body, expected }) => {
    const fetchRequest = vi.fn().mockResolvedValue(Response.json(body, { status: 400 }));
    vi.stubGlobal('fetch', fetchRequest);
    await expect(requestJson(address, 'PATCH', { id: 7 }, failureMessage)).rejects.toThrow(expected);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(siteConfig.interactions.requestTimeoutMilliseconds * 2);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-JSON response with the provided message and clears its deadline', async () => {
    const response = new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
    const readJson = vi.spyOn(response, 'json');
    const fetchRequest = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchRequest);
    await expect(requestJson(address, 'POST', {}, failureMessage)).rejects.toThrow(failureMessage);
    expect(readJson).not.toHaveBeenCalled();
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline when JSON parsing fails', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchRequest);
    await expect(requestJson(address, 'GET', undefined, failureMessage)).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchRequest.mock.calls[0][1].body).toBeUndefined();
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a network failure and clears its deadline', async () => {
    const error = new TypeError('Network unavailable');
    const fetchRequest = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetchRequest);
    await expect(requestJson(address, 'POST', {}, failureMessage)).rejects.toBe(error);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'response.json'])('aborts at the configured 15 second deadline when %s never completes', async (stage) => {
    expect(siteConfig.interactions.requestTimeoutMilliseconds).toBe(15_000);
    let signal: AbortSignal | undefined;
    const readJson = vi.fn().mockImplementation(() => new Promise(() => {}));
    const fetchRequest = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      if (stage === 'fetch') return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      const response = Response.json({});
      response.json = readJson;
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchRequest);
    let settled = false;
    const outcome = requestJson(address, 'POST', { title: '待核对的输入' }, failureMessage).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(siteConfig.interactions.requestTimeoutMilliseconds - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(readJson).toHaveBeenCalledTimes(stage === 'response.json' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toContain('结果尚未确认');
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(siteConfig.interactions.requestTimeoutMilliseconds * 2);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });
});

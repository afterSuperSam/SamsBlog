import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';
import { acceptsOAuthCompletion, openReaderOAuthPopup } from '../src/lib/reader-oauth-popup';
import type { requestJson } from '../src/lib/client-request';

interface SessionResponse { error?: string; reader: { id: number } | null; authenticatedAt: number | null }
interface StartResponse { error?: string; url: string }
const request = vi.hoisted(() => vi.fn<(...parameters: Parameters<typeof requestJson>) => Promise<SessionResponse | StartResponse>>());
vi.mock('../src/lib/client-request', () => ({ requestJson: request }));
let popup: Window;
let host: EventTarget & { open: ReturnType<typeof vi.fn>; location: { origin: string } };
beforeEach(() => {
  vi.useFakeTimers(); request.mockReset();
  popup = { close: vi.fn(), location: { href: '' } } as unknown as Window;
  host = Object.assign(new EventTarget(), { open: vi.fn(() => popup), location: { origin: 'https://blog.example.com' }, screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 900 });
  vi.stubGlobal('window', host); vi.stubGlobal('screen', { availWidth: 1200, availHeight: 900 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reader OAuth popup', () => {
  it('accepts completion hints only from the exact popup and same origin', () => {
    const event = { origin: host.location.origin, source: popup, data: { type: 'samsblog-reader-oauth', status: 'success' } };
    expect(acceptsOAuthCompletion(event, popup, host.location.origin)).toBe(true);
    expect(acceptsOAuthCompletion({ ...event, origin: 'https://elsewhere.example' }, popup, host.location.origin)).toBe(false);
    expect(acceptsOAuthCompletion({ ...event, source: null }, popup, host.location.origin)).toBe(false);
    expect(acceptsOAuthCompletion({ ...event, data: { type: 'samsblog-reader-oauth', status: 'login' } }, popup, host.location.origin)).toBe(false);
  });
  it('opens synchronously and does not submit when the browser blocks popups', async () => {
    host.open.mockReturnValue(null);
    const result = openReaderOAuthPopup('/start', new AbortController().signal);
    expect(host.open).toHaveBeenCalledOnce();
    await expect(result).rejects.toThrow('阻止'); expect(request).not.toHaveBeenCalled();
  });
  it('keeps cancellation pending until the cookie-setting start request settles', async () => {
    let completeStart!: (value: StartResponse) => void;
    request.mockResolvedValueOnce({ reader: null, authenticatedAt: null });
    request.mockImplementationOnce(() => new Promise<StartResponse>((resolve) => { completeStart = resolve; }));
    const controller = new AbortController();
    const result = openReaderOAuthPopup('/start', controller.signal);
    let settled = false; const rejection = result.catch((error: Error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2); controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.close).toHaveBeenCalled(); expect(settled).toBe(false);
    completeStart({ url: 'https://provider.example/authorize' });
    await expect(rejection).resolves.toHaveProperty('message', expect.stringContaining('取消'));
    expect(popup.location.href).toBe(''); expect(vi.getTimerCount()).toBe(0);
  });
  it('confirms changed authentication through the private session endpoint despite no opener messages', async () => {
    request.mockResolvedValueOnce({ reader: { id: 1 }, authenticatedAt: 10 });
    request.mockResolvedValueOnce({ url: 'https://provider.example/authorize' });
    request.mockResolvedValueOnce({ reader: { id: 1 }, authenticatedAt: 10 });
    request.mockResolvedValueOnce({ reader: { id: 1 }, authenticatedAt: 11 });
    const result = openReaderOAuthPopup('/start', new AbortController().signal);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.pollMilliseconds);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.pollMilliseconds);
    await result; expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps an unchanged session unconfirmed until its bounded deadline', async () => {
    request.mockResolvedValueOnce({ reader: { id: 1 }, authenticatedAt: 10 });
    request.mockResolvedValueOnce({ url: 'https://provider.example/authorize' });
    request.mockResolvedValue({ reader: { id: 1 }, authenticatedAt: 10 });
    const rejection = openReaderOAuthPopup('/start', new AbortController().signal).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.timeoutMilliseconds);
    await expect(rejection).resolves.toHaveProperty('message', expect.stringContaining('尚未确认'));
    expect(vi.getTimerCount()).toBe(0);
  });
});

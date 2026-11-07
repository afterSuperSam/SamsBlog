import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteConfig } from '../src/config/site';
import { acceptsOAuthCompletion, openReaderOAuthPopup } from '../src/lib/reader-oauth-popup';
import type { requestJson } from '../src/lib/client-request';

interface FlowResponse { error?: string; status: string }
interface StartResponse { error?: string; url: string; flowId: string }
const request = vi.hoisted(() => vi.fn<(...parameters: Parameters<typeof requestJson>) => Promise<FlowResponse | StartResponse>>());
vi.mock('../src/lib/client-request', () => ({ requestJson: request }));
let popup: Window;
let host: EventTarget & { open: ReturnType<typeof vi.fn>; location: { origin: string } };
let currentFlow = '';
beforeEach(() => {
  vi.useFakeTimers(); request.mockReset(); currentFlow = '';
  popup = { close: vi.fn(), closed: false, location: { href: '' } } as unknown as Window;
  host = Object.assign(new EventTarget(), { open: vi.fn(() => popup), location: { origin: 'https://blog.example.com' }, screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 900 });
  vi.stubGlobal('window', host); vi.stubGlobal('screen', { availWidth: 1200, availHeight: 900 });
  request.mockImplementation(async (_url, method, body) => {
    if (method === 'POST') { currentFlow = (body as { flowId: string }).flowId; return { url: 'https://provider.example/authorize', flowId: currentFlow }; }
    return { status: method === 'DELETE' ? 'cancelled' : 'pending' };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reader OAuth popup', () => {
  it('accepts only the exact popup, origin and flow identifier', () => {
    const event = { origin: host.location.origin, source: popup, data: { type: 'samsblog-reader-oauth', status: 'success', flowId: 'current-flow' } };
    expect(acceptsOAuthCompletion(event, popup, host.location.origin, 'current-flow')).toBe(true);
    expect(acceptsOAuthCompletion({ ...event, origin: 'https://elsewhere.example' }, popup, host.location.origin, 'current-flow')).toBe(false);
    expect(acceptsOAuthCompletion({ ...event, source: null }, popup, host.location.origin, 'current-flow')).toBe(false);
    expect(acceptsOAuthCompletion(event, popup, host.location.origin, 'other-flow')).toBe(false);
    expect(acceptsOAuthCompletion(event, popup, host.location.origin)).toBe(false);
  });
  it('opens synchronously and does not submit when the browser blocks popups', async () => {
    host.open.mockReturnValue(null);
    const result = openReaderOAuthPopup('/start', new AbortController().signal);
    expect(host.open).toHaveBeenCalledOnce(); await expect(result).rejects.toThrow('阻止'); expect(request).not.toHaveBeenCalled();
  });
  it('waits for the cookie-setting start before invalidating a cancelled flow', async () => {
    let completeStart!: (value: StartResponse) => void;
    request.mockImplementationOnce((_url, _method, body) => { currentFlow = (body as { flowId: string }).flowId; return new Promise<StartResponse>((resolve) => { completeStart = resolve; }); });
    const controller = new AbortController(); const result = openReaderOAuthPopup('/start', controller.signal);
    let settled = false; const rejection = result.catch((error: Error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(0); expect(request).toHaveBeenCalledTimes(1); controller.abort();
    await vi.advanceTimersByTimeAsync(0); expect(popup.close).toHaveBeenCalled(); expect(settled).toBe(false);
    completeStart({ url: 'https://provider.example/authorize', flowId: currentFlow });
    await expect(rejection).resolves.toHaveProperty('message', expect.stringContaining('取消'));
    expect(request).toHaveBeenLastCalledWith('/api/reader/oauth/flow.json', 'DELETE', { flowId: currentFlow }, expect.any(String));
    expect(popup.location.href).toBe(''); expect(vi.getTimerCount()).toBe(0);
  });
  it('polls only this flow and confirms it without an opener message', async () => {
    const result = openReaderOAuthPopup('/start', new AbortController().signal);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.pollMilliseconds); expect(settled).toBe(false);
    request.mockResolvedValueOnce({ status: 'completed' });
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.pollMilliseconds); await result;
    expect(request.mock.calls.filter((call) => call[1] === 'GET').every((call) => call[0] === `/api/reader/oauth/flow.json?flow=${currentFlow}`)).toBe(true);
    expect(request.mock.calls.some((call) => call[0].includes('session.json'))).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('invalidates an unconfirmed flow at the bounded deadline', async () => {
    const rejection = openReaderOAuthPopup('/start', new AbortController().signal).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.timeoutMilliseconds);
    await expect(rejection).resolves.toHaveProperty('message', expect.stringContaining('尚未确认'));
    expect(request).toHaveBeenLastCalledWith('/api/reader/oauth/flow.json', 'DELETE', { flowId: currentFlow }, expect.any(String)); expect(vi.getTimerCount()).toBe(0);
  });
  it('recognizes completion that won the race against cancellation', async () => {
    const controller = new AbortController(); const result = openReaderOAuthPopup('/start', controller.signal);
    await vi.advanceTimersByTimeAsync(0); request.mockResolvedValueOnce({ status: 'completed' }); controller.abort(); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('treats a closed window as cancellation after checking the exact flow', async () => {
    const rejection = openReaderOAuthPopup('/start', new AbortController().signal).catch((error: Error) => error);
    Object.assign(popup, { closed: true }); await vi.advanceTimersByTimeAsync(siteConfig.readerPopup.pollMilliseconds);
    await expect(rejection).resolves.toHaveProperty('message', expect.stringContaining('关闭'));
    expect(request).toHaveBeenLastCalledWith('/api/reader/oauth/flow.json', 'DELETE', { flowId: currentFlow }, expect.any(String));
  });
});

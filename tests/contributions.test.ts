import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverConfig } from '../src/config/server';

const contributionResponse = (count: number) => ({
  ok: true,
  status: 200,
  text: async () => Array.from({ length: 300 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return `<td data-level="2" data-date="${date}"></td><tool-tip>${count} contributions on ${date}.</tool-tip>`;
  }).join(''),
} as Response);

const settleRefresh = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GitHub contribution cache', () => {
  it('preserves thousands separators in daily counts', async () => {
    const { parseGithubContributions } = await import('../src/lib/contributions');
    const html = (await contributionResponse(1234).text()).replaceAll('1234 contributions', '1,234 contributions');
    const result = parseGithubContributions(html);
    expect(result.days[0].count).toBe(1234);
    expect(result.total).toBe(370200);
  });

  it('shares the first request while no snapshot exists', async () => {
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const { getGithubContributions } = await import('../src/lib/contributions');
    const first = getGithubContributions();
    const second = getGithubContributions();
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    complete(contributionResponse(2));
    expect(await first).toMatchObject({ available: true, total: 600 });
    expect(await getGithubContributions()).toBe(await first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns an expired snapshot immediately and replaces it after one background refresh', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(contributionResponse(2));
    const { getGithubContributions } = await import('../src/lib/contributions');
    const previous = await getGithubContributions();
    vi.setSystemTime(Date.now() + serverConfig.githubCacheSeconds * 1000 + 1);
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    expect(await getGithubContributions()).toBe(previous);
    expect(await getGithubContributions()).toBe(previous);
    expect(fetch).toHaveBeenCalledTimes(2);
    complete(contributionResponse(3));
    await settleRefresh();
    expect(await getGithubContributions()).toMatchObject({ available: true, total: 900 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last valid snapshot after failure and respects the retry window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValueOnce(contributionResponse(2));
    const { getGithubContributions } = await import('../src/lib/contributions');
    const previous = await getGithubContributions();
    vi.setSystemTime(Date.now() + serverConfig.githubCacheSeconds * 1000 + 1);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network unavailable'));
    expect(await getGithubContributions()).toBe(previous);
    await settleRefresh();
    vi.setSystemTime(Date.now() + serverConfig.githubRetrySeconds * 1000 - 1);
    expect(await getGithubContributions()).toBe(previous);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 2);
    vi.mocked(fetch).mockResolvedValueOnce(contributionResponse(4));
    expect(await getGithubContributions()).toBe(previous);
    await settleRefresh();
    expect(await getGithubContributions()).toMatchObject({ available: true, total: 1200 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('marks a failed first load as unavailable rather than recorded zero activity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network unavailable'));
    const { getGithubContributions } = await import('../src/lib/contributions');
    expect(await getGithubContributions()).toMatchObject({ available: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

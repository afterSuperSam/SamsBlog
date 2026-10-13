import { serverConfig } from '../config/server';

export interface ContributionDay {
  date: string;
  count: number;
  level: number;
  usage?: TokenUsage;
}

export interface TokenUsage {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

export interface ContributionCalendar {
  days: ContributionDay[];
  total: number;
  available: boolean;
}

export function buildTokenUsageCalendar(counts: Map<string, TokenUsage>): ContributionCalendar {
  const dates = [...counts.keys()].sort();
  const end = dates.length > 0 ? new Date(`${dates.at(-1)}T00:00:00Z`) : new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 52 * 7 - end.getUTCDay());
  const totalFor = (usage: TokenUsage) => usage.cacheHit + usage.cacheMiss + usage.output;
  const maximum = Math.max(...[...counts.values()].map(totalFor), 1);
  const days: ContributionDay[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor);
    const usage = counts.get(date);
    const count = usage ? totalFor(usage) : 0;
    const ratio = count / maximum;
    const level = count === 0 ? 0 : ratio > .75 ? 4 : ratio > .5 ? 3 : ratio > .22 ? 2 : 1;
    days.push({ date, count, level, usage });
  }
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), available: dates.length > 0 };
}

let pendingGithubRequest: Promise<ContributionCalendar> | undefined;
let githubCache: { expiresAt: number; value: ContributionCalendar } | undefined;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const levelForCount = (count: number) => count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;

export function buildContributionCalendar(counts: Map<string, number>, now = new Date()): ContributionCalendar {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 52 * 7);
  const days: ContributionDay[] = [];
  for (const cursor = new Date(start); cursor <= today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor);
    const count = counts.get(date) || 0;
    days.push({ date, count, level: levelForCount(count) });
  }
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), available: true };
}

export function parseGithubContributions(html: string): ContributionCalendar {
  const days: ContributionDay[] = [];
  const cellPattern = /<td\b([^>]*)><\/td>\s*<tool-tip\b[^>]*>([^<]*)<\/tool-tip>/gi;
  for (const match of html.matchAll(cellPattern)) {
    const date = match[1].match(/\bdata-date\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/i)?.[1];
    const level = match[1].match(/\bdata-level\s*=\s*["']([0-4])["']/i)?.[1];
    if (!date || level === undefined) continue;
    const countMatch = match[2].match(/(\d+) contributions?/i);
    days.push({ date, level: Number(level), count: countMatch ? Number(countMatch[1]) : 0 });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 300) throw new Error('GitHub contribution response was incomplete');
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), available: true };
}

// 共用正在进行的请求，失败后短暂缓存降级结果
export function getGithubContributions(): Promise<ContributionCalendar> {
  if (githubCache && githubCache.expiresAt > Date.now()) return Promise.resolve(githubCache.value);
  if (pendingGithubRequest) return pendingGithubRequest;
  pendingGithubRequest = fetchGithubContributions().finally(() => { pendingGithubRequest = undefined; });
  return pendingGithubRequest;
}

async function fetchGithubContributions(): Promise<ContributionCalendar> {
  try {
    const response = await fetch(`https://github.com/users/${serverConfig.githubUsername}/contributions`, {
      headers: { Accept: 'text/html', 'User-Agent': 'SamsBlog/1.0' },
      signal: AbortSignal.timeout(serverConfig.githubTimeoutMilliseconds),
    });
    if (!response.ok) throw new Error(`GitHub responded with ${response.status}`);
    const value = parseGithubContributions(await response.text());
    githubCache = { expiresAt: Date.now() + serverConfig.githubCacheSeconds * 1000, value };
    return value;
  } catch (error) {
    console.error('GitHub contributions request failed', error);
    const fallback = buildContributionCalendar(new Map());
    fallback.available = false;
    const value = githubCache?.value || fallback;
    githubCache = { expiresAt: Date.now() + serverConfig.githubRetrySeconds * 1000, value };
    return value;
  }
}

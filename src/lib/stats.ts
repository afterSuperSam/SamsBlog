import { createHash } from 'node:crypto';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';

export function hashVisitorToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function recordPageView(visitorHash: string, viewedAt = new Date()) {
  const timestamp = viewedAt.toISOString();
  getDatabase().prepare(`INSERT INTO site_visitors (visitor_hash, first_seen, last_seen, page_views)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(visitor_hash) DO UPDATE SET
      last_seen = excluded.last_seen,
      page_views = site_visitors.page_views + 1`).run(visitorHash, timestamp, timestamp);
}

// 首页只汇总仍在使用的内容与匿名访问
export function getSiteStats(now = new Date()) {
  const database = getDatabase();
  const visitors = database.prepare('SELECT count(*) AS visitors, coalesce(sum(page_views),0) AS pageViews FROM site_visitors').get() as { visitors: number; pageViews: number };
  const friends = (database.prepare('SELECT count(*) AS count FROM friends WHERE visible = 1 AND deleted_at IS NULL').get() as { count: number }).count;
  // 运行天数按北京时间的自然日计算，建站当天为第 1 天
  const millisecondsPerDay = 86_400_000;
  const today = Math.floor((now.getTime() + 8 * 60 * 60 * 1000) / millisecondsPerDay);
  const launchDay = Date.parse(serverConfig.siteLaunchedAt) / millisecondsPerDay;
  const runtimeDays = Math.max(0, today - launchDay + 1);
  return { ...visitors, friends, runtimeDays };
}

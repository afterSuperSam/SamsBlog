import { createHash } from 'node:crypto';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';

export function hashVisitorToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function recordPageView(visitorHash: string, viewedAt = new Date(), articleId?: number) {
  const timestamp = viewedAt.toISOString();
  getDatabase().prepare(`INSERT INTO site_visitors (visitor_hash, first_seen, last_seen, page_views)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(visitor_hash) DO UPDATE SET
      last_seen = excluded.last_seen,
      page_views = site_visitors.page_views + 1`).run(visitorHash, timestamp, timestamp);
  if (articleId) getDatabase().prepare(`INSERT INTO article_daily_visitors(article_id, day, visitor_hash) VALUES (?, date(?, '+8 hours'), ?)
    ON CONFLICT(article_id,day,visitor_hash) DO UPDATE SET views = views + 1`).run(articleId, timestamp, visitorHash);
}

export function getArticleAnalytics(days = 30) {
  const database = getDatabase();
  const since = `-${days - 1} days`;
  const articles = database.prepare(`SELECT a.id,a.title,a.publication_status AS status, SUM(v.views) AS views, COUNT(DISTINCT v.visitor_hash) AS visitors
    FROM article_daily_visitors v JOIN blog_articles a ON a.id = v.article_id
    WHERE v.day >= date('now', '+8 hours', ?) AND a.deleted_at IS NULL
    GROUP BY a.id ORDER BY views DESC, a.id DESC`).all(since) as Array<{ id: number; title: string; status: string; views: number; visitors: number }>;
  const daysData = database.prepare(`SELECT v.day, SUM(v.views) AS views, COUNT(DISTINCT v.visitor_hash) AS visitors FROM article_daily_visitors v JOIN blog_articles a ON a.id=v.article_id
    WHERE v.day >= date('now', '+8 hours', ?) AND a.deleted_at IS NULL GROUP BY v.day ORDER BY v.day`).all(since) as Array<{ day: string; views: number; visitors: number }>;
  const totals = database.prepare(`SELECT COALESCE(SUM(v.views),0) AS views, COUNT(DISTINCT v.visitor_hash) AS visitors FROM article_daily_visitors v JOIN blog_articles a ON a.id=v.article_id WHERE v.day >= date('now', '+8 hours', ?) AND a.deleted_at IS NULL`).get(since) as { views: number; visitors: number };
  const today = Date.parse(new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0,10));
  const byDay = new Map(daysData.map((entry) => [entry.day, entry]));
  const completeDays = Array.from({ length: days }, (_, index) => { const day = new Date(today - (days - 1 - index) * 86400000).toISOString().slice(0,10); return byDay.get(day) || { day, views: 0, visitors: 0 }; });
  return { articles, days: completeDays, totals };
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

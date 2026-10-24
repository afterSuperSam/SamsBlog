import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../../lib/db';
import { getArticle } from '../../../lib/articles';
import { hashVisitorToken } from '../../../lib/stats';
import { HttpError, json, readJsonObject, readPositiveId, route } from '../../../lib/http';
import { serverConfig } from '../../../config/server';

function readReactions(articleId: number, visitor: string) {
  if (!getArticle(articleId)) throw new HttpError(404, '文章不存在');
  const database = getDatabase();
  const rows = database.prepare('SELECT reaction, count(*) AS count FROM article_reactions WHERE article_id=? GROUP BY reaction').all(articleId) as Array<{ reaction: string; count: number }>;
  const current = database.prepare('SELECT reaction FROM article_reactions WHERE article_id=? AND visitor_hash=?').get(articleId, visitor) as { reaction: string } | undefined;
  return { counts: Object.fromEntries(rows.map((row) => [row.reaction, row.count])), selected: current?.reaction || '' };
}

export const GET = route(({ cookies, url }) => json(readReactions(readPositiveId(Number(url.searchParams.get('articleId'))), hashVisitorToken(cookies.get('samsblog-visitor')?.value || ''))));

export const POST = route(async ({ request, cookies, url }) => {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, '请从本站文章页操作');
  const body = await readJsonObject(request);
  const articleId = readPositiveId(body.articleId);
  if (!getArticle(articleId)) throw new HttpError(404, '文章不存在');
  if (!['like','helpful','inspired',''].includes(String(body.reaction))) throw new HttpError(400, '表态选项不正确');
  let token = cookies.get('samsblog-visitor')?.value;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) token = randomUUID();
  cookies.set('samsblog-visitor', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 31536000 });
  const visitor = hashVisitorToken(token);
  const database = getDatabase();
  database.transaction(() => {
    const previous = database.prepare('SELECT updated_at FROM article_reactions WHERE article_id=? AND visitor_hash=?').get(articleId, visitor) as { updated_at: string } | undefined;
    if (previous && Date.now() - Date.parse(previous.updated_at) < serverConfig.reactionCooldownSeconds * 1000) throw new HttpError(429, '稍等一下，再试一次');
    if (!body.reaction) database.prepare('DELETE FROM article_reactions WHERE article_id=? AND visitor_hash=?').run(articleId, visitor);
    else database.prepare(`INSERT INTO article_reactions(article_id,visitor_hash,reaction,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(article_id,visitor_hash) DO UPDATE SET reaction=excluded.reaction,updated_at=excluded.updated_at`).run(articleId, visitor, body.reaction, new Date().toISOString());
  })();
  return json(readReactions(articleId, visitor));
});

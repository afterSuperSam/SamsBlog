import { readAdminSession } from '../../lib/admin-auth';
import { HttpError, json, readRequestBytes, requireSameOrigin, route } from '../../lib/http';
import { getSiteStats, hashVisitorToken, humanPageRequest, publicPagePath, recordConfirmedPageView, validVisitorToken, visitorCookie } from '../../lib/stats';

export const POST = route(async ({ request, cookies }) => {
  requireSameOrigin(request);
  const token = cookies.get(visitorCookie)?.value;
  if (!validVisitorToken(token) || !humanPageRequest(request) || readAdminSession(cookies)) return json({ counted: false });
  if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') throw new HttpError(415, '请求格式不正确');
  let body: unknown;
  try { body = JSON.parse((await readRequestBytes(request, 512)).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new HttpError(400, '请求内容无法解析'); throw error; }
  const path = body && typeof body === 'object' && 'path' in body && typeof body.path === 'string' ? publicPagePath(body.path) : null;
  if (!path) throw new HttpError(400, '页面地址不正确');
  const counted = recordConfirmedPageView(hashVisitorToken(token), path);
  if (path !== '/') return json({ counted });
  const { visitors, pageViews } = getSiteStats();
  return json({ counted, totals: { visitors, pageViews } });
});

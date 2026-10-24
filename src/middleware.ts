import { randomUUID } from 'node:crypto';
import { defineMiddleware } from 'astro:middleware';
import { hashVisitorToken, recordPageView } from './lib/stats';
import { scheduleReplyNotifications } from './lib/reply-notifications';

const visitorCookie = 'samsblog-visitor';
const botPattern = /bot|crawler|spider|slurp|preview|monitor|uptime/i;
let notificationWorkerStarted = false;

export const onRequest = defineMiddleware(async ({ cookies, request, url }, next) => {
  const response = await next();
  if (!notificationWorkerStarted) { notificationWorkerStarted = true; scheduleReplyNotifications(); }
  const acceptsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  const documentRequest = !request.headers.get('sec-fetch-dest') || request.headers.get('sec-fetch-dest') === 'document';
  const publicPage = !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/admin');
  const humanAgent = !botPattern.test(request.headers.get('user-agent') || '');

  const htmlResponse = response.headers.get('content-type')?.includes('text/html') ?? false;
  if (response.ok && htmlResponse && request.method === 'GET' && acceptsHtml && documentRequest && publicPage && humanAgent) {
    let token = cookies.get(visitorCookie)?.value;
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) token = randomUUID();
    cookies.set(visitorCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    // 匿名统计降级不影响已生成的公开页面，日志只记录错误分类。
    try {
      const article = url.pathname.match(/^\/articles\/([1-9]\d*)\/?$/);
      recordPageView(hashVisitorToken(token), new Date(), article ? Number(article[1]) : undefined);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
      if (/^SQLITE_(?:BUSY|LOCKED|FULL|IOERR|READONLY|CANTOPEN|CORRUPT|NOTADB)(?:_|$)/.test(code)) {
        console.warn('Page view statistics storage unavailable', { code });
      } else {
        console.error('Page view statistics failed unexpectedly', { errorType: error instanceof Error ? error.name : typeof error });
      }
    }
  }

  return response;
});

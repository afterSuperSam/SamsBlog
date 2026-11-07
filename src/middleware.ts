import { randomUUID } from 'node:crypto';
import { defineMiddleware } from 'astro:middleware';
import { humanPageRequest, publicPagePath, validVisitorToken, visitorCookie } from './lib/stats';
import { readAdminSession } from './lib/admin-auth';
import { scheduleReplyNotifications } from './lib/reply-notifications';
import { siteConfig } from './config/site';
import { blogsClubCallback } from './lib/reader-oauth';
import { isMaintenanceMode, maintenanceResponse } from './lib/maintenance';

const securePublicSite = new URL(siteConfig.siteUrl).protocol === 'https:';
let notificationWorkerStarted = false;

export const onRequest = defineMiddleware(async ({ cookies, request, url }, next) => {
  if (isMaintenanceMode() && (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    || url.pathname.startsWith('/api/reader/oauth/') || url.pathname.startsWith('/api/auth/')
    || url.pathname === '/' && ['code', 'state', 'error'].some((name) => url.searchParams.has(name)))) return maintenanceResponse();
  if (request.method === 'GET' && url.pathname === '/' && ['code', 'state', 'error'].some((name) => url.searchParams.has(name))) {
    return blogsClubCallback({ cookies, url });
  }
  const response = await next();
  if (response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('Cache-Control', 'private, no-store');
    const vary = response.headers.get('Vary');
    if (!vary?.split(',').some((value) => value.trim().toLowerCase() === 'cookie')) response.headers.set('Vary', vary ? `${vary}, Cookie` : 'Cookie');
  }
  if (!isMaintenanceMode() && !notificationWorkerStarted) { notificationWorkerStarted = true; scheduleReplyNotifications(); }
  const documentRequest = !request.headers.get('sec-fetch-dest') || request.headers.get('sec-fetch-dest') === 'document';
  // HTML 请求只准备匿名身份，真实浏览由可见页面延时确认，不在这里累加。
  if (response.ok && response.headers.get('content-type')?.includes('text/html') && request.method === 'GET'
    && request.headers.get('accept')?.includes('text/html') && documentRequest && publicPagePath(url.pathname)
    && humanPageRequest(request) && !readAdminSession(cookies)) {
    const token = cookies.get(visitorCookie)?.value;
    if (!validVisitorToken(token)) cookies.set(visitorCookie, randomUUID(), {
      httpOnly: true, sameSite: 'lax', secure: securePublicSite || url.protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
});

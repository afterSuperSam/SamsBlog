import { randomUUID } from 'node:crypto';
import { defineMiddleware } from 'astro:middleware';
import { hashVisitorToken, recordPageView } from './lib/stats';

const visitorCookie = 'samsblog-visitor';
const botPattern = /bot|crawler|spider|slurp|preview|monitor|uptime/i;

export const onRequest = defineMiddleware(async ({ cookies, request, url }, next) => {
  const acceptsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  const documentRequest = !request.headers.get('sec-fetch-dest') || request.headers.get('sec-fetch-dest') === 'document';
  const publicPage = !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/admin');
  const humanAgent = !botPattern.test(request.headers.get('user-agent') || '');

  if (request.method === 'GET' && acceptsHtml && documentRequest && publicPage && humanAgent) {
    let token = cookies.get(visitorCookie)?.value;
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) token = randomUUID();
    cookies.set(visitorCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
    recordPageView(hashVisitorToken(token));
  }

  return next();
});

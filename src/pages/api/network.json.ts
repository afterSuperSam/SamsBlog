import type { APIRoute } from 'astro';
import { getClientIp, getVisitorLocation, maskIp } from '../../lib/network';

export const GET: APIRoute = ({ request, clientAddress, url }) => {
  const ip = getClientIp(request, clientAddress);
  return new Response(JSON.stringify({
    location: getVisitorLocation(request),
    maskedIp: maskIp(ip),
    domain: url.host,
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
    },
  });
};

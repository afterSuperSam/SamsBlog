import type { APIRoute } from 'astro';

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ status: 'online', time: new Date().toISOString() }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

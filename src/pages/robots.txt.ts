import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL('http://localhost:4321');
  return new Response(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/admin/\n\nSitemap: ${new URL('/sitemap.xml', base)}\n`,
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
};

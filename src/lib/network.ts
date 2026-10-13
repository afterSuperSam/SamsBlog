import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './http';

export function getClientIp(request: Request, fallback = '') {
  const proxyAddress = fallback;
  if (!isTrustedProxy(proxyAddress)) return isIP(proxyAddress) ? proxyAddress : 'unknown';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = request.headers.get('x-real-ip') || forwarded || fallback;
  return isIP(address) ? address : 'unknown';
}

function isTrustedProxy(address: string) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function maskIp(ip: string) {
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return `${groups.slice(0, 3).join(':')}:*:*`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  return '未知';
}

export function fingerprintIp(ip: string) {
  const secret = process.env.BLOG_SECRET;
  if ((import.meta.env.PROD || process.env.NODE_ENV === 'production') && (!secret || secret.length < 32)) {
    throw new HttpError(503, '服务尚未完成安全配置');
  }
  return createHmac('sha256', secret || 'development-only-change-me').update(ip).digest('hex');
}

export function getVisitorLocation(request: Request) {
  const city = decodeHeader(request.headers.get('x-geo-city'));
  const region = decodeHeader(request.headers.get('x-geo-region'));
  const country = decodeHeader(request.headers.get('x-geo-country'));
  return [country, region, city].filter(Boolean).join(' · ') || '位置未知';
}

function decodeHeader(value: string | null) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

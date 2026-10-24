import { createFriendApplication, parseFriendInput } from '../../../lib/friends';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { parseNotificationEmail } from '../../../lib/reply-notifications';
import { json, HttpError, readJsonObject, route } from '../../../lib/http';
import { isIP } from 'node:net';
import { isPublicFriendAddress } from '../../../lib/friend-status';

export const POST = route(async ({ request, clientAddress, url }) => {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, '请从本站提交申请');
  const body = await readJsonObject(request);
  if (body.website) return json({ ok: true });
  for (const name of ['url','iconUrl','rssUrl']) if (typeof body[name] !== 'string' || String(body[name]).length > 4096) throw new HttpError(400, '网址格式不正确或过长');
  const input = parseFriendInput({ ...body, id: undefined, visible: false, backgroundUrl: '' });
  for (const value of [input.url, input.iconUrl, input.rssUrl].filter(Boolean)) {
    const address = new URL(value);
    const host = address.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if ((address.port && !['80', '443'].includes(address.port)) || (isIP(host) ? !isPublicFriendAddress(host) : !host.includes('.') || /\.(?:localhost|local|internal|test|invalid)$/.test(host))) throw new HttpError(400, '友链需要使用公开站点地址');
  }
  createFriendApplication(input, parseNotificationEmail(body.email), fingerprintIp(getClientIp(request, clientAddress)));
  return json({ ok: true, message: '申请已送达，通过后会出现在网站友链中。' }, 201);
});

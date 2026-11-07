import { json, requirePublicActivityAllowance, requireSameOrigin, route } from '../../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../../lib/network';
import { startReaderOAuth } from '../../../../lib/reader-oauth';

export const POST = route(({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  return json({ url: startReaderOAuth('github', cookies, source) });
});

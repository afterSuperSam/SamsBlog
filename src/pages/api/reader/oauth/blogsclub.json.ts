import { json, requirePublicActivityAllowance, requireSameOrigin, route } from '../../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../../lib/network';
import { readReaderJson } from '../../../../lib/readers';
import { startReaderOAuthFlow } from '../../../../lib/reader-oauth';

export const POST = route(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  return json(startReaderOAuthFlow('blogsclub', cookies, source, await readReaderJson(request)));
});

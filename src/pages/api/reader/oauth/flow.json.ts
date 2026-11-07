import { json, requirePublicActivityAllowance, requireSameOrigin } from '../../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../../lib/network';
import { readerAccountRoute } from '../../../../lib/reader-account';
import { cancelReaderOAuthFlow, readReaderOAuthFlow } from '../../../../lib/reader-oauth';
import { readReaderJson } from '../../../../lib/readers';

export const GET = readerAccountRoute(({ cookies, url }) => json(readReaderOAuthFlow(cookies, url.searchParams.get('flow'))));

export const DELETE = readerAccountRoute(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  requirePublicActivityAllowance(fingerprintIp(getClientIp(request, clientAddress)));
  return json(cancelReaderOAuthFlow(cookies, (await readReaderJson(request)).flowId));
});

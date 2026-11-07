import { json, requirePublicActivityAllowance, requireSameOrigin } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { readerAccountRoute } from '../../../lib/reader-account';
import { cancelReaderIdentityLink, createReaderIdentityLink, readReaderJson } from '../../../lib/readers';

export const POST = readerAccountRoute(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  const body = await readReaderJson(request);
  return json({ bindingToken: createReaderIdentityLink(cookies, body.provider, source) });
});

export const DELETE = readerAccountRoute(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  requirePublicActivityAllowance(fingerprintIp(getClientIp(request, clientAddress)));
  cancelReaderIdentityLink(cookies, (await readReaderJson(request)).bindingToken);
  return json({ ok: true });
});

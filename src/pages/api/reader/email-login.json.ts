import { json, requirePublicActivityAllowance, requireSameOrigin, route } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { readReaderEmail, verifyReaderEmailCode } from '../../../lib/reader-email';
import { readReaderJson } from '../../../lib/readers';

export const POST = route(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  const body = await readReaderJson(request);
  return json({ reader: verifyReaderEmailCode(readReaderEmail(body.email), body.code, source, cookies) });
});

import { readerConfig } from '../../../config/readers';
import { json, requirePublicActivityAllowance, requireSameOrigin, route } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { readReaderEmail, sendReaderEmailCode } from '../../../lib/reader-email';
import { readReaderJson } from '../../../lib/readers';

export const POST = route(async ({ request, clientAddress, cookies }) => {
  requireSameOrigin(request);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  const body = await readReaderJson(request);
  await sendReaderEmailCode(readReaderEmail(body.email), source, body.bindingToken === undefined ? undefined : { cookies, token: body.bindingToken });
  return json({ ok: true, message: '如果邮箱可接收邮件，验证码将发送到你的邮箱。请检查收件箱及垃圾邮件。',
    expiresIn: readerConfig.codeSeconds, cooldownSeconds: readerConfig.emailCooldownSeconds });
});

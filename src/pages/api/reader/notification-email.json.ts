import { fingerprintIp, getClientIp } from '../../../lib/network';
import { HttpError, json, requirePublicActivityAllowance, requireSameOrigin, route } from '../../../lib/http';
import { readReaderSession } from '../../../lib/readers';
import { requestReaderNotificationVerification } from '../../../lib/reply-notifications';

export const POST = route(({ request, clientAddress, cookies }) => {
  requireSameOrigin(request);
  requirePublicActivityAllowance(fingerprintIp(getClientIp(request, clientAddress)));
  const reader = readReaderSession(cookies);
  if (!reader) throw new HttpError(401, '请先登录读者身份');
  const queued = requestReaderNotificationVerification(reader.id);
  return json({ ok: true, message: queued ? '验证邮件已排队，请打开邮件并确认。' : '如邮箱尚未验证，请稍后查看收件箱或再试。' });
});

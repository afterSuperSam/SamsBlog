import { adminCookie, allowLoginAttempt, createAdminSession, hasValidAdminSecret, verifyAdminPassword } from '../../../lib/admin-auth';
import { HttpError, json, readJsonObject, requireSameOrigin, route } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { recordAdminAudit } from '../../../lib/admin-audit';

export const POST = route(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  if (!hasValidAdminSecret()) return json({ ok: false, message: '管理服务尚未完成安全配置' }, 503);
  if (!allowLoginAttempt(fingerprintIp(getClientIp(request, clientAddress)))) throw new HttpError(429, '尝试次数过多，请稍后再试');
  const body = await readJsonObject(request);
  if (typeof body.password !== 'string') throw new HttpError(400, '请输入密码');
  if (!await verifyAdminPassword(body.password)) return json({ ok: false, message: '密码不正确，或尚未配置管理员密码' }, 401);
  cookies.delete(adminCookie.legacyName, { path: '/' });
  cookies.set(adminCookie.name, createAdminSession(), adminCookie.options);
  recordAdminAudit({ objectType: 'session', objectId: null, operation: 'login' }, 'success');
  return json({ ok: true, message: '登录成功' });
});

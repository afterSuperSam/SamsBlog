import { adminCookie, allowLoginAttempt, createAdminSession, hasValidAdminSecret, verifyAdminPassword } from '../../../lib/admin-auth';
import { HttpError, json, readJsonObject, route } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';

export const POST = route(async ({ request, cookies, clientAddress }) => {
  if (!hasValidAdminSecret()) return json({ ok: false, message: '管理服务尚未完成安全配置' }, 503);
  const body = await readJsonObject(request);
  if (typeof body.password !== 'string') throw new HttpError(400, '请输入密码');
  if (!allowLoginAttempt(fingerprintIp(getClientIp(request, clientAddress)))) throw new HttpError(429, '尝试次数过多，请稍后再试');
  if (!await verifyAdminPassword(body.password)) return json({ ok: false, message: '密码不正确，或尚未配置管理员密码' }, 401);
  cookies.set(adminCookie.name, createAdminSession(), adminCookie.options);
  return json({ ok: true, message: '登录成功' });
});

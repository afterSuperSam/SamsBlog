import { adminCookie } from '../../../lib/admin-auth';
import { adminRoute, json } from '../../../lib/http';
import { recordAdminAudit } from '../../../lib/admin-audit';

export const POST = adminRoute(({ cookies }) => {
  cookies.delete(adminCookie.name, { path: '/', secure: adminCookie.options.secure, httpOnly: true, sameSite: 'strict' });
  if (adminCookie.name !== adminCookie.legacyName) cookies.delete(adminCookie.legacyName, { path: '/' });
  recordAdminAudit({ objectType: 'session', objectId: null, operation: 'logout' }, 'success');
  return json({ ok: true });
});

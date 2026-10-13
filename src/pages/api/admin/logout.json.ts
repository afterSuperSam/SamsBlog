import { adminCookie } from '../../../lib/admin-auth';
import { adminRoute, json } from '../../../lib/http';

export const POST = adminRoute(({ cookies }) => {
  cookies.delete(adminCookie.name, { path: '/' });
  return json({ ok: true });
});

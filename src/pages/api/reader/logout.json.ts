import { json, requireSameOrigin, route } from '../../../lib/http';
import { endReaderSession } from '../../../lib/readers';

export const POST = route(({ request, cookies }) => {
  requireSameOrigin(request);
  endReaderSession(cookies);
  return json({ ok: true });
});

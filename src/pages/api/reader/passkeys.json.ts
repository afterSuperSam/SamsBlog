import { HttpError, json, route } from '../../../lib/http';
import { deleteReaderPasskey, readerPasskeyRoute } from '../../../lib/reader-passkeys';
import { listReaderPasskeys, readReaderSession } from '../../../lib/readers';

export const GET = route(({ cookies }) => {
  const reader = readReaderSession(cookies);
  if (!reader) throw new HttpError(401, '请先登录读者账号');
  return json({ passkeys: listReaderPasskeys(reader.id) });
});
export const DELETE = readerPasskeyRoute(({ cookies }, body) => json({ ok: true, passkeys: deleteReaderPasskey(cookies, body.id) }));

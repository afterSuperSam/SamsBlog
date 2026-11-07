import { json } from '../../../../lib/http';
import { readerPasskeyRoute, verifyPasskeyRegistration } from '../../../../lib/reader-passkeys';

export const POST = readerPasskeyRoute(async ({ cookies }, body) => json({ ok: true, passkeys: await verifyPasskeyRegistration(cookies, body) }));

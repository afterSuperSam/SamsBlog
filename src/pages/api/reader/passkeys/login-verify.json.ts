import { json } from '../../../../lib/http';
import { readerPasskeyRoute, verifyPasskeyLogin } from '../../../../lib/reader-passkeys';

export const POST = readerPasskeyRoute(async ({ cookies }, body) => json({ reader: await verifyPasskeyLogin(cookies, body) }));

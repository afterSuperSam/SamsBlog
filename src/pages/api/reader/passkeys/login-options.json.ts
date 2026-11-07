import { json } from '../../../../lib/http';
import { createPasskeyLoginOptions, readerPasskeyRoute } from '../../../../lib/reader-passkeys';

export const POST = readerPasskeyRoute(async ({ cookies }, body) => json({ options: await createPasskeyLoginOptions(cookies, body.reauthenticate === true) }));

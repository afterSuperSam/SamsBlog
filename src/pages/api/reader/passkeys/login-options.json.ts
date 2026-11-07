import { json } from '../../../../lib/http';
import { createPasskeyLoginOptions, readerPasskeyRoute } from '../../../../lib/reader-passkeys';

export const POST = readerPasskeyRoute(async ({ cookies }) => json({ options: await createPasskeyLoginOptions(cookies) }));

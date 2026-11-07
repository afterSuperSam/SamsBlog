import { json } from '../../../../lib/http';
import { createPasskeyRegistrationOptions, readerPasskeyRoute } from '../../../../lib/reader-passkeys';

export const POST = readerPasskeyRoute(async ({ cookies }) => json({ options: await createPasskeyRegistrationOptions(cookies) }));

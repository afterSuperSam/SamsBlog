import { serverConfig } from '../../../config/server';
import { json, readRequestBytes, route } from '../../../lib/http';
import { processResendWebhook } from '../../../lib/reply-notifications';

export const POST = route(async ({ request }) => {
  const payload = await readRequestBytes(request, serverConfig.notificationWebhookMaximumBytes);
  processResendWebhook(payload, request.headers);
  return json({ ok: true });
});

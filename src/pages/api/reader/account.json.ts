import { readerConfig } from '../../../config/readers';
import { json, HttpError, requirePublicActivityAllowance, requireSameOrigin } from '../../../lib/http';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { getReaderAccount, readerAccountRoute, requireReaderAccount, updateReaderProfile } from '../../../lib/reader-account';
import { readReaderJson, takeReaderAllowance } from '../../../lib/readers';

export const GET = readerAccountRoute(({ cookies }) => json(getReaderAccount(requireReaderAccount(cookies))));

export const PATCH = readerAccountRoute(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const reader = requireReaderAccount(cookies);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  if (!takeReaderAllowance([
    { key: `profile-source:${source}`, maximum: readerConfig.profileSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: `profile-reader:${reader.id}`, maximum: readerConfig.profileSourceLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '资料修改过于频繁，请稍后重试');
  const updated = updateReaderProfile(reader, await readReaderJson(request));
  return json({ reader: updated, account: getReaderAccount(updated) });
});

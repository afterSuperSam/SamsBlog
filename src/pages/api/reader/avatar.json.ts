import { readerConfig } from '../../../config/readers';
import { HttpError, json, requirePublicActivityAllowance, requireSameOrigin } from '../../../lib/http';
import { readMediaUpload } from '../../../lib/media';
import { fingerprintIp, getClientIp } from '../../../lib/network';
import { readerAccountRoute, requireReaderAccount, updateReaderAvatar } from '../../../lib/reader-account';
import { takeReaderAllowance } from '../../../lib/readers';

export const POST = readerAccountRoute(async ({ request, cookies, clientAddress }) => {
  requireSameOrigin(request);
  const reader = requireReaderAccount(cookies);
  const source = fingerprintIp(getClientIp(request, clientAddress));
  requirePublicActivityAllowance(source);
  if (!takeReaderAllowance([
    { key: `avatar-source:${source}`, maximum: readerConfig.avatarSourceLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: `avatar-reader:${reader.id}`, maximum: readerConfig.avatarReaderLimit, seconds: readerConfig.quotaWindowSeconds },
    { key: 'avatar-global', maximum: readerConfig.avatarGlobalLimit, seconds: readerConfig.quotaWindowSeconds },
  ])) throw new HttpError(429, '头像修改过于频繁，请稍后重试');
  const file = await readMediaUpload(request, readerConfig.avatarMaximumBytes + readerConfig.avatarMultipartOverheadBytes);
  const account = await updateReaderAvatar(reader, file);
  return json({ reader: account.reader, account });
});

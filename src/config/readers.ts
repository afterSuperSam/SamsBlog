import './server';

const boundedInteger = (name: string, fallback: number, maximum: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid reader configuration: ${name}`);
  return value;
};

// 读者认证独立于管理权限，所有时间和配额在此校验。
export const readerConfig = {
  sessionSeconds: boundedInteger('READER_SESSION_SECONDS', 30 * 86400, 90 * 86400),
  oauthSeconds: boundedInteger('READER_OAUTH_SECONDS', 600, 900),
  codeSeconds: boundedInteger('READER_CODE_SECONDS', 600, 900),
  codeAttempts: boundedInteger('READER_CODE_ATTEMPTS', 5, 10),
  emailCooldownSeconds: boundedInteger('READER_EMAIL_COOLDOWN_SECONDS', 60, 3600),
  quotaWindowSeconds: boundedInteger('READER_QUOTA_WINDOW_SECONDS', 3600, 86400),
  emailAddressLimit: boundedInteger('READER_EMAIL_ADDRESS_LIMIT', 5, 100),
  emailSourceLimit: boundedInteger('READER_EMAIL_SOURCE_LIMIT', 10, 100),
  emailGlobalLimit: boundedInteger('READER_EMAIL_GLOBAL_LIMIT', 100, 1000),
  verifySourceLimit: boundedInteger('READER_VERIFY_SOURCE_LIMIT', 30, 100),
  verifyGlobalLimit: boundedInteger('READER_VERIFY_GLOBAL_LIMIT', 1000, 10000),
  oauthSourceLimit: boundedInteger('READER_OAUTH_SOURCE_LIMIT', 30, 100),
  oauthGlobalLimit: boundedInteger('READER_OAUTH_GLOBAL_LIMIT', 1000, 10000),
  requestMaximumBytes: boundedInteger('READER_REQUEST_MAXIMUM_BYTES', 4096, 16384),
  upstreamTimeoutMilliseconds: boundedInteger('READER_UPSTREAM_TIMEOUT_MILLISECONDS', 8000, 15000),
  upstreamMaximumBytes: boundedInteger('READER_UPSTREAM_MAXIMUM_BYTES', 65536, 262144),
};

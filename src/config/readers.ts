import './server';

const boundedInteger = (name: string, fallback: number, maximum: number, minimum = 1) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid reader configuration: ${name}`);
  return value;
};

// 读者认证独立于管理权限，所有时间和配额在此校验。
export const readerConfig = {
  sessionSeconds: boundedInteger('READER_SESSION_SECONDS', 30 * 86400, 90 * 86400),
  recentAuthenticationSeconds: boundedInteger('READER_RECENT_AUTHENTICATION_SECONDS', 900, 3600),
  accountPageSize: boundedInteger('READER_ACCOUNT_PAGE_SIZE', 20, 100),
  profileSourceLimit: boundedInteger('READER_PROFILE_SOURCE_LIMIT', 30, 100),
  displayNameMaximumLength: boundedInteger('READER_DISPLAY_NAME_MAXIMUM_LENGTH', 12, 12, 2),
  avatarMaximumBytes: boundedInteger('READER_AVATAR_MAXIMUM_BYTES', 2 * 1024 * 1024, 2 * 1024 * 1024),
  avatarMultipartOverheadBytes: boundedInteger('READER_AVATAR_MULTIPART_OVERHEAD_BYTES', 65536, 65536),
  avatarSourceLimit: boundedInteger('READER_AVATAR_SOURCE_LIMIT', 10, 30),
  avatarReaderLimit: boundedInteger('READER_AVATAR_READER_LIMIT', 10, 30),
  avatarGlobalLimit: boundedInteger('READER_AVATAR_GLOBAL_LIMIT', 200, 1000),
  passkeyChallengeSeconds: boundedInteger('READER_PASSKEY_CHALLENGE_SECONDS', 300, 600),
  passkeyMaximumCount: boundedInteger('READER_PASSKEY_MAXIMUM_COUNT', 10, 20),
  passkeyRequestMaximumBytes: boundedInteger('READER_PASSKEY_REQUEST_MAXIMUM_BYTES', 65536, 131072),
  passkeySourceLimit: boundedInteger('READER_PASSKEY_SOURCE_LIMIT', 60, 200),
  passkeyGlobalLimit: boundedInteger('READER_PASSKEY_GLOBAL_LIMIT', 2000, 10000),
  passkeyAlgorithms: [-7, -257],
  oauthSeconds: boundedInteger('READER_OAUTH_SECONDS', 600, 900),
  codeLength: 3,
  codeSeconds: boundedInteger('READER_CODE_SECONDS', 600, 900),
  codeAttempts: boundedInteger('READER_CODE_ATTEMPTS', 3, 3),
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

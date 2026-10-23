import { loadEnvFile } from 'node:process';

// 开发时加载本地配置，生产只读取进程环境，避免构建产物包含秘密
if (import.meta.env.DEV && !import.meta.env.PROD && process.env.NODE_ENV !== 'production') {
  try { loadEnvFile(); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

const positiveInteger = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid server configuration: ${name}`);
  return value;
};

// 服务端行为参数与启动校验
export const serverConfig = {
  siteLaunchedAt: process.env.SITE_LAUNCHED_AT ?? '2026-08-22',
  sessionSeconds: positiveInteger('ADMIN_SESSION_SECONDS', 8 * 60 * 60),
  passwordMaxLength: positiveInteger('ADMIN_PASSWORD_MAX_LENGTH', 256),
  loginWindowSeconds: positiveInteger('ADMIN_LOGIN_WINDOW_SECONDS', 60),
  loginAttempts: positiveInteger('ADMIN_LOGIN_ATTEMPTS', 5),
  loginGlobalAttempts: positiveInteger('ADMIN_LOGIN_GLOBAL_ATTEMPTS', 30),
  loginTrackedAddresses: positiveInteger('ADMIN_LOGIN_TRACKED_ADDRESSES', 1000),
  messageCooldownSeconds: positiveInteger('MESSAGE_COOLDOWN_SECONDS', 60),
  articleTitleMaxLength: positiveInteger('ARTICLE_TITLE_MAX_LENGTH', 160),
  articleContentMaxLength: positiveInteger('ARTICLE_CONTENT_MAX_LENGTH', 100000),
  articleRequestMaxBytes: positiveInteger('ARTICLE_REQUEST_MAX_BYTES', 1024 * 1024),
  mediaMaxBytes: positiveInteger('MEDIA_MAX_BYTES', 10 * 1024 * 1024),
  githubUsername: process.env.GITHUB_USERNAME || 'afterSuperSam',
  githubCacheSeconds: positiveInteger('GITHUB_CACHE_SECONDS', 6 * 60 * 60),
  githubRetrySeconds: positiveInteger('GITHUB_RETRY_SECONDS', 60),
  githubTimeoutMilliseconds: positiveInteger('GITHUB_TIMEOUT_MILLISECONDS', 5000),
  githubConcurrency: positiveInteger('GITHUB_CONCURRENCY', 3),
  friendStatusCacheSeconds: positiveInteger('FRIEND_STATUS_CACHE_SECONDS', 300),
  friendStatusTimeoutMilliseconds: positiveInteger('FRIEND_STATUS_TIMEOUT_MILLISECONDS', 5000),
  friendStatusSlowMilliseconds: positiveInteger('FRIEND_STATUS_SLOW_MILLISECONDS', 1800),
  friendStatusConcurrency: positiveInteger('FRIEND_STATUS_CONCURRENCY', 3),
  friendStatusMaxRedirects: positiveInteger('FRIEND_STATUS_MAX_REDIRECTS', 3),
  friendFeedCacheSeconds: positiveInteger('FRIEND_FEED_CACHE_SECONDS', 1800),
  friendFeedMaximumBytes: positiveInteger('FRIEND_FEED_MAXIMUM_BYTES', 1024 * 1024),
  friendFeedMaximumEntries: positiveInteger('FRIEND_FEED_MAXIMUM_ENTRIES', 100),
  friendFeedMaximumDepth: positiveInteger('FRIEND_FEED_MAXIMUM_DEPTH', 32),
};

if (serverConfig.mediaMaxBytes > 10 * 1024 * 1024) throw new Error('Invalid server configuration: MEDIA_MAX_BYTES (maximum 10 MiB)');
if (serverConfig.githubConcurrency > 6) throw new Error('Invalid server configuration: GITHUB_CONCURRENCY (maximum 6)');

if (serverConfig.friendStatusTimeoutMilliseconds > 15000
  || serverConfig.friendStatusSlowMilliseconds >= serverConfig.friendStatusTimeoutMilliseconds
  || serverConfig.friendStatusConcurrency > 6 || serverConfig.friendStatusMaxRedirects > 5) {
  throw new Error('Invalid friend connectivity configuration');
}

if (serverConfig.friendFeedMaximumBytes > 4 * 1024 * 1024 || serverConfig.friendFeedMaximumEntries > 500
  || serverConfig.friendFeedMaximumDepth > 64 || serverConfig.friendFeedCacheSeconds > 86400) {
  throw new Error('Invalid friend feed configuration');
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(serverConfig.siteLaunchedAt)
  || !Number.isFinite(Date.parse(serverConfig.siteLaunchedAt))
  || new Date(serverConfig.siteLaunchedAt).toISOString().slice(0, 10) !== serverConfig.siteLaunchedAt) {
  throw new Error('Invalid server configuration: SITE_LAUNCHED_AT (expected YYYY-MM-DD)');
}

if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(serverConfig.githubUsername)) {
  throw new Error('Invalid server configuration: GITHUB_USERNAME');
}

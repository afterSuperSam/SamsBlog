import { loadEnvFile } from 'node:process';

// 开发时加载本地配置，生产只读取进程环境，避免构建产物包含秘密
if (import.meta.env.DEV && !import.meta.env.PROD && process.env.NODE_ENV !== 'production') {
  try { loadEnvFile(); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

const positiveInteger = (name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid server configuration: ${name}`);
  return value;
};

const booleanSetting = (name: string) => {
  const value = process.env[name] ?? 'false';
  if (!['true', 'false'].includes(value)) throw new Error(`Invalid server configuration: ${name}`);
  return value === 'true';
};

// 服务端行为参数与启动校验
export const serverConfig = {
  maintenanceMode: booleanSetting('BLOG_MAINTENANCE_MODE'),
  maintenanceRetrySeconds: positiveInteger('MAINTENANCE_RETRY_SECONDS', 300, 3600),
  analyticsDeduplicationSeconds: positiveInteger('ANALYTICS_DEDUPLICATION_SECONDS', 1800),
  analyticsVisitorPageSize: positiveInteger('ANALYTICS_VISITOR_PAGE_SIZE', 20),
  siteLaunchedAt: process.env.SITE_LAUNCHED_AT ?? '2026-08-22',
  sessionSeconds: positiveInteger('ADMIN_SESSION_SECONDS', 8 * 60 * 60),
  passwordMaxLength: positiveInteger('ADMIN_PASSWORD_MAX_LENGTH', 256),
  loginWindowSeconds: positiveInteger('ADMIN_LOGIN_WINDOW_SECONDS', 60),
  loginAttempts: positiveInteger('ADMIN_LOGIN_ATTEMPTS', 5),
  loginGlobalAttempts: positiveInteger('ADMIN_LOGIN_GLOBAL_ATTEMPTS', 30),
  loginTrackedAddresses: positiveInteger('ADMIN_LOGIN_TRACKED_ADDRESSES', 1000),
  adminMutationLimit: positiveInteger('ADMIN_MUTATION_LIMIT', 120),
  adminMutationWindowSeconds: positiveInteger('ADMIN_MUTATION_WINDOW_SECONDS', 60),
  publicActivityLimit: positiveInteger('PUBLIC_ACTIVITY_LIMIT', 60),
  publicActivityWindowSeconds: positiveInteger('PUBLIC_ACTIVITY_WINDOW_SECONDS', 60),
  publicActivityTrackedAddresses: positiveInteger('PUBLIC_ACTIVITY_TRACKED_ADDRESSES', 1000),
  messageSubmissionLimit: positiveInteger('MESSAGE_SUBMISSION_LIMIT', 2),
  messageSubmissionWindowSeconds: positiveInteger('MESSAGE_SUBMISSION_WINDOW_SECONDS', 60),
  articleTitleMaxLength: positiveInteger('ARTICLE_TITLE_MAX_LENGTH', 160),
  articleContentMaxLength: positiveInteger('ARTICLE_CONTENT_MAX_LENGTH', 100000),
  articleSummaryMaxLength: positiveInteger('ARTICLE_SUMMARY_MAX_LENGTH', 500),
  articleAutosaveMilliseconds: positiveInteger('ARTICLE_AUTOSAVE_MILLISECONDS', 1800),
  reactionCooldownSeconds: positiveInteger('REACTION_COOLDOWN_SECONDS', 2),
  friendApplicationSubmissionLimit: positiveInteger('FRIEND_APPLICATION_SUBMISSION_LIMIT', 2),
  friendApplicationSubmissionWindowSeconds: positiveInteger('FRIEND_APPLICATION_SUBMISSION_WINDOW_SECONDS', 3600),
  notificationTimeoutMilliseconds: positiveInteger('NOTIFICATION_TIMEOUT_MILLISECONDS', 7000),
  notificationRetrySeconds: positiveInteger('NOTIFICATION_RETRY_SECONDS', 60),
  notificationRetryMaximumSeconds: positiveInteger('NOTIFICATION_RETRY_MAXIMUM_SECONDS', 3600, 82800),
  notificationMaximumAttempts: positiveInteger('NOTIFICATION_MAXIMUM_ATTEMPTS', 5),
  notificationBatchSize: positiveInteger('NOTIFICATION_BATCH_SIZE', 5),
  notificationExpiryHours: positiveInteger('NOTIFICATION_EXPIRY_HOURS', 23),
  notificationTemplateVariableMaxLength: 2000,
  notificationVerificationSeconds: positiveInteger('NOTIFICATION_VERIFICATION_SECONDS', 3600, 86400),
  notificationVerificationCooldownSeconds: positiveInteger('NOTIFICATION_VERIFICATION_COOLDOWN_SECONDS', 60, 86400),
  notificationVerificationDailyLimit: positiveInteger('NOTIFICATION_VERIFICATION_DAILY_LIMIT', 5, 50),
  notificationWebhookToleranceSeconds: positiveInteger('NOTIFICATION_WEBHOOK_TOLERANCE_SECONDS', 300, 600),
  notificationWebhookMaximumBytes: positiveInteger('NOTIFICATION_WEBHOOK_MAXIMUM_BYTES', 65536, 1048576),
  notificationWebhookPendingSeconds: positiveInteger('NOTIFICATION_WEBHOOK_PENDING_SECONDS', 72 * 3600, 7 * 86400),
  notificationWebhookPendingLimit: positiveInteger('NOTIFICATION_WEBHOOK_PENDING_LIMIT', 1000, 10000),
  notificationWebhookSecret: process.env.RESEND_WEBHOOK_SECRET?.trim() || '',
  commentIdentitySeconds: positiveInteger('COMMENT_IDENTITY_SECONDS', 31536000, 31536000),
  notificationReplyTemplateId: process.env.RESEND_REPLY_TEMPLATE_ID?.trim() || '',
  notificationAdminTemplateId: process.env.RESEND_ADMIN_TEMPLATE_ID?.trim() || '',
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
  friendFeedSummaryMaxLength: positiveInteger('FRIEND_FEED_SUMMARY_MAX_LENGTH', 200),
};

// 时间值统一限制在定时器与业务有效窗口内，重试必须留在有效期中。
const timeMaximums = {
  sessionSeconds: 604800, loginWindowSeconds: 86400, articleAutosaveMilliseconds: 60000,
  reactionCooldownSeconds: 86400, notificationTimeoutMilliseconds: 60000, notificationRetrySeconds: 3600,
  githubCacheSeconds: 604800, githubRetrySeconds: 86400, githubTimeoutMilliseconds: 60000,
  friendStatusCacheSeconds: 86400,
} as const;
for (const [name, maximum] of Object.entries(timeMaximums)) {
  if (serverConfig[name as keyof typeof timeMaximums] > maximum) throw new Error(`Invalid server time configuration: ${name}`);
}
if (serverConfig.notificationMaximumAttempts > 20
  || serverConfig.notificationRetrySeconds * 1000 <= serverConfig.notificationTimeoutMilliseconds
  || serverConfig.notificationRetryMaximumSeconds < serverConfig.notificationRetrySeconds
  || serverConfig.notificationRetryMaximumSeconds >= serverConfig.notificationExpiryHours * 3600
  || Array.from({ length: serverConfig.notificationMaximumAttempts - 1 }, (_, index) =>
    Math.min(serverConfig.notificationRetryMaximumSeconds, serverConfig.notificationRetrySeconds * 2 ** (index + 1)))
    .reduce((total, delay) => total + delay, serverConfig.notificationMaximumAttempts * serverConfig.notificationTimeoutMilliseconds / 1000) >= serverConfig.notificationExpiryHours * 3600
  || serverConfig.githubRetrySeconds > serverConfig.githubCacheSeconds
  || serverConfig.notificationVerificationCooldownSeconds >= serverConfig.notificationVerificationSeconds) {
  throw new Error('Invalid related server time configuration');
}
if (serverConfig.notificationWebhookPendingSeconds <= serverConfig.notificationExpiryHours * 3600 + serverConfig.notificationWebhookToleranceSeconds) {
  throw new Error('Invalid server configuration: NOTIFICATION_WEBHOOK_PENDING_SECONDS must cover the delivery retry window');
}
if (serverConfig.notificationWebhookSecret) {
  const encoded = serverConfig.notificationWebhookSecret.slice(6);
  if (!serverConfig.notificationWebhookSecret.startsWith('whsec_') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || Buffer.from(encoded, 'base64').length < 16 || Buffer.from(encoded, 'base64').toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Invalid server configuration: RESEND_WEBHOOK_SECRET');
  }
}

if (serverConfig.notificationExpiryHours > 23 || serverConfig.notificationBatchSize > 20
  || [serverConfig.notificationReplyTemplateId, serverConfig.notificationAdminTemplateId].some((value) => value && !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
  throw new Error('Invalid notification configuration');
}

if (serverConfig.mediaMaxBytes > 10 * 1024 * 1024) throw new Error('Invalid server configuration: MEDIA_MAX_BYTES (maximum 10 MiB)');
if (serverConfig.analyticsVisitorPageSize > 100) throw new Error('Invalid analytics visitor page size');
if (serverConfig.adminMutationLimit > 10000 || serverConfig.publicActivityLimit > 10000
  || serverConfig.adminMutationWindowSeconds > 86400 || serverConfig.publicActivityWindowSeconds > 86400
  || serverConfig.publicActivityTrackedAddresses > 100000) throw new Error('Invalid request rate-limit configuration');
if (serverConfig.messageSubmissionLimit > 1000 || serverConfig.friendApplicationSubmissionLimit > 1000
  || serverConfig.messageSubmissionWindowSeconds > 86400 || serverConfig.friendApplicationSubmissionWindowSeconds > 86400) {
  throw new Error('Invalid public submission rate-limit configuration');
}
if (serverConfig.analyticsDeduplicationSeconds > 86400) throw new Error('Invalid server configuration: ANALYTICS_DEDUPLICATION_SECONDS (maximum 86400)');
if (serverConfig.githubConcurrency > 6) throw new Error('Invalid server configuration: GITHUB_CONCURRENCY (maximum 6)');

if (serverConfig.friendStatusTimeoutMilliseconds > 15000
  || serverConfig.friendStatusSlowMilliseconds >= serverConfig.friendStatusTimeoutMilliseconds
  || serverConfig.friendStatusConcurrency > 6 || serverConfig.friendStatusMaxRedirects > 5) {
  throw new Error('Invalid friend connectivity configuration');
}

if (serverConfig.friendFeedMaximumBytes > 4 * 1024 * 1024 || serverConfig.friendFeedMaximumEntries > 500
  || serverConfig.friendFeedMaximumDepth > 64 || serverConfig.friendFeedCacheSeconds > 86400 || serverConfig.friendFeedSummaryMaxLength > 500) {
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

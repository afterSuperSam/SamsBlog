import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 测试不加载个人环境；遗漏数据目录或邮件模拟时也不会触及本机资料。
export default defineConfig({
  envDir: false,
  test: {
    env: {
      NODE_ENV: 'production',
      BLOG_DATA_DIR: mkdtempSync(join(tmpdir(), 'samsblog-tests-')),
      BLOG_SECRET: 'isolated-test-secret-at-least-32-characters',
      ADMIN_PASSWORD_HASH: '',
      PUBLIC_SITE_URL: 'https://blog.example.com',
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      MAIL_REPLY_TO: '',
    },
  },
});

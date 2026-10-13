// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import node from '@astrojs/node';

// https://astro.build/config
const isBuildCommand = process.argv.includes('build');
const mode = isBuildCommand ? 'production' : 'development';
const env = loadEnv(mode, process.cwd(), '');
const publicSiteUrl = env.PUBLIC_SITE_URL || process.env.PUBLIC_SITE_URL;
if (isBuildCommand && !publicSiteUrl) throw new Error('PUBLIC_SITE_URL is required for production builds');

export default defineConfig({
  site: publicSiteUrl || 'http://localhost:4321',
  output: 'server',
  adapter: node({
    mode: 'standalone',
    staticHeaders: true,
    bodySizeLimit: 64 * 1024,
  }),
  security: {
    checkOrigin: true,
    csp: isBuildCommand,
  },
  markdown: {
    syntaxHighlight: 'prism',
  },
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
});

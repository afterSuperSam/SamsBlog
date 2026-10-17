// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import node from '@astrojs/node';

// https://astro.build/config
const isBuildCommand = process.argv.includes('build');
const mode = isBuildCommand ? 'production' : 'development';
const env = loadEnv(mode, process.cwd(), '');
const publicSiteUrl = process.env.PUBLIC_SITE_URL || env.PUBLIC_SITE_URL;
if (isBuildCommand && !publicSiteUrl) throw new Error('PUBLIC_SITE_URL is required for production builds');
const siteUrl = new URL(publicSiteUrl || 'http://localhost:4321');
if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password
  || siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash) {
  throw new Error('PUBLIC_SITE_URL must be an HTTP(S) origin without credentials');
}

export default defineConfig({
  site: siteUrl.href,
  output: 'server',
  adapter: node({
    mode: 'standalone',
    staticHeaders: true,
    bodySizeLimit: 1024 * 1024,
  }),
  security: {
    checkOrigin: true,
    allowedDomains: [{
      protocol: siteUrl.protocol.slice(0, -1),
      hostname: siteUrl.hostname,
      port: siteUrl.port || (siteUrl.protocol === 'https:' ? '443' : '80'),
    }],
    csp: isBuildCommand,
  },
  markdown: { syntaxHighlight: false },
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
});

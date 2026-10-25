import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpile } from 'typescript';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const configurationUrl = new URL('../astro.config.mjs', import.meta.url).href;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function readBuildSite(files: Record<string, string>, publicSiteUrl?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'samsblog-config-'));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(directory, name), contents);
  const environment = { ...process.env };
  delete environment.PUBLIC_SITE_URL;
  if (publicSiteUrl) environment.PUBLIC_SITE_URL = publicSiteUrl;
  const script = `process.argv.push('build'); const { default: configuration } = await import(${JSON.stringify(configurationUrl)}); console.log(configuration.site);`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('production Astro configuration', () => {
  it('trusts the configured HTTPS origin after default-port normalization', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'samsblog-proxy-config-'));
    temporaryDirectories.push(directory);
    const script = `process.argv.push('build');
      const { default: configuration } = await import(${JSON.stringify(configurationUrl)});
      const { createRequest } = await import(${JSON.stringify(import.meta.resolve('astro/app/node'))});
      const request = createRequest({ method: 'GET', url: '/api/admin/media.json',
        headers: { host: '127.0.0.1:4321', 'x-forwarded-host': 'blog.example.com',
          'x-forwarded-proto': 'https', 'x-forwarded-port': '443' }, socket: {} },
        { allowedDomains: configuration.security.allowedDomains });
      console.log(new URL(request.url).origin);`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory,
      env: { ...process.env, PUBLIC_SITE_URL: 'https://blog.example.com' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()).toBe('https://blog.example.com');
  });

  it('loads the real configuration with production-local values taking precedence', () => {
    expect(readBuildSite({
      '.env': 'PUBLIC_SITE_URL=https://base.example.com',
      '.env.local': 'PUBLIC_SITE_URL=https://local.example.com',
      '.env.production': 'PUBLIC_SITE_URL=https://production.example.com',
      '.env.production.local': 'PUBLIC_SITE_URL="https://final.example.com"',
    })).toBe('https://final.example.com/');
  });

  it('prefers an explicitly supplied origin over dotenv files', () => {
    expect(readBuildSite({ '.env.production': 'PUBLIC_SITE_URL=https://file.example.com' },
      'https://environment.example.com')).toBe('https://environment.example.com/');
  });

  it('rejects production builds without a public origin', () => {
    expect(() => readBuildSite({})).toThrow('PUBLIC_SITE_URL is required for production builds');
  });

  it('rejects an insecure production origin', () => {
    expect(() => readBuildSite({}, 'http://blog.example.com')).toThrow('PUBLIC_SITE_URL must use HTTPS for production builds');
  });
});

describe('public friend profile image configuration', () => {
  const source = readFileSync(new URL('../src/config/site.ts', import.meta.url), 'utf8')
    .replace('import.meta.env.PUBLIC_SITE_URL', JSON.stringify('https://blog.example.com'))
    .replace('const rssUrl = new URL(siteConfig.rss.siteUrl);', 'Object.assign(siteConfig.friendApplications, profileOverrides);\nconst rssUrl = new URL(siteConfig.rss.siteUrl);');
  const script = transpile(source, { module: ModuleKind.CommonJS });
  const readProfile = (profileOverrides: Record<string, string>) => runInNewContext(script, { exports: {}, URL, profileOverrides });

  it('accepts the configured static and uploaded image paths with dots inside filenames', () => {
    expect(() => readProfile({})).not.toThrow();
    expect(() => readProfile({ iconUrl: '/media/brand/logo.v2.jpg', backgroundUrl: '/uploads/fixture.webp' })).not.toThrow();
  });

  it.each(['/media/../admin', '/uploads/../../admin', '/media/./logo.jpg', '/media//logo.jpg', '/media/logo.jpg/', '//other.example/logo.jpg', '/media/%2e%2e/logo.jpg', '/media/logo.jpg?private=1', '/media/logo.jpg#private', '/media\\logo.jpg'])('rejects noncanonical public image path %s', (pathname) => {
    for (const field of ['iconUrl', 'backgroundUrl']) expect(() => readProfile({ [field]: pathname })).toThrow('Invalid friend application profile');
  });
});

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';

const directories: string[] = [];
const connections: Database.Database[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'samsblog-runtime-safety-'));
  directories.push(directory); vi.stubEnv('BLOG_DATA_DIR', directory);
  return path.join(directory, 'blog.sqlite');
}
afterEach(() => {
  connections.forEach((connection) => { if (connection.open) connection.close(); }); connections.length = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

describe('schema and maintenance safety', () => {
  it.each(['future-version', 'unknown-migration'])('refuses %s before modifying the existing database', async (kind) => {
    const filename = fixture(); const existing = new Database(filename);
    existing.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT NOT NULL)");
    if (kind === 'future-version') existing.pragma('user_version=999');
    else existing.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('20991231-unknown', '2099-12-31');
    existing.close();
    const bytes = readFileSync(filename); const files = readdirSync(path.dirname(filename));
    const { getDatabase } = await import('../src/lib/db');
    expect(getDatabase).toThrow('Unsupported database schema');
    expect(readFileSync(filename)).toEqual(bytes); expect(readdirSync(path.dirname(filename))).toEqual(files);
  });

  it('upgrades an old database and repeats initialization without losing data or duplicating migrations', async () => {
    const filename = fixture(); const existing = new Database(filename);
    existing.exec('CREATE TABLE historical_fixture(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO historical_fixture VALUES (1,\'preserve\')'); existing.close();
    let module = await import('../src/lib/db'); const first = module.getDatabase(); connections.push(first);
    const migrations = first.prepare('SELECT * FROM schema_migrations ORDER BY id').all(); first.close();
    vi.resetModules(); module = await import('../src/lib/db'); const second = module.getDatabase(); connections.push(second);
    expect(second.prepare('SELECT * FROM schema_migrations ORDER BY id').all()).toEqual(migrations);
    expect(second.prepare('SELECT value FROM historical_fixture').get()).toEqual({ value: 'preserve' });
    expect(second.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back the complete migration transaction if a new migration fails', async () => {
    const filename = fixture(); const existing = new Database(filename);
    existing.exec('CREATE TABLE admin_audit(fixture INTEGER)'); existing.close();
    const { getDatabase } = await import('../src/lib/db'); expect(getDatabase).toThrow();
    const inspection = new Database(filename, { readonly: true }); connections.push(inspection);
    expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'admin_audit' }]);
    expect(inspection.pragma('user_version', { simple: true })).toBe(0);
  });

  it('accepts only the explicit historical markers with compatible metadata, including in maintenance', async () => {
    fixture(); const first = (await import('../src/lib/db')).getDatabase(); connections.push(first);
    first.exec('ALTER TABLE friends ADD COLUMN featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1))');
    const articleSchema = (first.prepare("SELECT sql FROM sqlite_master WHERE name='blog_articles' AND type='table'").get() as { sql: string }).sql;
    first.pragma('foreign_keys=OFF');
    first.exec(articleSchema.replace('CREATE TABLE blog_articles', 'CREATE TABLE historical_articles').replace("'article','note','link','update'", "'article','note','link'"));
    first.exec('DROP TABLE blog_articles; ALTER TABLE historical_articles RENAME TO blog_articles');
    first.pragma('foreign_keys=ON');
    for (const id of ['retire-media-v1', '20261022-featured-friends', '20261106-friend-presentation', '20261106-application-accepted-mail', '20261106-retire-update-content']) {
      first.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(id, '2026-11-06');
    }
    first.close(); vi.resetModules();
    vi.stubEnv('BLOG_MAINTENANCE_MODE', 'true');
    const readonly = (await import('../src/lib/db')).getDatabase(); connections.push(readonly);
    expect(readonly.readonly).toBe(true); expect(readonly.prepare('SELECT 1 AS available').get()).toEqual({ available: 1 });
  });

  it('rejects an allowed historical marker whose required structure is absent', async () => {
    const filename = fixture(); const first = (await import('../src/lib/db')).getDatabase(); connections.push(first);
    first.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('20261022-featured-friends', '2026-10-22');
    first.close(); const bytes = readFileSync(filename); vi.resetModules();
    const { getDatabase } = await import('../src/lib/db');
    expect(getDatabase).toThrow('historical migration metadata'); expect(readFileSync(filename)).toEqual(bytes);
  });

  it('keeps supported content readable with a read-only connection during maintenance', async () => {
    fixture(); const first = (await import('../src/lib/db')).getDatabase(); connections.push(first); first.close();
    vi.stubEnv('BLOG_MAINTENANCE_MODE', 'true'); vi.resetModules();
    const { getDatabase } = await import('../src/lib/db'); const readonly = getDatabase(); connections.push(readonly);
    expect(readonly.readonly).toBe(true); expect(readonly.prepare('SELECT count(*) AS count FROM friends').get()).toEqual({ count: 1 });
    expect(() => readonly.prepare("UPDATE friends SET name='forbidden'").run()).toThrow();
    const { route, json } = await import('../src/lib/http'); const handler = vi.fn(() => json({ ok: true }));
    const call = (method: string) => route(handler)({ request: new Request('https://blog.example.com/api/admin/login.json', { method }) } as APIContext);
    expect((await call('GET'))!.status).toBe(200);
    const rejected = await call('POST'); expect(rejected!.status).toBe(503); expect(rejected!.headers.get('Retry-After')).toBe('300');
    expect(handler).toHaveBeenCalledTimes(1);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { getFriendStatuses } = await import('../src/lib/friend-status');
    const { getFriendFeeds } = await import('../src/lib/friend-feeds');
    const { getProjectCommitDates } = await import('../src/lib/projects');
    const { getGithubContributions } = await import('../src/lib/contributions');
    await Promise.all([getFriendStatuses(), getFriendFeeds(), getProjectCommitDates(), getGithubContributions()]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses maintenance on a missing or unupgraded database without creating files', async () => {
    const filename = fixture(); vi.stubEnv('BLOG_MAINTENANCE_MODE', 'true');
    const { getDatabase } = await import('../src/lib/db'); expect(getDatabase).toThrow('existing supported database');
    expect(readdirSync(path.dirname(filename))).toEqual([]);
  });

  it('audits authorized validation failures without storing request content or identity', async () => {
    fixture(); const { getDatabase } = await import('../src/lib/db'); const database = getDatabase(); connections.push(database);
    const { adminCookie, createAdminSession } = await import('../src/lib/admin-auth');
    const { PATCH } = await import('../src/pages/api/admin/friends.json');
    const response = await PATCH({ request: new Request('https://blog.example.com/api/admin/friends.json', {
      method: 'PATCH', headers: { origin: 'https://blog.example.com', 'content-type': 'application/json' }, body: '{"private_body":"secret","id":"invalid"}',
    }), cookies: { get: (name: string) => name === adminCookie.name ? { value: createAdminSession() } : undefined } } as unknown as APIContext);
    expect(response.status).toBe(400);
    const events = database.prepare('SELECT * FROM admin_audit').all(); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ object_type: 'friend', object_id: null, operation: 'update', result: 'rejected', revision: null });
    expect(JSON.stringify(events)).not.toMatch(/private_body|secret|example\.com/);
  });
});

describe('bounded server time configuration', () => {
  it.each([
    ['ADMIN_SESSION_SECONDS', '9007199254740991'], ['GITHUB_TIMEOUT_MILLISECONDS', '2147483648'],
    ['NOTIFICATION_MAXIMUM_ATTEMPTS', '21'], ['NOTIFICATION_RETRY_MAXIMUM_SECONDS', '82800'],
    ['NOTIFICATION_VERIFICATION_COOLDOWN_SECONDS', '3600'], ['GITHUB_RETRY_SECONDS', '30000'],
    ['BLOG_MAINTENANCE_MODE', '1'],
  ])('rejects unsafe %s', async (name, value) => {
    vi.stubEnv(name, value); await expect(import('../src/config/server')).rejects.toThrow('Invalid');
  });
});

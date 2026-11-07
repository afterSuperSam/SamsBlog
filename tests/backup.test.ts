import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, readBackupConfiguration, restoreBackup, verifyBackup } from '../deploy/backup.mjs';

const connections: Database.Database[] = [];
const children: ChildProcess[] = [];
async function interruptBackup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}
afterEach(async () => {
  for (const child of children.splice(0)) await interruptBackup(child);
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
});

async function pausedBackup(dataDirectory: string, now: Date) {
  const script = `
    const { createBackup, readBackupConfiguration } = await import(process.argv[1]);
    await createBackup(readBackupConfiguration({ BLOG_DATA_DIR: process.argv[2] }), {
      now: new Date(process.argv[3]),
      onSnapshotCopied: () => new Promise((resolve) => {
        process.once('message', resolve);
        process.send({ phase: 'copied' });
      }),
    });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, new URL('../deploy/backup.mjs', import.meta.url).href, dataDirectory, now.toISOString()], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  let diagnostic = '';
  child.stderr?.on('data', (value) => { diagnostic += String(value).slice(0, 1500); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backup child did not reach the copied checkpoint')), 10000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Backup child exited before checkpoint: ${diagnostic}`)); });
  });
  return child;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'samsblog-backup-'));
  const dataDirectory = path.join(root, 'data');
  await mkdir(path.join(dataDirectory, 'uploads'), { recursive: true });
  const database = new Database(path.join(dataDirectory, 'blog.sqlite'));
  connections.push(database);
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE blog_media(filename TEXT PRIMARY KEY, byte_size INTEGER NOT NULL); CREATE TABLE readers(id INTEGER PRIMARY KEY, avatar_url TEXT); CREATE TABLE blog_articles(id INTEGER PRIMARY KEY, content TEXT);');
  const bytes = Buffer.from('GIF89a temporary backup fixture;');
  const filename = createHash('sha256').update(bytes).digest('hex') + '.gif';
  await writeFile(path.join(dataDirectory, 'uploads', filename), bytes);
  database.prepare('INSERT INTO blog_media VALUES (?,?)').run(filename, bytes.length);
  database.prepare('INSERT INTO readers VALUES (1,?)').run('/uploads/' + filename);
  database.prepare('INSERT INTO blog_articles VALUES (1,?)').run(`![fixture](/uploads/${filename})`);
  const configuration = readBackupConfiguration({ BLOG_DATA_DIR: dataDirectory });
  return { root, database, configuration, bytes, filename };
}

describe('paired database and uploaded image backups', () => {
  it('pins the same WAL snapshot and original images without holding writers during backup', async () => {
    const value = await fixture();
    const bundle = await createBackup(value.configuration, {
      onSnapshotPinned: async () => {
        value.database.transaction(() => {
          value.database.prepare('UPDATE readers SET avatar_url=NULL').run();
          value.database.prepare("UPDATE blog_articles SET content='changed after snapshot'").run();
          value.database.prepare('DELETE FROM blog_media').run();
        }).immediate();
        await unlink(path.join(value.configuration.dataDirectory, 'uploads', value.filename));
      },
    });
    expect((await verifyBackup(bundle)).uploads).toHaveLength(1);
    const restored = await restoreBackup(bundle, path.join(value.root, 'restored'));
    const database = new Database(path.join(restored, 'blog.sqlite'), { readonly: true });
    connections.push(database);
    expect(database.prepare('SELECT avatar_url FROM readers').get()).toEqual({ avatar_url: '/uploads/' + value.filename });
    expect(database.prepare('SELECT content FROM blog_articles').get()).toEqual({ content: `![fixture](/uploads/${value.filename})` });
    expect(await readFile(path.join(restored, 'uploads', value.filename))).toEqual(value.bytes);
    await expect(restoreBackup(bundle, value.configuration.dataDirectory)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readdir(value.configuration.dataDirectory)).not.toContain('.samsblog-snapshot');
  });

  it('copies independent files and removes only complete backups at the seven day cutoff', async () => {
    const value = await fixture();
    const before = new Date('2026-11-01T01:00:00.000Z');
    const oldest = await createBackup(value.configuration, { now: before });
    const recent = await createBackup(value.configuration, { now: new Date('2026-11-01T01:00:00.001Z') });
    const image = path.join(oldest, 'uploads', value.filename);
    expect((await stat(image)).ino).not.toBe((await stat(path.join(value.configuration.dataDirectory, 'uploads', value.filename))).ino);
    const unrelated = path.join(value.configuration.backupDirectory, 'personal.db');
    const partial = path.join(value.configuration.backupDirectory, '.unfinished.partial');
    const legacy = path.join(value.configuration.backupDirectory, 'samsblog-20261001T010000000000000Z.db');
    await writeFile(unrelated, 'keep'); await mkdir(partial); await writeFile(legacy, 'legacy');
    await utimes(legacy, before, before);
    await createBackup(value.configuration, { now: new Date('2026-11-08T01:00:00.000Z') });
    await expect(stat(oldest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(recent)).isDirectory()).toBe(true);
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    expect((await stat(partial)).isDirectory()).toBe(true);
  });

  it('does not publish or prune when snapshotting is interrupted or a required image is missing', async () => {
    const value = await fixture();
    const oldest = await createBackup(value.configuration, { now: new Date('2026-10-01T00:00:00.000Z') });
    const existing = await readdir(value.configuration.backupDirectory);
    await expect(createBackup(value.configuration, { onSnapshotPinned: () => { throw new Error('fixture interruption'); } })).rejects.toThrow('fixture interruption');
    expect(await readdir(value.configuration.backupDirectory)).toEqual(existing);
    await unlink(path.join(value.configuration.dataDirectory, 'uploads', value.filename));
    await expect(createBackup(value.configuration)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(oldest)).isDirectory()).toBe(true);
    expect(await readdir(value.configuration.backupDirectory)).toEqual(existing);
    expect((await readdir(value.configuration.dataDirectory)).filter((name) => name.startsWith('.samsblog-snapshot-'))).toEqual([]);
  });

  it('rejects corrupt images before creating a restoration destination', async () => {
    const value = await fixture();
    const bundle = await createBackup(value.configuration);
    await writeFile(path.join(bundle, 'uploads', value.filename), 'corrupted');
    const target = path.join(value.root, 'restore-corrupt');
    await expect(restoreBackup(bundle, target)).rejects.toThrow('checksum');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates retention centrally and defaults to seven days', () => {
    expect(readBackupConfiguration({}).retentionDays).toBe(7);
    for (const RETENTION_DAYS of ['0', '-1', '1.5', 'no', '366']) expect(() => readBackupConfiguration({ RETENTION_DAYS })).toThrow('RETENTION_DAYS');
    expect(readBackupConfiguration({ RETENTION_DAYS: '14' }).retentionDays).toBe(14);
  });

  it('preserves an expired active lease, then reclaims both directories after a hard process interruption', async () => {
    const value = await fixture();
    const child = await pausedBackup(value.configuration.dataDirectory, new Date('2026-11-01T01:00:00.000Z'));
    const pinned = path.join(value.configuration.dataDirectory, (await readdir(value.configuration.dataDirectory)).find((name) => name.startsWith('.samsblog-snapshot-'))!);
    const partial = path.join(value.configuration.backupDirectory, (await readdir(value.configuration.backupDirectory)).find((name) => name.endsWith('.partial'))!);
    expect((await stat(path.join(pinned, 'uploads', value.filename))).isFile()).toBe(true);
    expect((await stat(path.join(partial, 'uploads', value.filename))).isFile()).toBe(true);
    await createBackup(value.configuration, { now: new Date('2026-11-09T01:00:00.000Z') });
    expect((await stat(pinned)).isDirectory()).toBe(true);
    expect((await stat(partial)).isDirectory()).toBe(true);
    await interruptBackup(child);
    const complete = await createBackup(value.configuration, { now: new Date('2026-11-09T01:00:01.000Z') });
    await expect(stat(pinned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(value.configuration.dataDirectory, 'uploads', value.filename))).nlink).toBe(1);
    expect((await verifyBackup(complete)).uploads).toHaveLength(1);
    const restored = await restoreBackup(complete, path.join(value.root, 'restored-after-interruption'));
    expect(await readFile(path.join(restored, 'uploads', value.filename))).toEqual(value.bytes);
  });

  it('retains fresh abandoned stages and refuses a lease claiming a different backup directory', async () => {
    const value = await fixture();
    const started = new Date('2026-11-01T01:00:00.000Z');
    const child = await pausedBackup(value.configuration.dataDirectory, started);
    const pinned = path.join(value.configuration.dataDirectory, (await readdir(value.configuration.dataDirectory)).find((name) => name.startsWith('.samsblog-snapshot-'))!);
    const partial = path.join(value.configuration.backupDirectory, (await readdir(value.configuration.backupDirectory)).find((name) => name.endsWith('.partial'))!);
    await interruptBackup(child);
    await createBackup(value.configuration, { now: new Date('2026-11-08T00:59:59.999Z') });
    expect((await stat(pinned)).isDirectory()).toBe(true);
    const lease = new Database(path.join(pinned, 'lease.sqlite'));
    lease.prepare('UPDATE backup_lease SET backup_directory=?').run(path.join(value.root, 'foreign'));
    lease.close();
    await createBackup(value.configuration, { now: new Date('2026-11-08T01:00:00.000Z') });
    expect((await stat(pinned)).isDirectory()).toBe(true);
    expect((await stat(partial)).isDirectory()).toBe(true);
    const corrected = new Database(path.join(pinned, 'lease.sqlite'));
    corrected.prepare('UPDATE backup_lease SET backup_directory=?').run(value.configuration.backupDirectory);
    corrected.close();
    await createBackup(value.configuration, { now: new Date('2026-11-08T01:00:00.001Z') });
    await expect(stat(pinned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

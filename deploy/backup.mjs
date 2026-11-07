import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const filenamePattern = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/;
const bundlePattern = /^samsblog-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const legacyPattern = /^samsblog-\d{8}T\d{6,15}Z\.db$/;
const stagingPattern = /^\.samsblog-snapshot-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const dayMilliseconds = 86400000;

// 备份进程只读取显式环境；参数集中校验，不加载应用环境文件。
export const backupConfigurationSchema = {
  retentionDays: { environment: 'RETENTION_DAYS', defaultValue: 7, minimum: 1, maximum: 365 },
  databaseBusyMilliseconds: { environment: 'BACKUP_DATABASE_BUSY_MILLISECONDS', defaultValue: 5000, minimum: 1, maximum: 60000 },
};

export function readBackupConfiguration(environment = process.env) {
  const dataDirectory = path.resolve(environment.BLOG_DATA_DIR || '/opt/samsblog/shared/data');
  const values = Object.fromEntries(Object.entries(backupConfigurationSchema).map(([key, schema]) => {
    const value = Number(environment[schema.environment] ?? schema.defaultValue);
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) throw new Error(`Invalid backup configuration: ${schema.environment}`);
    return [key, value];
  }));
  return { dataDirectory, backupDirectory: path.resolve(environment.BACKUP_DIR || path.join(dataDirectory, 'backups')),
    retentionDays: values.retentionDays, databaseBusyMilliseconds: values.databaseBusyMilliseconds };
}

async function checksum(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function synchronize(filename) {
  const handle = await open(filename, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertRegularFile(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Backup image or database is not a regular file');
  return metadata;
}

async function removeOwnedDirectory(directory, parent) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(parent)) throw new Error('Backup cleanup target escaped its parent');
  const metadata = await lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Backup cleanup target is not an owned directory');
  await rm(directory, { recursive: true });
}

function readManifest(value) {
  if (!value || value.version !== 1 || value.database !== 'blog.sqlite' || !Number.isFinite(Date.parse(value.createdAt))
    || !/^[a-f0-9]{64}$/.test(value.databaseSha256) || !Array.isArray(value.uploads)) throw new Error('Invalid backup manifest');
  const names = new Set();
  for (const image of value.uploads) {
    if (!image || !filenamePattern.test(image.filename) || names.has(image.filename) || !Number.isSafeInteger(image.size) || image.size < 1
      || !/^[a-f0-9]{64}$/.test(image.sha256) || image.sha256 !== image.filename.split('.')[0]) throw new Error('Invalid backup image manifest');
    names.add(image.filename);
  }
  return value;
}

// 恢复前逐项核对数据库、全部图片及媒体登记；清单不含账户或文章正文。
export async function verifyBackup(directory) {
  const root = await lstat(directory);
  const uploads = await lstat(path.join(directory, 'uploads'));
  if (!root.isDirectory() || root.isSymbolicLink() || !uploads.isDirectory() || uploads.isSymbolicLink()) throw new Error('Invalid backup directory');
  await assertRegularFile(path.join(directory, 'manifest.json'));
  const manifest = readManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
  const databasePath = path.join(directory, 'blog.sqlite');
  await assertRegularFile(databasePath);
  if (await checksum(databasePath) !== manifest.databaseSha256) throw new Error('Backup database checksum mismatch');
  const records = new Map(manifest.uploads.map((image) => [image.filename, image]));
  for (const image of manifest.uploads) {
    const filename = path.join(directory, 'uploads', image.filename);
    if ((await assertRegularFile(filename)).size !== image.size || await checksum(filename) !== image.sha256) throw new Error('Backup image checksum mismatch');
  }
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Backup database integrity check failed');
    for (const media of database.prepare('SELECT filename, byte_size AS size FROM blog_media').all()) {
      if (!records.has(media.filename) || records.get(media.filename).size !== media.size) throw new Error('Backup media references are incomplete');
    }
  } finally { database.close(); }
  return manifest;
}

async function pruneBackups(configuration, now) {
  const cutoff = now.getTime() - configuration.retentionDays * dayMilliseconds;
  for (const entry of await readdir(configuration.backupDirectory, { withFileTypes: true })) {
    const filename = path.join(configuration.backupDirectory, entry.name);
    if (entry.isDirectory() && bundlePattern.test(entry.name)) {
      let manifest;
      try { manifest = readManifest(JSON.parse(await readFile(path.join(filename, 'manifest.json'), 'utf8'))); }
      catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError || error.message.startsWith('Invalid backup')) continue;
        throw error;
      }
      const timestamp = new Date(manifest.createdAt).toISOString().replace(/[-:.]/g, '');
      if (!entry.name.startsWith(`samsblog-${timestamp}-`) || Date.parse(manifest.createdAt) > cutoff) continue;
      await removeOwnedDirectory(filename, configuration.backupDirectory);
    } else if (entry.isFile() && legacyPattern.test(entry.name) && (await stat(filename)).mtimeMs <= cutoff) {
      await rm(filename);
    }
  }
}

// 独立 SQLite 排他锁随进程退出释放；随机身份把两个临时目录绑定到同一份租约。
function holdStagingLease(pinnedDirectory, identity, startedAt, dataDirectory, backupDirectory, partialName) {
  const lease = new Database(path.join(pinnedDirectory, 'lease.sqlite'));
  try {
    lease.pragma('synchronous = FULL');
    lease.exec(`CREATE TABLE backup_lease (format_version INTEGER NOT NULL, identity TEXT NOT NULL,
      started_at TEXT NOT NULL, data_directory TEXT NOT NULL, backup_directory TEXT NOT NULL, partial_name TEXT NOT NULL)`);
    lease.prepare('INSERT INTO backup_lease VALUES (1,?,?,?,?,?)').run(identity, startedAt, dataDirectory, backupDirectory, partialName);
    lease.exec('BEGIN EXCLUSIVE');
    return lease;
  } catch (error) { lease.close(); throw error; }
}

// 只清理已过期且失去系统锁的可验证残留，未知或损坏的租约保守保留。
async function pruneAbandonedSnapshots(configuration, now) {
  const cutoff = now.getTime() - configuration.retentionDays * dayMilliseconds;
  for (const entry of await readdir(configuration.dataDirectory, { withFileTypes: true })) {
    const match = stagingPattern.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const pinnedDirectory = path.join(configuration.dataDirectory, entry.name);
    const leasePath = path.join(pinnedDirectory, 'lease.sqlite');
    let lease;
    let reclaim = false;
    try {
      await assertRegularFile(leasePath);
      lease = new Database(leasePath, { fileMustExist: true, timeout: 0 });
      lease.exec('BEGIN EXCLUSIVE');
      const owner = lease.prepare('SELECT * FROM backup_lease').all();
      if (owner.length !== 1) continue;
      const record = owner[0];
      const started = Date.parse(record.started_at);
      if (record.format_version !== 1 || record.identity !== match[1] || !Number.isFinite(started)
        || record.data_directory !== configuration.dataDirectory || record.backup_directory !== configuration.backupDirectory) continue;
      const expectedPartial = `.samsblog-${new Date(started).toISOString().replace(/[-:.]/g, '')}-${record.identity}.partial`;
      if (record.partial_name !== expectedPartial || started > cutoff) continue;
      await removeOwnedDirectory(path.join(configuration.backupDirectory, expectedPartial), configuration.backupDirectory);
      reclaim = true;
    } catch (error) {
      if (['ENOENT', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) continue;
      if (['SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_ERROR'].includes(error.code)) {
        console.warn('Unverifiable backup staging lease retained', { code: error.code });
        continue;
      }
      throw error;
    } finally {
      if (lease?.inTransaction) lease.exec('ROLLBACK');
      lease?.close();
    }
    if (reclaim) {
      try { await removeOwnedDirectory(pinnedDirectory, configuration.dataDirectory); }
      catch (error) {
        if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
        console.warn('Backup staging cleanup deferred', { code: error.code });
      }
    }
  }
}

// 短写锁内固定 WAL 读快照并钉住原图；在线快照和独立复制均在写锁外完成。
export async function createBackup(configuration, options = {}) {
  const now = options.now || new Date();
  const dataDirectory = realpathSync(configuration.dataDirectory);
  mkdirSync(configuration.backupDirectory, { recursive: true, mode: 0o700 });
  const backupDirectory = realpathSync(configuration.backupDirectory);
  const databasePath = path.join(dataDirectory, 'blog.sqlite');
  await assertRegularFile(databasePath);
  const identity = randomUUID();
  const name = `samsblog-${now.toISOString().replace(/[-:.]/g, '')}-${identity}`;
  const pinnedDirectory = path.join(dataDirectory, `.samsblog-snapshot-${identity}`);
  const temporaryDirectory = path.join(backupDirectory, `.${name}.partial`);
  const destination = path.join(backupDirectory, name);
  const source = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: configuration.databaseBusyMilliseconds });
  let guard;
  let stagingLease;
  try {
    guard = new Database(databasePath, { fileMustExist: true, timeout: configuration.databaseBusyMilliseconds });
    if (source.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('Online paired backup requires WAL mode');
    mkdirSync(path.join(pinnedDirectory, 'uploads'), { recursive: true, mode: 0o700 });
    stagingLease = holdStagingLease(pinnedDirectory, identity, now.toISOString(), dataDirectory, backupDirectory, path.basename(temporaryDirectory));
    if (process.platform !== 'win32') await synchronize(pinnedDirectory);
    guard.exec('BEGIN IMMEDIATE');
    try {
      source.exec('BEGIN');
      const records = source.prepare('SELECT filename FROM blog_media').all();
      const uploadDirectory = path.join(dataDirectory, 'uploads');
      const filenames = new Set(records.map((record) => record.filename));
      try { for (const entry of readdirSync(uploadDirectory)) if (filenamePattern.test(entry)) filenames.add(entry); }
      catch (error) { if (error.code !== 'ENOENT' || filenames.size) throw error; }
      for (const filename of filenames) {
        if (!filenamePattern.test(filename)) throw new Error('Invalid registered media filename');
        const original = path.join(uploadDirectory, filename);
        const metadata = lstatSync(original);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Snapshot image is not a regular file');
        linkSync(original, path.join(pinnedDirectory, 'uploads', filename));
      }
    } finally { if (guard.inTransaction) guard.exec('COMMIT'); }
    await options.onSnapshotPinned?.();
    await mkdir(path.join(temporaryDirectory, 'uploads'), { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(temporaryDirectory, 'blog.sqlite');
    await source.backup(snapshotPath);
    source.exec('ROLLBACK');
    const snapshot = new Database(snapshotPath);
    try { snapshot.pragma('journal_mode = DELETE'); } finally { snapshot.close(); }
    const uploads = [];
    for (const filename of readdirSync(path.join(pinnedDirectory, 'uploads')).sort()) {
      const output = path.join(temporaryDirectory, 'uploads', filename);
      await copyFile(path.join(pinnedDirectory, 'uploads', filename), output);
      uploads.push({ filename, size: (await stat(output)).size, sha256: await checksum(output) });
      await synchronize(output);
    }
    await options.onSnapshotCopied?.();
    const manifest = { version: 1, createdAt: now.toISOString(), database: 'blog.sqlite', databaseSha256: await checksum(snapshotPath), uploads };
    await writeFile(path.join(temporaryDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await verifyBackup(temporaryDirectory);
    await synchronize(snapshotPath);
    await synchronize(path.join(temporaryDirectory, 'manifest.json'));
    if (process.platform !== 'win32') { await synchronize(path.join(temporaryDirectory, 'uploads')); await synchronize(temporaryDirectory); }
    await rename(temporaryDirectory, destination);
    if (process.platform !== 'win32') await synchronize(backupDirectory);
    await pruneBackups({ ...configuration, backupDirectory }, now);
    await pruneAbandonedSnapshots({ ...configuration, dataDirectory, backupDirectory }, now);
    return destination;
  } finally {
    if (source.inTransaction) source.exec('ROLLBACK');
    source.close(); guard?.close();
    try { await removeOwnedDirectory(temporaryDirectory, backupDirectory); }
    finally { stagingLease?.close(); }
    await removeOwnedDirectory(pinnedDirectory, dataDirectory);
  }
}

// 仅恢复到全新的目录，不覆盖在线数据库、WAL 或现有上传图。
export async function restoreBackup(bundle, destination) {
  const manifest = await verifyBackup(bundle);
  const target = path.resolve(destination);
  await mkdir(target, { mode: 0o700 });
  try {
    await mkdir(path.join(target, 'uploads'), { mode: 0o700 });
    await copyFile(path.join(bundle, 'blog.sqlite'), path.join(target, 'blog.sqlite'));
    for (const image of manifest.uploads) await copyFile(path.join(bundle, 'uploads', image.filename), path.join(target, 'uploads', image.filename));
    await copyFile(path.join(bundle, 'manifest.json'), path.join(target, 'manifest.json'));
    await verifyBackup(target);
    return target;
  } catch (error) {
    await removeOwnedDirectory(target, path.dirname(target));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const [command = 'backup', bundle, destination] = process.argv.slice(2);
    if (command === 'backup' && !bundle) console.log(await createBackup(readBackupConfiguration()));
    else if (command === 'verify' && bundle && !destination) { await verifyBackup(path.resolve(bundle)); console.log('备份校验通过'); }
    else if (command === 'restore' && bundle && destination) console.log(await restoreBackup(path.resolve(bundle), destination));
    else throw new Error('Usage: backup.sh [backup | verify BUNDLE | restore BUNDLE NEW_DIRECTORY]');
  } catch (error) { console.error('Backup operation failed:', error.message); process.exitCode = 1; }
}

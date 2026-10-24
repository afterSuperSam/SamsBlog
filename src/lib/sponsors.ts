import { siteConfig } from '../config/site';
import { getDatabase } from './db';
import { HttpError, readPositiveId } from './http';

export interface SponsorRecord {
  id: number; name: string; minecraftUsername: string; amount: number; updatedAt: string;
}

const sponsorColumns = 'id,name,minecraft_username AS minecraftUsername,amount_cents / 100.0 AS amount,updated_at AS updatedAt';
const minecraftUsernamePattern = /^[A-Za-z0-9_]{3,16}$/;

export function listSponsors(): SponsorRecord[] {
  return getDatabase().prepare(`SELECT ${sponsorColumns} FROM blog_sponsors WHERE deleted_at IS NULL ORDER BY amount_cents DESC,id`).all() as SponsorRecord[];
}

export function sponsorAvatarUrl(sponsor: Pick<SponsorRecord, 'name' | 'minecraftUsername'>) {
  const username = sponsor.minecraftUsername || sponsor.name;
  return minecraftUsernamePattern.test(username)
    ? `${siteConfig.sponsorPresentation.avatarBaseUrl}${encodeURIComponent(username)}/${siteConfig.sponsorPresentation.avatarSizePixels}.png` : undefined;
}

// 写入使用分保存金额；修改和软删除核对版本，避免覆盖另一后台窗口的编辑。
function editableSponsor(input: Record<string, unknown>) {
  const id = readPositiveId(input.id);
  const current = getDatabase().prepare(`SELECT ${sponsorColumns} FROM blog_sponsors WHERE id=? AND deleted_at IS NULL`).get(id) as SponsorRecord | undefined;
  if (!current) throw new HttpError(404, '赞助记录不存在');
  if (typeof input.updatedAt !== 'string' || input.updatedAt !== current.updatedAt) throw new HttpError(409, '赞助记录已变化，请刷新后台后重新编辑');
  return current;
}

export function saveSponsor(input: Record<string, unknown>): SponsorRecord {
  const fields = siteConfig.sponsorFields;
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > fields.nameMaximumLength || /[\u0000-\u001f\u007f]/.test(input.name)) throw new HttpError(400, `名称需要 1 至 ${fields.nameMaximumLength} 个字符`);
  if (typeof input.minecraftUsername !== 'string' || input.minecraftUsername.trim() && !minecraftUsernamePattern.test(input.minecraftUsername.trim())) throw new HttpError(400, '我的世界用户名需要 3 至 16 位字母、数字或下划线，也可以留空');
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < .01 || amount > fields.maximumAmount || Math.abs(amount * 100 - Math.round(amount * 100)) > .000001) throw new HttpError(400, `金额需要大于 0、不超过 ${fields.maximumAmount} 元，最多两位小数`);
  const name = input.name.trim();
  const minecraftUsername = input.minecraftUsername.trim();
  const database = getDatabase();
  return database.transaction(() => {
    const current = input.id === undefined ? undefined : editableSponsor(input);
    if (database.prepare('SELECT id FROM blog_sponsors WHERE name=? COLLATE NOCASE AND deleted_at IS NULL AND id!=?').get(name, current?.id || 0)) throw new HttpError(409, '这位赞助者已存在，请编辑原记录的累计金额');
    const now = new Date(Math.max(Date.now(), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString();
    let id = current?.id;
    if (current) database.prepare('UPDATE blog_sponsors SET name=?,minecraft_username=?,amount_cents=?,updated_at=? WHERE id=?').run(name, minecraftUsername, Math.round(amount * 100), now, id);
    else id = Number(database.prepare('INSERT INTO blog_sponsors (name,minecraft_username,amount_cents,created_at,updated_at) VALUES (?,?,?,?,?)').run(name, minecraftUsername, Math.round(amount * 100), now, now).lastInsertRowid);
    return { id: id!, name, minecraftUsername, amount: Math.round(amount * 100) / 100, updatedAt: now };
  })();
}

export function deleteSponsor(input: Record<string, unknown>) {
  const database = getDatabase();
  database.transaction(() => {
    const current = editableSponsor(input);
    const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    database.prepare('UPDATE blog_sponsors SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, current.id);
  })();
}

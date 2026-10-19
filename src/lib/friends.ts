import { getDatabase } from './db';
import { HttpError } from './http';

export interface FriendRecord {
  id: number;
  name: string;
  url: string;
  description: string;
  iconUrl: string;
  backgroundUrl: string;
  rssUrl: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FriendInput {
  id?: number;
  name: string;
  url: string;
  description: string;
  iconUrl: string;
  backgroundUrl: string;
  rssUrl: string;
  visible: boolean;
}

function mapFriend(row: Record<string, unknown>): FriendRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url),
    description: String(row.description),
    iconUrl: String(row.icon_url),
    backgroundUrl: String(row.background_url || ''),
    rssUrl: String(row.rss_url || ''),
    visible: Boolean(row.visible),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeWebUrl(value: string, field: string) {
  if (!/^https?:\/\//i.test(value.trim())) throw new HttpError(400, `${field}必须是完整的网址`);
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new HttpError(400, `${field}必须是完整的网址`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, `${field}仅支持 http 或 https`);
  if (url.username || url.password) throw new HttpError(400, `${field}不能包含账号或密码`);
  url.hash = '';
  return url.toString();
}

export function parseFriendInput(body: Record<string, unknown>): FriendInput {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (body.backgroundUrl !== undefined && typeof body.backgroundUrl !== 'string') throw new HttpError(400, '背景图片地址必须是文本');
  const backgroundUrl = typeof body.backgroundUrl === 'string' ? body.backgroundUrl.trim() : '';
  if (body.rssUrl !== undefined && typeof body.rssUrl !== 'string') throw new HttpError(400, 'RSS 地址必须是文本');
  const rssUrl = typeof body.rssUrl === 'string' ? body.rssUrl.trim() : '';
  if (body.visible !== undefined && typeof body.visible !== 'boolean') throw new HttpError(400, '公开状态必须是布尔值');
  if (name.length < 1 || name.length > 60) throw new HttpError(400, '名称需要 1 至 60 个字符');
  if (description.length < 1 || description.length > 240) throw new HttpError(400, '简介需要 1 至 240 个字符');
  return {
    id: Number.isInteger(body.id) ? Number(body.id) : undefined,
    name,
    description,
    url: normalizeWebUrl(String(body.url || ''), '地址'),
    iconUrl: normalizeWebUrl(String(body.iconUrl || ''), '图标'),
    backgroundUrl: backgroundUrl ? normalizeWebUrl(backgroundUrl, '背景图片') : '',
    rssUrl: rssUrl ? normalizeWebUrl(rssUrl, 'RSS 地址') : '',
    visible: body.visible !== false,
  };
}

export function listFriends(options: { includeHidden?: boolean } = {}) {
  const where = options.includeHidden ? 'WHERE deleted_at IS NULL' : 'WHERE visible = 1 AND deleted_at IS NULL';
  return (getDatabase().prepare(`SELECT * FROM friends ${where} ORDER BY created_at ASC, id ASC`).all() as Record<string, unknown>[]).map(mapFriend);
}

export function saveFriend(input: FriendInput) {
  const now = new Date().toISOString();
  const values = { ...input, visible: Number(input.visible), now };
  if (input.id) {
    return getDatabase().prepare(`UPDATE friends SET name=@name,url=@url,description=@description,
      icon_url=@iconUrl,background_url=@backgroundUrl,rss_url=@rssUrl,visible=@visible,updated_at=@now WHERE id=@id AND deleted_at IS NULL`).run(values).changes === 1;
  }
  return Number(getDatabase().prepare(`INSERT INTO friends
    (name,url,description,icon_url,background_url,rss_url,visible,created_at,updated_at)
    VALUES (@name,@url,@description,@iconUrl,@backgroundUrl,@rssUrl,@visible,@now,@now)`).run(values).lastInsertRowid);
}

export function deleteFriend(id: number) {
  return getDatabase().prepare('UPDATE friends SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), new Date().toISOString(), id).changes === 1;
}

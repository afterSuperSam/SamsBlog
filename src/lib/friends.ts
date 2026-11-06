import { getDatabase } from './db';
import { HttpError } from './http';
import { serverConfig } from '../config/server';
import { queueAcceptedFriendApplication, scheduleReplyNotifications } from './reply-notifications';

export type FriendGroup = 'starred' | 'recommended' | 'default' | 'lost';

export interface FriendRecord {
  id: number;
  name: string;
  url: string;
  description: string;
  iconUrl: string;
  backgroundUrl: string;
  rssUrl: string;
  visible: boolean;
  starred: boolean;
  recommended: boolean;
  group: FriendGroup;
  latestPublishedAt: string | null;
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
  starred?: boolean;
  recommended?: boolean;
}

function mapFriend(row: Record<string, unknown>): FriendRecord {
  const checkedAt = Date.parse(String(row.status_checked_at || ''));
  const statusIsCurrent = Number.isFinite(checkedAt) && checkedAt <= Date.now()
    && Date.now() - checkedAt < serverConfig.friendStatusCacheSeconds * 1000;
  const lost = statusIsCurrent && ['offline', 'restricted', 'blocked'].includes(String(row.connectivity_status));
  const publishedAt = Date.parse(String(row.latest_published_at || ''));
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url),
    description: String(row.description),
    iconUrl: String(row.icon_url),
    backgroundUrl: String(row.background_url || ''),
    rssUrl: String(row.rss_url || ''),
    visible: Boolean(row.visible),
    starred: Boolean(row.starred),
    recommended: Boolean(row.recommended),
    group: lost ? 'lost' : row.starred ? 'starred' : row.recommended ? 'recommended' : 'default',
    latestPublishedAt: Number.isFinite(publishedAt) ? new Date(publishedAt).toISOString() : null,
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
  if (body.starred !== undefined && typeof body.starred !== 'boolean') throw new HttpError(400, '星标状态必须是布尔值');
  if (body.recommended !== undefined && typeof body.recommended !== 'boolean') throw new HttpError(400, '推荐状态必须是布尔值');
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
    starred: typeof body.starred === 'boolean' ? body.starred : undefined,
    recommended: typeof body.recommended === 'boolean' ? body.recommended : undefined,
  };
}

export function listFriends(options: { includeHidden?: boolean } = {}) {
  const where = options.includeHidden ? 'WHERE friends.deleted_at IS NULL' : 'WHERE friends.visible = 1 AND friends.deleted_at IS NULL';
  const groups: Record<FriendGroup, number> = { starred: 0, recommended: 1, default: 2, lost: 3 };
  return (getDatabase().prepare(`SELECT friends.*, feeds.published_at AS latest_published_at,
      statuses.status AS connectivity_status, statuses.checked_at AS status_checked_at
    FROM friends
    LEFT JOIN friend_feed_cache AS feeds ON feeds.friend_id=friends.id AND feeds.rss_url=friends.rss_url
      AND friends.rss_url<>'' AND feeds.title<>'' AND feeds.entry_url<>''
    LEFT JOIN friend_status_cache AS statuses ON statuses.friend_id=friends.id AND statuses.url=friends.url
    ${where}`).all() as Record<string, unknown>[]).map(mapFriend).sort((left, right) =>
    groups[left.group] - groups[right.group]
    || (right.latestPublishedAt ? Date.parse(right.latestPublishedAt) : -Infinity) - (left.latestPublishedAt ? Date.parse(left.latestPublishedAt) : -Infinity)
    || left.id - right.id);
}

export function saveFriend(input: FriendInput) {
  const now = new Date().toISOString();
  const values = { ...input, visible: Number(input.visible), starred: input.starred === undefined ? null : Number(input.starred), recommended: input.recommended === undefined ? null : Number(input.recommended), now };
  if (input.id) {
    return getDatabase().prepare(`UPDATE friends SET name=@name,url=@url,description=@description,
      icon_url=@iconUrl,background_url=@backgroundUrl,rss_url=@rssUrl,visible=@visible,starred=COALESCE(@starred,starred),recommended=COALESCE(@recommended,recommended),updated_at=@now WHERE id=@id AND deleted_at IS NULL`).run(values).changes === 1;
  }
  return Number(getDatabase().prepare(`INSERT INTO friends
    (name,url,description,icon_url,background_url,rss_url,visible,starred,recommended,created_at,updated_at)
    VALUES (@name,@url,@description,@iconUrl,@backgroundUrl,@rssUrl,@visible,COALESCE(@starred,0),COALESCE(@recommended,0),@now,@now)`).run(values).lastInsertRowid);
}

export function setFriendRecommended(id: number, recommended: unknown) {
  if (typeof recommended !== 'boolean') throw new HttpError(400, '推荐状态必须是布尔值');
  return getDatabase().prepare('UPDATE friends SET recommended = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Number(recommended), new Date().toISOString(), id).changes === 1;
}

export function setFriendStarred(id: number, starred: unknown) {
  if (typeof starred !== 'boolean') throw new HttpError(400, '星标状态必须是布尔值');
  return getDatabase().prepare('UPDATE friends SET starred = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Number(starred), new Date().toISOString(), id).changes === 1;
}

export function deleteFriend(id: number) {
  return getDatabase().prepare('UPDATE friends SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), new Date().toISOString(), id).changes === 1;
}

export interface FriendApplication extends FriendInput {
  id: number;
  email: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

const applicationColumns = 'id,name,url,description,icon_url AS iconUrl,rss_url AS rssUrl,email,status,created_at AS createdAt';

export function listFriendApplications(): FriendApplication[] {
  return getDatabase().prepare(`SELECT ${applicationColumns}
    FROM friend_applications WHERE deleted_at IS NULL ORDER BY (status='pending') DESC,created_at DESC,id DESC`).all() as FriendApplication[];
}

export function createFriendApplication(input: FriendInput, email: string, fingerprint: string) {
  const database = getDatabase();
  return database.transaction(() => {
    const windowStart = new Date(Date.now() - serverConfig.friendApplicationSubmissionWindowSeconds * 1000).toISOString();
    if (database.prepare('SELECT 1 FROM friend_applications WHERE fingerprint_hash=? AND created_at>? LIMIT 1 OFFSET ?')
      .get(fingerprint, windowStart, serverConfig.friendApplicationSubmissionLimit - 1)) throw new HttpError(429, '友链申请已达提交上限，请稍后再试');
    if (database.prepare('SELECT 1 FROM friends WHERE url=? AND deleted_at IS NULL').get(input.url)
      || database.prepare("SELECT 1 FROM friend_applications WHERE url=? AND status='pending' AND deleted_at IS NULL").get(input.url)) throw new HttpError(409, '这个站点已加入友链或正在等待处理');
    const now = new Date().toISOString();
    return Number(database.prepare(`INSERT INTO friend_applications(name,url,description,icon_url,rss_url,email,fingerprint_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(input.name,input.url,input.description,input.iconUrl,input.rssUrl,email,fingerprint,now,now).lastInsertRowid);
  })();
}

export function reviewFriendApplication(id: number, accepted: boolean, changes: Record<string, unknown>) {
  const database = getDatabase();
  const queued = database.transaction(() => {
    const application = database.prepare(`SELECT ${applicationColumns} FROM friend_applications WHERE id=? AND deleted_at IS NULL`).get(id) as FriendApplication | undefined;
    if (!application || application.status !== 'pending') throw new HttpError(409, '申请不存在或已经处理，请刷新列表');
    const friendId = accepted ? Number(saveFriend(parseFriendInput({ ...application, ...changes, id: undefined, backgroundUrl: '', visible: true }))) : null;
    database.prepare('UPDATE friend_applications SET status=?,friend_id=?,updated_at=? WHERE id=?').run(accepted ? 'accepted' : 'declined', friendId, new Date().toISOString(), id);
    return accepted && queueAcceptedFriendApplication(id);
  }).immediate();
  if (queued) scheduleReplyNotifications();
}

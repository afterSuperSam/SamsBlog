import { siteConfig } from '../config/site';
import { serverConfig } from '../config/server';
import { getDatabase } from './db';
import { HttpError } from './http';

export const projectStatusLabels = { active: '活跃', maintenance: '维护', archived: '归档' } as const;
export type ProjectStatus = keyof typeof projectStatusLabels;
export interface ProjectRecord {
  id: number; repository: string; name: string; description: string; url: string; keyword: string;
  status: ProjectStatus; visible: boolean; position: number;
}

export function getProjectSettings() {
  const database = getDatabase();
  const projects = (database.prepare(`SELECT id,repository,name,description,url,keyword,status,visible,position
    FROM blog_projects WHERE deleted_at IS NULL ORDER BY position,id`).all() as Array<Omit<ProjectRecord, 'visible'> & { visible: number }> )
    .map((project) => ({ ...project, visible: Boolean(project.visible) }));
  const currentWork = database.prepare("SELECT value FROM site_settings WHERE key = 'current-work'").get() as { value: string } | undefined;
  return { currentWork: currentWork?.value ?? siteConfig.currentWork.defaultText, projects };
}

// 后台项目输入、排序和可见性在一个事务中保存。
export function saveProjectSettings(input: Record<string, unknown>) {
  if (typeof input.currentWork !== 'string' || !input.currentWork.trim() || input.currentWork.trim().length > siteConfig.currentWork.maximumLength) {
    throw new HttpError(400, `最近在做需要 1 至 ${siteConfig.currentWork.maximumLength} 个字符`);
  }
  if (!Array.isArray(input.projects)) throw new HttpError(400, '项目设置格式不正确');
  const entries = input.projects.map((value: unknown, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '项目设置格式不正确');
    const project = value as Record<string, unknown>;
    if (project.id !== undefined && (typeof project.id !== 'number' || !Number.isSafeInteger(project.id) || project.id < 1)) throw new HttpError(400, '项目编号不正确');
    if (typeof project.status !== 'string' || !Object.hasOwn(projectStatusLabels, project.status)) throw new HttpError(400, '请选择有效的项目状态');
    if (typeof project.visible !== 'boolean') throw new HttpError(400, '请选择项目是否显示');
    const text = (key: string, limit: number, label: string, optional = false) => {
      if (typeof project[key] !== 'string') throw new HttpError(400, `项目${label}格式不正确`);
      const result = project[key].trim();
      if ((!optional && !result) || result.length > limit) throw new HttpError(400, `项目${label}需要 ${optional ? 0 : 1} 至 ${limit} 个字符`);
      return result;
    };
    const name = text('name', siteConfig.projectFields.nameMaximumLength, '名称');
    const description = text('description', siteConfig.projectFields.descriptionMaximumLength, '简介');
    const keyword = text('keyword', siteConfig.projectFields.keywordMaximumLength, '关键词', true);
    const repository = text('repository', siteConfig.projectFields.repositoryMaximumLength, '仓库', true);
    if (keyword && !description.includes(keyword)) throw new HttpError(400, '项目关键词需要出现在简介中');
    if (repository && !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new HttpError(400, 'GitHub 仓库请填写 owner/repo，或留空');
    const address = text('url', siteConfig.projectFields.urlMaximumLength, '跳转地址');
    if (!/^https?:\/\//i.test(address)) throw new HttpError(400, '项目跳转地址需要完整的 http 或 https 网址');
    let url: URL;
    try { url = new URL(address); }
    catch { throw new HttpError(400, '项目跳转地址需要完整的 http 或 https 网址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, '项目跳转地址仅支持不含账号密码的 http 或 https 网址');
    return { id: project.id as number | undefined, repository, name, description, keyword, url: url.href, status: project.status, visible: Number(project.visible), position };
  });
  const ids = entries.flatMap((project) => project.id === undefined ? [] : [project.id]);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, '项目编号不能重复');
  const database = getDatabase();
  database.transaction(() => {
    const currentIds = (database.prepare('SELECT id FROM blog_projects WHERE deleted_at IS NULL').all() as Array<{ id: number }>).map((project) => project.id);
    if (ids.length !== currentIds.length || ids.some((id) => !currentIds.includes(id))) throw new HttpError(409, '项目列表已变化，请刷新后重新编辑');
    const now = new Date().toISOString();
    database.prepare("INSERT INTO site_settings (key,value) VALUES ('current-work',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run((input.currentWork as string).trim());
    const update = database.prepare(`UPDATE blog_projects SET repository=@repository,name=@name,description=@description,url=@url,
      keyword=@keyword,status=@status,visible=@visible,position=@position,updated_at=@now WHERE id=@id AND deleted_at IS NULL`);
    const create = database.prepare(`INSERT INTO blog_projects (repository,name,description,url,keyword,status,visible,position,created_at,updated_at)
      VALUES (@repository,@name,@description,@url,@keyword,@status,@visible,@position,@now,@now)`);
    for (const project of entries) {
      if (project.id === undefined) create.run({ ...project, now });
      else update.run({ ...project, now });
    }
  })();
  return getProjectSettings();
}

// 只读取后台明确公开的仓库，合并并发请求；失败保留上次有效日期。
const commits = new Map<string, { date?: string; expires: number; pending?: Promise<string | undefined> }>();
export const getCachedProjectCommit = (repository: string) => commits.get(repository)?.date;
function isVisibleRepository(repository: string) {
  return Boolean(getDatabase().prepare('SELECT 1 FROM blog_projects WHERE repository=? AND visible=1 AND deleted_at IS NULL').get(repository));
}

function listVisibleRepositories(): string[] {
  return (getDatabase().prepare(`SELECT repository FROM blog_projects
    WHERE visible=1 AND deleted_at IS NULL AND repository != ''
    GROUP BY repository ORDER BY min(position), min(id)`).all() as Array<{ repository: string }>)
    .map((project) => project.repository);
}

// 有限并发读取公开仓库日期，排队和返回时都复核可见性。
export async function getProjectCommitDates() {
  const repositories = listVisibleRepositories();
  const dates: Record<string, string | null> = Object.create(null);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(serverConfig.githubConcurrency, repositories.length) }, async () => {
    while (nextIndex < repositories.length) {
      const repository = repositories[nextIndex++];
      if (!isVisibleRepository(repository)) continue;
      dates[repository] = await getProjectCommit(repository) ?? null;
    }
  }));
  const visible = new Set(listVisibleRepositories());
  for (const repository of Object.keys(dates)) if (!visible.has(repository)) delete dates[repository];
  return dates;
}

export function getProjectCommit(repository: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
    || !isVisibleRepository(repository)) throw new Error('Unknown project repository');
  const cached = commits.get(repository);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.date);
  const entry = { date: cached?.date, expires: 0, pending: undefined as Promise<string | undefined> | undefined };
  entry.pending = (async () => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/commits?per_page=1`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SamsBlog' },
        signal: AbortSignal.timeout(serverConfig.githubTimeoutMilliseconds),
      });
      if (!response.ok) throw new Error(`GitHub commit request returned ${response.status}`);
      const records = await response.json() as { commit?: { committer?: { date?: string } } }[];
      const date = records[0]?.commit?.committer?.date;
      if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Invalid GitHub commit date');
      entry.date = new Date(date).toISOString();
      entry.expires = Date.now() + serverConfig.githubCacheSeconds * 1000;
    } catch (error) {
      console.warn(`Project commit unavailable: ${repository}`, error);
      entry.expires = Date.now() + serverConfig.githubRetrySeconds * 1000;
    } finally { entry.pending = undefined; }
    return entry.date;
  })();
  commits.set(repository, entry);
  return entry.pending;
}

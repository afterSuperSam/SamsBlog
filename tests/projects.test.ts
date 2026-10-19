import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { APIContext } from 'astro';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../src/lib/db';
import { getProjectCommit, getProjectSettings, saveProjectSettings } from '../src/lib/projects';
import { GET as publicDates } from '../src/pages/api/public/project-commits.json';

beforeAll(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'samsblog-projects-'));
  vi.stubEnv('BLOG_DATA_DIR', directory);
  const legacy = new Database(path.join(directory, 'blog.sqlite'));
  legacy.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES ('20261018-project-settings','2026-10-18'),('20261018-project-details','2026-10-18');
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO site_settings VALUES ('current-work','保留最近工作');
    CREATE TABLE project_settings (repository TEXT PRIMARY KEY,status TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL);
    INSERT INTO project_settings VALUES ('afterSuperSam/SamsTownWeb','maintenance','旧后台名称','保留后台简介','https://custom.example.com/');`);
  legacy.close();
});

describe('dynamic project management', () => {
  it('migrates the original projects and preserves admin edits and dates', () => {
    const settings = getProjectSettings();
    expect(settings.currentWork).toBe('保留最近工作');
    expect(settings.projects).toHaveLength(4);
    expect(settings.projects[0]).toMatchObject({ name: '旧后台名称', description: '保留后台简介', url: 'https://custom.example.com/', status: 'maintenance', keyword: '', visible: true });
    expect(settings.projects.every((project) => Number.isSafeInteger(project.id))).toBe(true);
    expect(getDatabase().prepare('SELECT name FROM project_settings WHERE repository=?').get('afterSuperSam/SamsTownWeb')).toEqual({ name: '旧后台名称' });
  });

  it('adds non-GitHub projects, hides and reorders projects without replacing their identities', () => {
    const before = getProjectSettings();
    const original = before.projects[0];
    const added = { repository: '', name: '小工具', description: '日常小工具', keyword: '工具', url: 'https://tools.example.com', status: 'active', visible: true };
    const projects = [added, ...before.projects.slice(1), { ...original, visible: false }];
    const saved = saveProjectSettings({ currentWork: before.currentWork, projects });
    expect(saved.projects).toHaveLength(5);
    expect(saved.projects[0]).toMatchObject({ ...added, url: 'https://tools.example.com/', position: 0, id: expect.any(Number) });
    expect(saved.projects.at(-1)).toMatchObject({ id: original.id, visible: false, position: 4 });
    saveProjectSettings(saved);
    expect(getProjectSettings().projects).toHaveLength(5);
  });

  it('rejects stale lists and invalid repositories, keywords and addresses atomically', () => {
    const before = getProjectSettings();
    const first = before.projects[0];
    for (const patch of [{ id: 123456 }, { id: 1.5 }, { repository: 'https://github.com/a/b' }, { repository: '../commits' }, { keyword: '简介中没有这个词' }, { visible: 1 }, { url: 'javascript:alert(1)' }, { url: 'https:example.com/project' }, { url: 'https://user:pass@example.com/' }]) {
      expect(() => saveProjectSettings({ ...before, currentWork: '不得写入', projects: [{ ...first, ...patch }, ...before.projects.slice(1)] })).toThrow();
    }
    expect(() => saveProjectSettings({ ...before, projects: before.projects.slice(1) })).toThrow('项目列表已变化');
    expect(() => saveProjectSettings({ ...before, projects: [...before.projects, first] })).toThrow('项目编号不能重复');
    expect(getProjectSettings()).toEqual(before);
  });

  it('never fetches arbitrary, hidden or deleted repositories through public dates', async () => {
    const before = getProjectSettings();
    const saved = saveProjectSettings({ ...before, projects: before.projects.map((project) => ({ ...project, visible: false })) });
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ commit: { committer: { date: '2026-10-18T00:00:00Z' } } }])));
    vi.stubGlobal('fetch', request);
    try {
      expect(() => getProjectCommit('other/unknown')).toThrow('Unknown project repository');
      expect(() => getProjectCommit('afterSuperSam/SamsBlog')).toThrow('Unknown project repository');
      let response = await publicDates({} as APIContext) as Response;
      expect(await response.json()).toEqual({});
      expect(request).not.toHaveBeenCalled();
      const projects = saved.projects.map((project) => ({ ...project, visible: project.repository === 'afterSuperSam/SamsBlog' }));
      saveProjectSettings({ ...saved, projects });
      response = await publicDates({} as APIContext) as Response;
      expect(await response.json()).toEqual({ 'afterSuperSam/SamsBlog': '2026-10-18T00:00:00.000Z' });
      expect(request).toHaveBeenCalledTimes(1);
      const project = projects.find((item) => item.repository === 'afterSuperSam/SamsBlog')!;
      getDatabase().prepare('UPDATE blog_projects SET deleted_at=? WHERE id=?').run(new Date().toISOString(), project.id);
      expect(() => getProjectCommit(project.repository)).toThrow('Unknown project repository');
      expect(getProjectSettings().projects.some((item) => item.id === project.id)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('skips projects hidden during an earlier request and excludes newly hidden results', async () => {
    const before = getProjectSettings();
    const candidates = before.projects.filter((project) => project.repository).slice(0, 2);
    const saved = saveProjectSettings({ ...before, projects: before.projects.map((project) => ({ ...project, visible: candidates.some((candidate) => candidate.id === project.id) })) });
    const request = vi.fn().mockImplementation(async () => {
      getDatabase().prepare('UPDATE blog_projects SET visible=0 WHERE id IN (?,?)').run(candidates[0]!.id, candidates[1]!.id);
      return new Response(JSON.stringify([{ commit: { committer: { date: '2026-10-18T00:00:00Z' } } }]));
    });
    vi.stubGlobal('fetch', request);
    try {
      const response = await publicDates({} as APIContext) as Response;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![0]).toContain(`/repos/${candidates[0]!.repository}/commits`);
      expect(() => getProjectCommit(candidates[1]!.repository)).toThrow('Unknown project repository');
    } finally {
      vi.unstubAllGlobals();
      saveProjectSettings({ ...saved, projects: before.projects });
    }
  });
});

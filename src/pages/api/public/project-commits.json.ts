import { getProjectCommit, getProjectSettings } from '../../../lib/projects';
import { json, route } from '../../../lib/http';

export const GET = route(async () => {
  const dates: Record<string, string | null> = Object.create(null);
  const repositories = new Set(getProjectSettings().projects.filter((project) => project.visible && project.repository).map((project) => project.repository));
  for (const repository of repositories) {
    if (!getProjectSettings().projects.some((project) => project.visible && project.repository === repository)) continue;
    dates[repository] = await getProjectCommit(repository) ?? null;
  }
  const visible = new Set(getProjectSettings().projects.filter((project) => project.visible).map((project) => project.repository));
  for (const repository of Object.keys(dates)) if (!visible.has(repository)) delete dates[repository];
  return json(dates);
});

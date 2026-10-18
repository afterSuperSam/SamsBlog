import { adminRoute, json, readJsonObject } from '../../../lib/http';
import { getProjectSettings, saveProjectSettings } from '../../../lib/projects';

export const GET = adminRoute(() => json(getProjectSettings()));
export const PUT = adminRoute(async ({ request }) => json(saveProjectSettings(await readJsonObject(request))));
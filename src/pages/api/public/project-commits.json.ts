import { getProjectCommitDates } from '../../../lib/projects';
import { json, route } from '../../../lib/http';

export const GET = route(async () => {
  return json(await getProjectCommitDates());
});

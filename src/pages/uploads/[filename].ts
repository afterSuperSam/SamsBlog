import { route } from '../../lib/http';
import { mediaResponse } from '../../lib/media';

export const GET = route(({ params, request }) => mediaResponse(params.filename || '', request));
export const HEAD = GET;

import { route } from '../../../../../lib/http';
import { readerOAuthCallback } from '../../../../../lib/reader-oauth';

export const GET = route(({ url, cookies }) => readerOAuthCallback('google', { url, cookies }));

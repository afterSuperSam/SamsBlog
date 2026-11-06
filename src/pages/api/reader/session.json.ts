import { json, route } from '../../../lib/http';
import { getReaderAuthOptions, readReaderSession } from '../../../lib/readers';

export const GET = route(({ cookies }) => {
  const response = json({ reader: readReaderSession(cookies), options: getReaderAuthOptions() });
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
});

import { json, route } from '../../../lib/http';
import { getReaderAuthOptions, readReaderSession, readerAuthenticatedAt } from '../../../lib/readers';

export const GET = route(({ cookies }) => {
  const reader = readReaderSession(cookies);
  const response = json({ reader, options: getReaderAuthOptions(), authenticatedAt: reader ? readerAuthenticatedAt(cookies) : null });
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
});

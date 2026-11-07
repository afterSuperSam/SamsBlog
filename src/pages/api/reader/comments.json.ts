import { json, readPositiveId } from '../../../lib/http';
import { listReaderComments, readerAccountRoute, requireReaderAccount } from '../../../lib/reader-account';

export const GET = readerAccountRoute(({ cookies, url }) => {
  const reader = requireReaderAccount(cookies);
  const page = url.searchParams.has('page') ? readPositiveId(Number(url.searchParams.get('page'))) : 1;
  return json(listReaderComments(reader.id, page));
});

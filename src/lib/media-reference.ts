import type { MediaReference } from './media';

export type MediaReferenceTarget = Pick<MediaReference, 'articleId' | 'draftId' | 'location' | 'filename'>;

export function mediaReferenceUrl(reference: MediaReferenceTarget) {
  const parameters = new URLSearchParams({ media: reference.filename, location: reference.location });
  if (reference.articleId) parameters.set('article', String(reference.articleId));
  if (reference.draftId) parameters.set('draft', reference.draftId);
  return `/admin/articles?${parameters}`;
}

export function mediaReferenceSelection(content: string, filename: string): [number, number] {
  const pattern = Array.from(filename, (character) => `(?:${character === '.' ? '\\.' : character}|%${character.charCodeAt(0).toString(16)})`).join('');
  const match = new RegExp(pattern, 'i').exec(content);
  return match ? [match.index, match.index + match[0].length] : [0, 0];
}

// 独立媒体页只传定位信息，文章权限和当前内容仍由管理接口确认。
export function parseMediaReference(parameters: URLSearchParams): MediaReferenceTarget | null {
  const filename = parameters.get('media') || '';
  const location = parameters.get('location');
  const articleId = parameters.has('article') ? Number(parameters.get('article')) : null;
  const draftId = parameters.get('draft') || undefined;
  if (!/^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(filename) || (location !== 'body' && location !== 'cover')
    || (articleId !== null && (!Number.isSafeInteger(articleId) || articleId <= 0))
    || (draftId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(draftId))
    || (!articleId && !draftId)) return null;
  return { filename, location, articleId, draftId };
}

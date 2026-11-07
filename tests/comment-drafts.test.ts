import { afterEach, describe, expect, it, vi } from 'vitest';
import { commentDraftKey, createCommentDraftStore, initializeCommentDraft, parseCommentDrafts } from '../src/lib/comment-drafts';
import { siteConfig } from '../src/config/site';

const storage = () => {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('comment body drafts', () => {
  it('isolates reader, anonymous, article, reply and administrator namespaces', () => {
    const memory = storage(); const store = createCommentDraftStore(memory, () => 100);
    const targets = [['anonymous', 'guestbook:root'], ['reader:1', 'guestbook:root'], ['reader:2', 'guestbook:root'], ['reader:1', 'article:2:root'], ['reader:1', 'article:2:reply:3:4']];
    targets.forEach(([identity, target], index) => store.save(commentDraftKey(identity, target), `正文${index}`));
    targets.forEach(([identity, target], index) => expect(store.read(commentDraftKey(identity, target))).toBe(`正文${index}`));
    const admin = createCommentDraftStore(memory, () => 100, `${siteConfig.commentDrafts.storageKey}:admin`);
    admin.save(commentDraftKey('admin', 'message:3:root'), '站长回复');
    expect(store.read('admin/message:3:root')).toBe('');
    expect(commentDraftKey('anonymous', 'message:3:root')).toBe('');
  });
  it('only clears the successful snapshot and keeps newer edits or another reply', () => {
    const store = createCommentDraftStore(storage(), () => 100);
    const key = 'reader:1/article:2:root';
    store.save(key, '提交时正文');
    const submitted = { key, content: store.read(key) };
    store.save(key, '等待期间继续写');
    expect(store.complete(submitted)).toBe(false);
    expect(store.read(key)).toBe('等待期间继续写');
    store.save('reader:1/article:2:reply:3:4', '另一个回复');
    expect(store.complete({ key, content: '等待期间继续写' })).toBe(true);
    expect(store.read('reader:1/article:2:reply:3:4')).toBe('另一个回复');
  });
  it('rejects invalid, expired and oversized records and never retains extra profile fields', () => {
    const key = 'anonymous/guestbook:root'; const now = 8 * 86400000;
    expect(parseCommentDrafts('{')).toEqual({});
    expect(parseCommentDrafts(JSON.stringify({ '': { content: 'bad', updatedAt: now } }), now)).toEqual({});
    expect(parseCommentDrafts(JSON.stringify({ [key]: { content: '旧草稿', updatedAt: 1 } }), now)).toEqual({});
    const store = createCommentDraftStore(storage(), () => now);
    store.save(key, '正文'); expect(store.read(key)).toBe('正文');
    expect(parseCommentDrafts(JSON.stringify({ [key]: { content: 'x'.repeat(1001), updatedAt: now } }), now)).toEqual({});
    expect(parseCommentDrafts(JSON.stringify({ [key]: { content: '正文', updatedAt: now, email: 'private@example.test' } }), now)).toEqual({ [key]: { content: '正文', updatedAt: now } });
  });
  it('restores after refresh, isolates identity switching, preserves IME and late responses', () => {
    const local = storage(); const session = storage();
    const documentTarget = Object.assign(new EventTarget(), { hidden: false, createElement: () => ({ className: '', textContent: '', setAttribute() {}, remove() {} }) });
    vi.stubGlobal('document', documentTarget); vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session);
    const field = Object.assign(new EventTarget(), { value: '', closest: () => ({ after() {} }) }) as unknown as HTMLTextAreaElement;
    let draft = initializeCommentDraft(field, 'article:2', null);
    field.value = '匿名草稿'; field.dispatchEvent(new Event('input'));
    draft.switchTarget('article:2:reply:3:4'); field.value = '回复草稿'; field.dispatchEvent(new Event('input'));
    draft.destroy(); draft = initializeCommentDraft(field, 'article:2', null);
    expect(draft.target).toBe('article:2:reply:3:4'); expect(field.value).toBe('回复草稿');
    const submitted = draft.capture();
    draft.switchIdentity(5); expect(field.value).toBe('');
    field.value = '读者正文'; field.dispatchEvent(new Event('input'));
    expect(draft.complete(submitted)).toBe(false); expect(field.value).toBe('读者正文');
    const readerSubmitted = draft.capture(); field.dispatchEvent(new Event('compositionstart'));
    expect(draft.complete(readerSubmitted)).toBe(false); expect(field.value).toBe('读者正文');
    field.dispatchEvent(new Event('compositionend'));
    expect(draft.complete(readerSubmitted)).toBe(true); expect(field.value).toBe('');
    draft.switchIdentity(null); draft.switchTarget('article:2:root'); expect(field.value).toBe('匿名草稿');
    draft.destroy();
  });
});

import { siteConfig } from '../config/site';

interface Draft { content: string; updatedAt: number }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface DraftSnapshot { key: string; content: string }
const settings = siteConfig.commentDrafts;
const validTarget = (value: string) => /^(?:guestbook|article:[1-9]\d*|message:[1-9]\d*):(?:root|reply:[1-9]\d*:[1-9]\d*)$/.test(value);
export const commentDraftIdentity = (readerId: number | null | 'admin') => readerId === 'admin' ? 'admin' : Number.isSafeInteger(readerId) && Number(readerId) > 0 ? `reader:${readerId}` : 'anonymous';
export const commentDraftKey = (identity: string, target: string) => /^(?:anonymous|admin|reader:[1-9]\d*)$/.test(identity) && validTarget(target) && (identity === 'admin') === target.startsWith('message:') ? `${identity}/${target}` : '';

// 正文草稿只保存目标、身份编号和文字；每次合并最新存储，避免旧请求抹掉新的输入。
export function parseCommentDrafts(raw: string | null, now = Date.now()): Record<string, Draft> {
  if (!raw || raw.length > settings.maximumEntries * (settings.maximumCharacters * 6 + 200)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => {
    const [identity, target] = key.split('/');
    return Boolean(key) && key === commentDraftKey(identity || '', target || '') && value && typeof value.content === 'string'
      && value.content.length <= settings.maximumCharacters && !value.content.includes('\0')
      && Number.isFinite(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt < settings.lifetimeDays * 86400000;
  }).sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, settings.maximumEntries)
    .map(([key, value]) => [key, { content: value.content, updatedAt: value.updatedAt }]));
}

export function createCommentDraftStore(storage: DraftStorage, now = () => Date.now(), namespace: string = settings.storageKey) {
  const read = () => parseCommentDrafts(storage.getItem(namespace), now());
  const write = (entries: Record<string, Draft>) => storage.setItem(namespace, JSON.stringify(parseCommentDrafts(JSON.stringify(entries), now())));
  return {
    read: (key: string) => read()[key]?.content || '',
    save: (key: string, content: string) => {
      const entries = read();
      if (content) entries[key] = { content: content.slice(0, settings.maximumCharacters), updatedAt: now() };
      else delete entries[key];
      write(entries);
    },
    complete: (snapshot: DraftSnapshot) => {
      const entries = read();
      if (entries[snapshot.key]?.content !== snapshot.content) return false;
      delete entries[snapshot.key]; write(entries); return true;
    },
  };
}

export function initializeCommentDraft(textarea: HTMLTextAreaElement | HTMLInputElement, scope: string, readerId: number | null | 'admin') {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let identity = commentDraftIdentity(readerId);
  let target = `${scope}:root`;
  let composing = false;
  let restoring = false;
  let available = true;
  const notice = document.createElement('small');
  notice.className = 'comment-draft-status'; notice.setAttribute('role', 'status');
  (textarea.closest('label') || textarea).after(notice);
  const storage: DraftStorage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
  const namespace = readerId === 'admin' ? `${settings.storageKey}:admin` : settings.storageKey;
  const store = createCommentDraftStore(storage, undefined, namespace);
  const attempt = <T>(action: () => T, fallback: T): T => {
    if (!available) return fallback;
    try { return action(); } catch (error) { available = false; notice.textContent = '浏览器无法保存正文草稿，离开前请保留输入。'; console.warn('Comment draft storage unavailable', error); return fallback; }
  };
  const key = () => commentDraftKey(identity, target);
  const activeKey = () => `${namespace}:active:${identity}:${scope}`;
  const persist = () => { if (!restoring) attempt(() => store.save(key(), textarea.value), undefined); };
  const restore = () => {
    restoring = true;
    textarea.value = attempt(() => store.read(key()), '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    restoring = false;
  };
  const restoreTarget = () => {
    const saved = attempt(() => sessionStorage.getItem(activeKey()), null);
    target = saved && saved.startsWith(`${scope}:`) && validTarget(saved) ? saved : `${scope}:root`;
    restore();
  };
  textarea.addEventListener('input', persist, options);
  textarea.addEventListener('compositionstart', () => { composing = true; }, options);
  textarea.addEventListener('compositionend', () => { composing = false; persist(); }, options);
  window.addEventListener('pagehide', persist, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); }, options);
  restoreTarget();
  return {
    get target() { return target; },
    get composing() { return composing; },
    switchTarget: (next: string) => {
      if (next === target || !next.startsWith(`${scope}:`) || !validTarget(next)) return;
      persist(); target = next;
      attempt(() => sessionStorage.setItem(activeKey(), target), undefined); restore();
    },
    switchIdentity: (nextReaderId: number | null) => {
      const next = commentDraftIdentity(nextReaderId); if (next === identity) return;
      persist(); identity = next; restoreTarget();
    },
    capture: (): DraftSnapshot => { persist(); return { key: key(), content: textarea.value }; },
    complete: (snapshot: DraftSnapshot) => {
      attempt(() => store.complete(snapshot), false);
      if (snapshot.key !== key() || composing || textarea.value !== snapshot.content) return false;
      textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true })); return true;
    },
    destroy: () => { persist(); controller.abort(); notice.remove(); },
  };
}

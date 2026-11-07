import { siteConfig } from '../config/site';

interface SubmissionState { notifyReply: boolean; quoteMessageId: number | null; quoteContent: string }
interface Draft { content: string; updatedAt: number; operationId?: string; requestHash?: string; submissionState?: SubmissionState }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface DraftSnapshot { key: string; content: string; operationId?: string }
const settings = siteConfig.commentDrafts;
const validTarget = (value: string) => /^(?:guestbook|article:[1-9]\d*|message:[1-9]\d*):(?:root|reply:[1-9]\d*:[1-9]\d*)$/.test(value);
export const commentDraftIdentity = (readerId: number | null | 'admin') => readerId === 'admin' ? 'admin' : Number.isSafeInteger(readerId) && Number(readerId) > 0 ? `reader:${readerId}` : 'anonymous';
export const commentDraftKey = (identity: string, target: string) => /^(?:anonymous|admin|reader:[1-9]\d*)$/.test(identity) && validTarget(target) && (identity === 'admin') === target.startsWith('message:') ? `${identity}/${target}` : '';

// 正文草稿仅保存目标、身份、文字及提交编号与摘要；每次合并最新存储，避免旧请求抹掉新的输入。
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
    .map(([key, value]) => [key, { content: value.content, updatedAt: value.updatedAt,
      ...(typeof value.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(value.operationId) ? { operationId: value.operationId,
        ...(typeof value.requestHash === 'string' && /^[a-f0-9]{64}$/.test(value.requestHash) ? { requestHash: value.requestHash } : {}) } : {}),
      ...(value.submissionState && typeof value.submissionState.notifyReply === 'boolean'
        && (value.submissionState.quoteMessageId === null || (Number.isSafeInteger(value.submissionState.quoteMessageId) && value.submissionState.quoteMessageId > 0))
        && typeof value.submissionState.quoteContent === 'string' && value.submissionState.quoteContent.length <= settings.maximumCharacters
        ? { submissionState: { notifyReply: value.submissionState.notifyReply, quoteMessageId: value.submissionState.quoteMessageId, quoteContent: value.submissionState.quoteContent } } : {}),
    }]));
}

export function createCommentDraftStore(storage: DraftStorage, now = () => Date.now(), namespace: string = settings.storageKey) {
  const read = () => parseCommentDrafts(storage.getItem(namespace), now());
  const write = (entries: Record<string, Draft>) => storage.setItem(namespace, JSON.stringify(parseCommentDrafts(JSON.stringify(entries), now())));
  return {
    read: (key: string) => read()[key]?.content || '',
    submissionState: (key: string) => read()[key]?.submissionState,
    save: (key: string, content: string) => {
      const entries = read();
      if (content) entries[key] = { content: content.slice(0, settings.maximumCharacters), updatedAt: now(), ...(entries[key]?.content === content && entries[key]?.operationId ? { operationId: entries[key].operationId, requestHash: entries[key].requestHash, submissionState: entries[key].submissionState } : {}) };
      else delete entries[key];
      write(entries);
    },
    capture: (key: string, content: string, requestHash?: string, submissionState?: SubmissionState): DraftSnapshot => {
      const entries = read();
      const operationId = entries[key]?.content === content && entries[key].operationId && entries[key].requestHash === requestHash ? entries[key].operationId! : crypto.randomUUID();
      if (!entries[key] || entries[key].content === content) { entries[key] = { content, operationId, requestHash, submissionState, updatedAt: now() }; write(entries); }
      return { key, content, operationId };
    },
    complete: (snapshot: DraftSnapshot) => {
      const entries = read();
      if (entries[snapshot.key]?.content !== snapshot.content || (snapshot.operationId && entries[snapshot.key]?.operationId !== snapshot.operationId)) return false;
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
    const submissionState = attempt(() => store.submissionState(key()), undefined);
    const notificationOption = textarea.form?.elements.namedItem('notifyReply') as HTMLInputElement | null;
    if (submissionState && notificationOption) notificationOption.checked = submissionState.notifyReply;
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
    get submissionState() { return attempt(() => store.submissionState(key()), undefined); },
    switchTarget: (next: string) => {
      if (next === target || !next.startsWith(`${scope}:`) || !validTarget(next)) return;
      persist(); target = next;
      attempt(() => sessionStorage.setItem(activeKey(), target), undefined); restore();
    },
    switchIdentity: (nextReaderId: number | null) => {
      const next = commentDraftIdentity(nextReaderId); if (next === identity) return;
      persist(); identity = next; restoreTarget();
    },
    capture: (): DraftSnapshot => { persist(); return attempt(() => store.capture(key(), textarea.value), { key: key(), content: textarea.value, operationId: crypto.randomUUID() }); },
    captureSubmission: async (payload: { notifyReply: boolean; quoteMessageId?: number | null; quoteContent?: string }): Promise<DraftSnapshot> => {
      persist();
      const capturedKey = key(); const capturedContent = textarea.value;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
      const requestHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      const submissionState = { notifyReply: payload.notifyReply, quoteMessageId: payload.quoteMessageId ?? null, quoteContent: payload.quoteContent || '' };
      return attempt(() => store.capture(capturedKey, capturedContent, requestHash, submissionState), { key: capturedKey, content: capturedContent, operationId: crypto.randomUUID() });
    },
    complete: (snapshot: DraftSnapshot) => {
      if (snapshot.key === key() && composing) return false;
      const completed = attempt(() => store.complete(snapshot), true);
      if (!completed || snapshot.key !== key() || composing || textarea.value !== snapshot.content) return false;
      textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true })); return true;
    },
    destroy: () => { persist(); controller.abort(); notice.remove(); },
  };
}

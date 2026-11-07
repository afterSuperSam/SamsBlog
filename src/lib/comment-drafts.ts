import { siteConfig } from '../config/site';

interface SubmissionState { notifyReply: boolean; quoteMessageId: number | null; quoteContent: string }
interface Draft { content: string; updatedAt: number; operationId?: string; requestHash?: string; submissionState?: SubmissionState }
interface PendingSubmission { operationId: string; updatedAt: number }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface DraftSnapshot { key: string; content: string; operationId?: string; requestHash?: string }
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

// 未决提交独立于可变正文；按标签页保存完整请求摘要，刷新可重试，其他标签不能撤销。
function parsePendingSubmissions(raw: string | null, now: number): Record<string, PendingSubmission> {
  if (!raw || raw.length > settings.maximumEntries * (settings.maximumCharacters * 6 + 200)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => {
    const [identity, target, requestHash] = key.split('/');
    const draftKey = commentDraftKey(identity || '', target || '');
    return Boolean(draftKey) && key === `${draftKey}/${requestHash}` && /^[a-f0-9]{64}$/.test(requestHash || '')
      && value && typeof value.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(value.operationId)
      && Number.isFinite(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt < settings.lifetimeDays * 86400000;
  }).sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, settings.maximumEntries)
    .map(([key, value]) => [key, { operationId: value.operationId, updatedAt: value.updatedAt }]));
}

export function createCommentDraftStore(storage: DraftStorage, now = () => Date.now(), namespace: string = settings.storageKey, pendingStorage: DraftStorage = storage) {
  const read = () => parseCommentDrafts(storage.getItem(namespace), now());
  const write = (entries: Record<string, Draft>) => storage.setItem(namespace, JSON.stringify(parseCommentDrafts(JSON.stringify(entries), now())));
  const pendingNamespace = `${namespace}:pending`;
  const readPending = () => parsePendingSubmissions(pendingStorage.getItem(pendingNamespace), now());
  const writePending = (entries: Record<string, PendingSubmission>) => pendingStorage.setItem(pendingNamespace, JSON.stringify(parsePendingSubmissions(JSON.stringify(entries), now())));
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
      const rawPending = requestHash ? pendingStorage.getItem(pendingNamespace) : null;
      const pending = parsePendingSubmissions(rawPending, now());
      const pendingKey = requestHash ? `${key}/${requestHash}` : '';
      const previousOperationId = (!requestHash || rawPending === null) && entries[key]?.content === content && entries[key].requestHash === requestHash ? entries[key].operationId : undefined;
      const operationId = pending[pendingKey]?.operationId || previousOperationId || crypto.randomUUID();
      if (pendingKey) { pending[pendingKey] = { operationId, updatedAt: now() }; writePending(pending); }
      if (!entries[key] || entries[key].content === content) { entries[key] = { content, operationId, requestHash, submissionState, updatedAt: now() }; write(entries); }
      return { key, content, operationId, ...(requestHash ? { requestHash } : {}) };
    },
    complete: (snapshot: DraftSnapshot, preserveContent = false) => {
      if (snapshot.requestHash) {
        const pending = readPending();
        const pendingKey = `${snapshot.key}/${snapshot.requestHash}`;
        if (pending[pendingKey]?.operationId === snapshot.operationId) { delete pending[pendingKey]; writePending(pending); }
      }
      const entries = read();
      if (entries[snapshot.key]?.content !== snapshot.content || (snapshot.operationId && entries[snapshot.key]?.operationId !== snapshot.operationId)) return false;
      if (preserveContent) {
        if (snapshot.requestHash) {
          entries[snapshot.key] = { content: entries[snapshot.key].content, updatedAt: now(), submissionState: entries[snapshot.key].submissionState };
          write(entries);
        }
        return false;
      }
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
  let storageFailureReported = false;
  const notice = document.createElement('small');
  notice.className = 'comment-draft-status'; notice.setAttribute('role', 'status');
  (textarea.closest('label') || textarea).after(notice);
  const reportStorageFailure = (error: unknown) => {
    if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(error.name)) throw error;
    notice.textContent = '浏览器无法保存正文草稿，离开前请保留输入。';
    if (!storageFailureReported) console.warn('Comment draft storage unavailable', error);
    storageFailureReported = true;
  };
  // 两种存储分别降级读写；未落盘的值留在内存，不让后续失败替换已选的提交编号。
  const createResilientStorage = (backing: DraftStorage): DraftStorage => {
    const memory = new Map<string, string | null>();
    const pendingWrites = new Set<string>();
    let readable = true; let writable = true;
    return {
      getItem: (key) => {
        if (!readable || pendingWrites.has(key)) return memory.get(key) ?? null;
        try { const value = backing.getItem(key); memory.set(key, value); return value; }
        catch (error) { reportStorageFailure(error); readable = false; return memory.get(key) ?? null; }
      },
      setItem: (key, value) => {
        memory.set(key, value); pendingWrites.add(key);
        if (!writable) return;
        try { backing.setItem(key, value); pendingWrites.delete(key); }
        catch (error) { reportStorageFailure(error); writable = false; }
      },
    };
  };
  const storage = createResilientStorage({ getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
  const pendingStorage = createResilientStorage({ getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) });
  const namespace = readerId === 'admin' ? `${settings.storageKey}:admin` : settings.storageKey;
  const store = createCommentDraftStore(storage, undefined, namespace, pendingStorage);
  const key = () => commentDraftKey(identity, target);
  const activeKey = () => `${namespace}:active:${identity}:${scope}`;
  const persist = () => { if (!restoring) store.save(key(), textarea.value); };
  const restore = () => {
    restoring = true;
    textarea.value = store.read(key());
    const submissionState = store.submissionState(key());
    const notificationOption = textarea.form?.elements.namedItem('notifyReply') as HTMLInputElement | null;
    if (submissionState && notificationOption) notificationOption.checked = submissionState.notifyReply;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    restoring = false;
  };
  const restoreTarget = () => {
    const saved = pendingStorage.getItem(activeKey());
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
    get submissionState() { return store.submissionState(key()); },
    switchTarget: (next: string) => {
      if (next === target || !next.startsWith(`${scope}:`) || !validTarget(next)) return;
      persist(); target = next;
      pendingStorage.setItem(activeKey(), target); restore();
    },
    switchIdentity: (nextReaderId: number | null) => {
      const next = commentDraftIdentity(nextReaderId); if (next === identity) return;
      persist(); identity = next; restoreTarget();
    },
    capture: (): DraftSnapshot => { persist(); return store.capture(key(), textarea.value); },
    captureSubmission: async <SubmissionPayload extends { notifyReply: boolean; quoteMessageId?: number | null; quoteContent?: string }>(payload: SubmissionPayload): Promise<DraftSnapshot> => {
      persist();
      const capturedKey = key(); const capturedContent = textarea.value;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
      const requestHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      const submissionState = { notifyReply: payload.notifyReply, quoteMessageId: payload.quoteMessageId ?? null, quoteContent: payload.quoteContent || '' };
      return store.capture(capturedKey, capturedContent, requestHash, submissionState);
    },
    complete: (snapshot: DraftSnapshot) => {
      const completed = store.complete(snapshot, snapshot.key === key() && composing);
      if (!completed || snapshot.key !== key() || composing || textarea.value !== snapshot.content) return false;
      textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true })); return true;
    },
    destroy: () => { persist(); controller.abort(); notice.remove(); },
  };
}

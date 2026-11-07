import { requestJson, RequestError } from './client-request';
import { readerMethodLabel, type ReaderIdentity } from './reader-menu';

interface ReaderPasskey { id: number; label: string; createdAt: string; lastUsedAt: string | null }
interface ReaderAccount { error?: string; reader: ReaderIdentity & { websiteUrl: string; createdAt: string }; commentCount: number; passkeys: ReaderPasskey[] }
interface ReaderCommentPage { error?: string; comments: Array<{ id: number; content: string; createdAt: string; status: string; articleId: number | null; articleTitle: string | null; parentId: number | null; url: string | null }>; page: number; pageSize: number; total: number }

// 账号页保留当前输入，身份切换先清空私有记录，再读取新账号。
export function initializeReaderAccount() {
  const root = document.querySelector<HTMLElement>('[data-reader-account-page]');
  if (!root) return;
  const query = <Type extends HTMLElement>(selector: string) => root.querySelector<Type>(selector)!;
  const profileForm = query<HTMLFormElement>('[data-account-profile]');
  const name = profileForm.elements.namedItem('displayName') as HTMLInputElement;
  const website = profileForm.elements.namedItem('websiteUrl') as HTMLInputElement;
  const passkeyForm = query<HTMLFormElement>('[data-passkey-add]');
  const label = passkeyForm.elements.namedItem('label') as HTMLInputElement;
  const profileFeedback = query<HTMLElement>('[data-profile-feedback]');
  const passkeyFeedback = query<HTMLElement>('[data-passkey-feedback]');
  const feedback = query<HTMLElement>('[data-account-feedback]');
  const commentFeedback = query<HTMLElement>('[data-comments-feedback]');
  const previous = query<HTMLButtonElement>('[data-comments-previous]');
  const next = query<HTMLButtonElement>('[data-comments-next]');
  let identityId = Number(root.dataset.readerId) || null;
  let account: ReaderAccount | undefined;
  let mutation = false;
  let loadingComments = false;
  let page = 1;
  let totalPages = 1;
  let accountGeneration = 0;
  let commentsGeneration = 0;
  let confirmedRemoval: number | null = null;
  let loadingAccount: Promise<void> | undefined;
  const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未使用';
  const element = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const openLogin = (reauthenticate = false) => document.dispatchEvent(new CustomEvent('reader:open', { detail: { reauthenticate } }));
  query('[data-account-login]').addEventListener('click', () => openLogin());
  const controls = () => {
    profileForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach((control) => { control.disabled = mutation || !account; });
    passkeyForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach((control) => { control.disabled = mutation || !account || !window.PublicKeyCredential; });
    query('[data-account-passkeys]').querySelectorAll<HTMLButtonElement>('button').forEach((control) => { control.disabled = mutation || !account; });
    previous.disabled = mutation || loadingComments || !account || page <= 1;
    next.disabled = mutation || loadingComments || !account || page >= totalPages;
    root.setAttribute('aria-busy', String(mutation));
  };
  const clearIdentity = (readerId: number | null) => {
    identityId = readerId; account = undefined; accountGeneration++; commentsGeneration++; loadingComments = false;
    query('[data-account-passkeys]').replaceChildren(); query('[data-account-comments]').replaceChildren();
    profileForm.reset(); name.value = ''; website.value = ''; label.value = '';
    profileFeedback.textContent = passkeyFeedback.textContent = commentFeedback.textContent = '';
    query('[data-comments-page]').textContent = '—'; page = 1; totalPages = 1;
    query('[data-account-name]').textContent = ''; query('[data-account-method]').textContent = '';
    query('[data-account-created]').textContent = '—'; query('[data-account-comment-count]').textContent = '—';
    const avatar = query<HTMLImageElement>('[data-account-avatar]'); avatar.hidden = true; avatar.removeAttribute('src');
    query('[data-account-content]').hidden = !readerId; query('[data-account-signed-out]').hidden = Boolean(readerId);
    query('[data-passkeys-empty]').textContent = query('[data-comments-empty]').textContent = '正在读取…';
    query('[data-account-website]').hidden = true; confirmedRemoval = null; controls();
  };
  const handleError = (error: unknown, target: HTMLElement) => {
    target.textContent = error instanceof Error ? error.message : '操作未能完成，请重试。';
    if (error instanceof RequestError && error.status === 401) {
      if (error.code === 'reauth_required') openLogin(true);
      else { clearIdentity(null); feedback.textContent = '登录已失效，请重新登录。'; openLogin(); }
    }
  };
  const perform = async (target: HTMLElement, action: () => Promise<void>) => {
    if (mutation || !account) return;
    const expectedIdentity = identityId;
    mutation = true; controls();
    try { await action(); }
    catch (error) { if (identityId === expectedIdentity) handleError(error, target); }
    finally { mutation = false; controls(); }
  };
  const renderPasskeys = (passkeys: ReaderPasskey[]) => {
    query('[data-account-passkeys]').replaceChildren(...passkeys.map((passkey) => {
      const row = element('li'); const details = element('div');
      details.append(element('strong', passkey.label), element('small', `添加于 ${date(passkey.createdAt)} · 最近使用 ${date(passkey.lastUsedAt)}`));
      const actions = element('div'); actions.className = 'reader-passkey-confirm';
      const remove = element('button', confirmedRemoval === passkey.id ? '确认移除' : '移除'); remove.type = 'button';
      remove.setAttribute('aria-label', `${remove.textContent} ${passkey.label}`);
      remove.addEventListener('click', () => {
        if (mutation) return;
        if (confirmedRemoval !== passkey.id) { confirmedRemoval = passkey.id; renderPasskeys(passkeys); query(`[data-passkey-remove="${passkey.id}"]`).focus(); return; }
        const expectedIdentity = identityId;
        void perform(passkeyFeedback, async () => {
          const result = await requestJson<{ error?: string; passkeys: ReaderPasskey[] }>('/api/reader/passkeys.json', 'DELETE', { id: passkey.id }, 'Passkey 未能移除。');
          if (identityId !== expectedIdentity) return;
          confirmedRemoval = null;
          if (account) account.passkeys = result.passkeys;
          renderPasskeys(result.passkeys); passkeyFeedback.textContent = 'Passkey 已移除。';
          label.disabled = false; label.focus({ preventScroll: true });
        });
      });
      remove.dataset.passkeyRemove = String(passkey.id); actions.append(remove);
      if (confirmedRemoval === passkey.id) {
        const cancel = element('button', '取消'); cancel.type = 'button';
        cancel.addEventListener('click', () => { confirmedRemoval = null; renderPasskeys(passkeys); query(`[data-passkey-remove="${passkey.id}"]`).focus(); }); actions.append(cancel);
      }
      row.append(details, actions); return row;
    }));
    query('[data-passkeys-empty]').hidden = passkeys.length > 0;
    query('[data-passkeys-empty]').textContent = '还没有 Passkey，可以为当前设备添加一个。';
    controls();
  };
  const renderAccount = (value: ReaderAccount, replaceInputs: boolean) => {
    account = value; identityId = value.reader.id;
    query('[data-account-content]').hidden = false; query('[data-account-signed-out]').hidden = true;
    query('[data-account-name]').textContent = value.reader.displayName;
    query('[data-account-initial]').textContent = Array.from(value.reader.displayName)[0];
    query('[data-account-method]').textContent = `已通过 ${readerMethodLabel(value.reader.loginMethod)} 登录`;
    const created = query<HTMLTimeElement>('[data-account-created]'); created.textContent = date(value.reader.createdAt); created.dateTime = value.reader.createdAt;
    query('[data-account-comment-count]').textContent = `${value.commentCount} 次`;
    const avatar = query<HTMLImageElement>('[data-account-avatar]'); avatar.hidden = !value.reader.avatarUrl;
    if (value.reader.avatarUrl) avatar.src = value.reader.avatarUrl; else avatar.removeAttribute('src');
    if (replaceInputs) { name.value = value.reader.displayName; website.value = value.reader.websiteUrl; }
    const websiteLink = query<HTMLAnchorElement>('[data-account-website]'); websiteLink.hidden = !value.reader.websiteUrl;
    if (value.reader.websiteUrl) websiteLink.href = value.reader.websiteUrl; else websiteLink.removeAttribute('href');
    confirmedRemoval = null; renderPasskeys(value.passkeys); controls();
  };
  const loadComments = async (requestedPage = 1) => {
    const generation = ++commentsGeneration;
    loadingComments = true; controls();
    try {
      const result = await requestJson<ReaderCommentPage>(`/api/reader/comments.json?page=${requestedPage}`, 'GET', undefined, '留言暂时无法读取。');
      if (generation !== commentsGeneration) return;
      page = result.page; totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
      query('[data-account-comments]').replaceChildren(...result.comments.map((comment) => {
        const item = element('li'); const header = element('header');
        const time = element('time', date(comment.createdAt)); time.dateTime = comment.createdAt;
        const status = ({ pending: '待审核', published: '已公开', hidden: '已隐藏' } as Record<string, string>)[comment.status] || '未公开';
        header.append(time, element('span', status), element('span', comment.articleTitle || (comment.articleId ? '文章评论' : '留言纸条')));
        item.append(header, element('p', comment.content));
        if (comment.url) { const link = element('a', '查看原文 ↗'); link.href = comment.url; item.append(link); }
        return item;
      }));
      query('[data-comments-empty]').hidden = result.comments.length > 0;
      query('[data-comments-empty]').textContent = '还没有写下留言。';
      query('[data-comments-page]').textContent = `第 ${page} / ${totalPages} 页 · 共 ${result.total} 条`;
      commentFeedback.textContent = '';
    } catch (error) { if (generation === commentsGeneration) handleError(error, commentFeedback); }
    finally { if (generation === commentsGeneration) { loadingComments = false; controls(); } }
  };
  const loadAccount = async (replaceInputs = true) => {
    const generation = ++accountGeneration;
    try {
      const result = await requestJson<ReaderAccount>('/api/reader/account.json', 'GET', undefined, '账号资料暂时无法读取。');
      if (generation !== accountGeneration) return;
      const changedIdentity = result.reader.id !== identityId;
      if (changedIdentity) clearIdentity(result.reader.id);
      renderAccount(result, replaceInputs || changedIdentity);
      if (!window.PublicKeyCredential) passkeyFeedback.textContent = '当前浏览器不支持 Passkey，请使用较新的浏览器。';
      await loadComments(changedIdentity ? 1 : page);
    } catch (error) { if (generation === accountGeneration) handleError(error, feedback); }
  };
  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (mutation || !account) return;
    const displayName = name.value.trim(); const websiteUrl = website.value.trim();
    if (Array.from(displayName).length < 2 || Array.from(displayName).length > 24) { profileFeedback.textContent = '昵称需要 2–24 个字符。'; name.focus(); return; }
    if (websiteUrl && !website.checkValidity()) { profileFeedback.textContent = '请填写完整的网站地址。'; website.focus(); return; }
    const expectedIdentity = identityId;
    void perform(profileFeedback, async () => {
      const result = await requestJson<{ error?: string; reader: ReaderIdentity; account: ReaderAccount }>('/api/reader/account.json', 'PATCH', { displayName, websiteUrl }, '资料未能保存，输入已保留。');
      if (identityId !== expectedIdentity) return;
      renderAccount(result.account, true); profileFeedback.textContent = '资料已保存。';
      document.dispatchEvent(new Event('reader:refresh'));
    });
  });
  passkeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (mutation || !account) return;
    const passkeyLabel = label.value.trim();
    if (!passkeyLabel || Array.from(passkeyLabel).length > 60) { passkeyFeedback.textContent = '设备名称需要 1–60 个字符。'; label.focus(); return; }
    const expectedIdentity = identityId;
    void perform(passkeyFeedback, async () => {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const result = await requestJson<{ error?: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/reader/passkeys/register-options.json', 'POST', {}, '暂时无法添加 Passkey。');
      if (identityId !== expectedIdentity) return;
      passkeyFeedback.textContent = '请按照设备提示创建 Passkey…';
      let response;
      try { response = await startRegistration({ optionsJSON: result.options }); }
      catch { throw new Error('Passkey 创建未完成，设备名称已保留。'); }
      if (identityId !== expectedIdentity) return;
      const verified = await requestJson<{ error?: string; passkeys: ReaderPasskey[] }>('/api/reader/passkeys/register-verify.json', 'POST', { response, label: passkeyLabel }, 'Passkey 未能保存。');
      if (identityId !== expectedIdentity) return;
      if (account) account.passkeys = verified.passkeys;
      renderPasskeys(verified.passkeys); label.value = ''; passkeyFeedback.textContent = 'Passkey 已添加。';
    });
  });
  previous.addEventListener('click', () => { if (!previous.disabled) void loadComments(page - 1); });
  next.addEventListener('click', () => { if (!next.disabled) void loadComments(page + 1); });
  query<HTMLImageElement>('[data-account-avatar]').addEventListener('error', (event) => { (event.target as HTMLImageElement).hidden = true; });
  document.addEventListener('reader:session', (event) => {
    const reader = (event as CustomEvent<ReaderIdentity | null>).detail;
    const changedIdentity = (reader?.id || null) !== identityId;
    if (changedIdentity) clearIdentity(reader?.id || null);
    if (!reader) return;
    if (loadingAccount && !changedIdentity) return;
    loadingAccount = loadAccount(changedIdentity || !account).finally(() => { loadingAccount = undefined; });
  });
  if (identityId) loadingAccount = loadAccount().finally(() => { loadingAccount = undefined; });
}

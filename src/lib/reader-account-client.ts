import { setReaderFeedback } from './reader-effects';
import { requestJson, RequestError } from './client-request';
import { attachPaperCaret } from './paper-caret';
import { renderReaderMethodBadge, type ReaderIdentity } from './reader-menu';

interface ReaderPasskey { id: number; label: string; createdAt: string; lastUsedAt: string | null }
interface ReaderAccount { error?: string; reader: ReaderIdentity & { websiteUrl: string; createdAt: string }; notificationEmail: string; commentCount: number; passkeys: ReaderPasskey[] }
interface ReaderCommentPage { error?: string; comments: Array<{ id: number; content: string; createdAt: string; status: string; articleId: number | null; articleTitle: string | null; parentId: number | null; url: string | null }>; page: number; pageSize: number; total: number }

// 仅规范化仍与提交内容一致的输入，后续编辑和当前选区不被响应覆盖。
export function applySubmittedReaderInput(field: Pick<HTMLInputElement, 'value' | 'selectionStart' | 'selectionEnd' | 'selectionDirection' | 'setSelectionRange'>, submitted: string, saved: string) {
  if (field.value !== submitted || field.value === saved) return;
  const start = field.selectionStart; const end = field.selectionEnd; const direction = field.selectionDirection;
  field.value = saved;
  if (start !== null && end !== null) field.setSelectionRange(Math.min(start, saved.length), Math.min(end, saved.length), direction || 'none');
}

// 账号页保留当前输入，身份切换先清空私有记录，再读取新账号。
export function initializeReaderAccount() {
  const root = document.querySelector<HTMLElement>('[data-reader-account-page]');
  if (!root) return;
  const nameMaximum = Number(root.dataset.nameMaximum);
  const avatarMaximum = Number(root.dataset.avatarMaximum);
  const query = <Type extends HTMLElement>(selector: string) => root.querySelector<Type>(selector)!;
  const profileForm = query<HTMLFormElement>('[data-account-profile]');
  const name = profileForm.elements.namedItem('displayName') as HTMLInputElement;
  const website = profileForm.elements.namedItem('websiteUrl') as HTMLInputElement;
  const notificationEmail = profileForm.elements.namedItem('notificationEmail') as HTMLInputElement;
  [name, website, notificationEmail].forEach(attachPaperCaret);
  const passkeyForm = query<HTMLFormElement>('[data-passkey-add]');
  const label = passkeyForm.elements.namedItem('label') as HTMLInputElement;
  attachPaperCaret(label);
  const profileFeedback = query<HTMLElement>('[data-profile-feedback]');
  const avatarFeedback = query<HTMLElement>('[data-avatar-feedback]');
  const avatarFile = query<HTMLInputElement>('[data-avatar-file]');
  const avatarSelect = query<HTMLButtonElement>('[data-avatar-select]');
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
  const controls = () => {
    profileForm.querySelectorAll<HTMLInputElement>('input').forEach((control) => { control.disabled = !account; });
    profileForm.querySelectorAll<HTMLButtonElement>('button').forEach((control) => { control.disabled = mutation || !account; });
    passkeyForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach((control) => { control.disabled = mutation || !account || !window.PublicKeyCredential; });
    query('[data-account-passkeys]').querySelectorAll<HTMLButtonElement>('button').forEach((control) => { control.disabled = mutation || !account; });
    previous.disabled = mutation || loadingComments || !account || page <= 1;
    next.disabled = mutation || loadingComments || !account || page >= totalPages;
    avatarFile.disabled = avatarSelect.disabled = mutation || !account;
    root.setAttribute('aria-busy', String(mutation));
  };
  const clearIdentity = (readerId: number | null) => {
    identityId = readerId; account = undefined; accountGeneration++; commentsGeneration++; loadingComments = false;
    query('[data-account-passkeys]').replaceChildren(); query('[data-account-comments]').replaceChildren();
    profileForm.reset(); name.value = ''; website.value = ''; notificationEmail.value = ''; label.value = '';
    [profileFeedback, passkeyFeedback, commentFeedback, avatarFeedback].forEach((target) => setReaderFeedback(target, ''));
    avatarFile.value = '';
    query('[data-passkey-count]').textContent = query('[data-comment-count]').textContent = '—';
    query('[data-comments-page]').textContent = '—'; page = 1; totalPages = 1;
    query('[data-account-name]').textContent = ''; renderReaderMethodBadge(query('[data-account-method]'));
    query('[data-account-created]').textContent = '—'; query('[data-account-comment-count]').textContent = '—';
    const avatar = query<HTMLImageElement>('[data-account-avatar]'); avatar.hidden = true; avatar.removeAttribute('src');
    query('[data-account-content]').hidden = !readerId; query('[data-account-signed-out]').hidden = Boolean(readerId);
    query('[data-passkeys-empty]').textContent = query('[data-comments-empty]').textContent = '正在读取…';
    confirmedRemoval = null; controls();
  };
  const handleError = (error: unknown, target: HTMLElement) => {
    setReaderFeedback(target, error instanceof Error ? error.message : '操作未能完成，请重试。');
    if (error instanceof RequestError && error.status === 401) {
      if (error.code === 'reauth_required') openLogin(true);
      else { clearIdentity(null); setReaderFeedback(feedback, '登录已失效，请重新登录。'); openLogin(); }
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
    query('[data-passkey-count]').textContent = `${passkeys.length} 个`;
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
          renderPasskeys(result.passkeys); setReaderFeedback(passkeyFeedback, 'Passkey 已移除。');
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
    query('[data-passkeys-empty]').textContent = '暂无 Passkey';
    controls();
  };
  const renderAccount = (value: ReaderAccount, replaceInputs: boolean, replaceLists = true) => {
    account = value; identityId = value.reader.id;
    query('[data-account-content]').hidden = false; query('[data-account-signed-out]').hidden = true;
    query('[data-account-name]').textContent = value.reader.displayName;
    query('[data-account-initial]').textContent = Array.from(value.reader.displayName)[0];
    renderReaderMethodBadge(query('[data-account-method]'), value.reader.loginMethod);
    const created = query<HTMLTimeElement>('[data-account-created]'); created.textContent = date(value.reader.createdAt); created.dateTime = value.reader.createdAt;
    query('[data-account-comment-count]').textContent = `${value.commentCount} 次`;
    const avatar = query<HTMLImageElement>('[data-account-avatar]'); avatar.hidden = !value.reader.avatarUrl;
    if (value.reader.avatarUrl) avatar.src = value.reader.avatarUrl; else avatar.removeAttribute('src');
    if (replaceInputs) { name.value = value.reader.displayName; website.value = value.reader.websiteUrl; notificationEmail.value = value.notificationEmail; }
    if (replaceLists) { confirmedRemoval = null; renderPasskeys(value.passkeys); }
    controls();
  };
  const loadComments = async (requestedPage = 1, initial?: ReaderCommentPage) => {
    const generation = ++commentsGeneration;
    loadingComments = true; controls();
    try {
      const result = initial || await requestJson<ReaderCommentPage>(`/api/reader/comments.json?page=${requestedPage}`, 'GET', undefined, '留言暂时无法读取。');
      if (generation !== commentsGeneration) return;
      query('[data-comment-count]').textContent = `${result.total} 条`;
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
      query('[data-comments-empty]').textContent = '暂无留言';
      query('[data-comments-page]').textContent = `第 ${page} / ${totalPages} 页 · 共 ${result.total} 条`;
      setReaderFeedback(commentFeedback, '');
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
      if (!window.PublicKeyCredential) setReaderFeedback(passkeyFeedback, '当前浏览器不支持 Passkey，请使用较新的浏览器。');
      await loadComments(changedIdentity ? 1 : page);
    } catch (error) { if (generation === accountGeneration) handleError(error, feedback); }
  };
  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (mutation || !account) return;
    const submittedName = name.value; const submittedWebsite = website.value; const submittedNotificationEmail = notificationEmail.value;
    const displayName = submittedName.trim(); const websiteUrl = submittedWebsite.trim();
    if (Array.from(displayName).length < 2 || Array.from(displayName).length > nameMaximum) { setReaderFeedback(profileFeedback, `昵称需要 2–${nameMaximum} 个字符。`); name.focus(); return; }
    if (websiteUrl) {
      try {
        const address = new URL(websiteUrl);
        if (!['http:', 'https:'].includes(address.protocol) || !/^https?:\/\//i.test(websiteUrl) || address.username || address.password || /[\s\u0000-\u001f\u007f\\]/u.test(websiteUrl)) throw new Error('Invalid profile website');
      } catch { setReaderFeedback(profileFeedback, '请填写完整的 HTTP(S) 网站地址。'); website.focus(); return; }
    }
    const email = submittedNotificationEmail.trim();
    if (email) {
      const validator = document.createElement('input'); validator.type = 'email'; validator.value = email;
      if (!validator.validity.valid) { setReaderFeedback(profileFeedback, '请填写有效的回复通知邮箱。'); notificationEmail.focus(); return; }
    }
    const expectedIdentity = identityId;
    void perform(profileFeedback, async () => {
      const result = await requestJson<{ error?: string; reader: ReaderIdentity; account: ReaderAccount }>('/api/reader/account.json', 'PATCH', { displayName, websiteUrl, notificationEmail: email }, '资料未能保存，输入已保留。');
      if (identityId !== expectedIdentity) return;
      renderAccount(result.account, false, false);
      applySubmittedReaderInput(name, submittedName, result.account.reader.displayName);
      applySubmittedReaderInput(website, submittedWebsite, result.account.reader.websiteUrl);
      applySubmittedReaderInput(notificationEmail, submittedNotificationEmail, result.account.notificationEmail);
      setReaderFeedback(profileFeedback, '已保存');
      document.dispatchEvent(new Event('reader:refresh'));
    });
  });
  avatarSelect.addEventListener('click', () => { if (!mutation && account) avatarFile.click(); });
  avatarFile.addEventListener('change', () => {
    const file = avatarFile.files?.[0];
    avatarFile.value = '';
    if (!file || mutation || !account) return;
    if (file.size > avatarMaximum) { setReaderFeedback(avatarFeedback, '头像图片不能超过 2 MB。'); return; }
    const expectedIdentity = identityId;
    void perform(avatarFeedback, async () => {
      setReaderFeedback(avatarFeedback, '正在上传…');
      avatarSelect.setAttribute('aria-busy', 'true');
      const payload = new FormData(); payload.set('file', file);
      const result = await requestJson<{ error?: string; reader: ReaderIdentity; account: ReaderAccount }>('/api/reader/avatar.json', 'POST', payload, '头像未能保存，请重试。');
      if (identityId !== expectedIdentity) return;
      renderAccount(result.account, false, false); setReaderFeedback(avatarFeedback, '头像已更新。');
      document.dispatchEvent(new Event('reader:refresh'));
    }).finally(() => avatarSelect.removeAttribute('aria-busy'));
  });
  passkeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (mutation || !account) return;
    const passkeyLabel = label.value.trim();
    if (!passkeyLabel || Array.from(passkeyLabel).length > 60) { setReaderFeedback(passkeyFeedback, '设备名称需要 1–60 个字符。'); label.focus(); return; }
    const expectedIdentity = identityId;
    void perform(passkeyFeedback, async () => {
      const { startRegistration } = await import('@simplewebauthn/browser').catch(() => { throw new Error('Passkey 组件未能加载，请刷新页面后重试。'); });
      const result = await requestJson<{ error?: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/reader/passkeys/register-options.json', 'POST', {}, '暂时无法添加 Passkey。');
      if (identityId !== expectedIdentity) return;
      setReaderFeedback(passkeyFeedback, '请按照设备提示创建 Passkey…');
      let response;
      try { response = await startRegistration({ optionsJSON: result.options }); }
      catch { throw new Error('Passkey 创建未完成，设备名称已保留。'); }
      if (identityId !== expectedIdentity) return;
      const verified = await requestJson<{ error?: string; passkeys: ReaderPasskey[] }>('/api/reader/passkeys/register-verify.json', 'POST', { response, label: passkeyLabel }, 'Passkey 未能保存。');
      if (identityId !== expectedIdentity) return;
      if (account) account.passkeys = verified.passkeys;
      renderPasskeys(verified.passkeys); label.value = ''; setReaderFeedback(passkeyFeedback, 'Passkey 已添加。');
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
    if (account && reader.id === account.reader.id && reader.displayName === account.reader.displayName && reader.avatarUrl === account.reader.avatarUrl && reader.loginMethod === account.reader.loginMethod) return;
    if (loadingAccount && !changedIdentity) return;
    loadingAccount = loadAccount(changedIdentity || !account).finally(() => { loadingAccount = undefined; });
  });
  if (identityId && root.dataset.accountInitial) {
    try {
      const initial = JSON.parse(root.dataset.accountInitial) as { account: ReaderAccount; comments: ReaderCommentPage };
      if (initial.account.reader.id !== identityId) throw new Error('Reader bootstrap identity mismatch');
      renderAccount(initial.account, true);
      void loadComments(initial.comments.page, initial.comments);
      delete root.dataset.accountInitial;
    } catch { setReaderFeedback(feedback, '资料初始化失败，请刷新页面。'); }
  } else if (identityId) loadingAccount = loadAccount().finally(() => { loadingAccount = undefined; });
}

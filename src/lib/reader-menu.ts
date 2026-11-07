import { setReaderFeedback } from './reader-effects';
import { requestJson } from './client-request';
import { attachPaperCaret } from './paper-caret';
import { openReaderOAuthPopup } from './reader-oauth-popup';

export interface ReaderIdentity { id: number; displayName: string; avatarUrl: string | null; loginMethod?: 'email' | 'blogsclub' | 'github' | 'google' | 'passkey' }
interface ReaderOptions { email: boolean; passkey?: boolean; providers: Array<{ id: string; name: string; enabled: boolean; startUrl: string }> }
export interface ReaderSession { error?: string; reader: ReaderIdentity | null; options: ReaderOptions }
export const readerMethodLabel = (method?: string) => ({ email: '邮箱验证码', blogsclub: 'BlogsClub', github: 'GitHub', google: 'Google', passkey: 'Passkey' } as Record<string, string>)[method || ''] || '读者身份';

export function renderReaderMethodBadge(target: HTMLElement, method?: string) {
  const label = `${readerMethodLabel(method)} 登录`;
  target.hidden = !method;
  target.setAttribute('aria-label', label); target.title = label;
  target.querySelectorAll<SVGElement>('[data-reader-method-icon]').forEach((icon) => {
    icon.dataset.visible = String(icon.dataset.readerMethodIcon === method);
  });
}

// 登录和近期验证均在读者页内完成，授权窗口只用于第三方 OAuth。
export function initializeReaderLogin() {
  const panel = document.querySelector<HTMLElement>('[data-reader-login]');
  if (!panel) return;
  const form = panel.querySelector<HTMLFormElement>('[data-reader-login-form]')!;
  const email = form.elements.namedItem('email') as HTMLInputElement;
  const code = form.elements.namedItem('code') as HTMLInputElement;
  [email, code].forEach(attachPaperCaret);
  const emailValidation = document.createElement('input');
  emailValidation.type = 'email'; emailValidation.required = true; emailValidation.maxLength = email.maxLength;
  const feedback = panel.querySelector<HTMLElement>('[data-reader-login-feedback]')!;
  const send = panel.querySelector<HTMLButtonElement>('[data-reader-login-send]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const cancelOAuth = panel.querySelector<HTMLButtonElement>('[data-reader-oauth-cancel]')!;
  const returnAccount = panel.querySelector<HTMLButtonElement>('[data-reader-return-account]')!;
  const logout = document.querySelector<HTMLButtonElement>('[data-reader-logout]');
  const accountContent = document.querySelector<HTMLElement>('[data-account-content]')!;
  const loginContent = document.querySelector<HTMLElement>('[data-account-signed-out]')!;
  let session: ReaderSession | undefined;
  try { session = JSON.parse(panel.dataset.readerSession || 'null') || undefined; } catch { setReaderFeedback(feedback, '登录资料读取失败，请刷新页面。'); }
  delete panel.dataset.readerSession;
  let busy = false;
  let oauthController: AbortController | undefined;
  let cooldownUntil = 0;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshSequence = 0;
  const controls = () => {
    email.disabled = code.disabled = submit.disabled = busy || !session?.options.email;
    send.disabled = busy || !session?.options.email || Date.now() < cooldownUntil;
    if (logout) logout.disabled = busy || !session?.reader;
    returnAccount.disabled = busy;
    panel.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => {
      button.disabled = busy || !session?.options.providers.find((provider) => provider.id === button.dataset.readerProvider)?.enabled;
    });
    panel.querySelector<HTMLButtonElement>('[data-reader-passkey-login]')!.disabled = busy || !session?.options.passkey || !window.PublicKeyCredential;
    panel.setAttribute('aria-busy', String(busy));
  };
  const updateCooldown = () => {
    clearTimeout(cooldownTimer);
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    send.textContent = seconds ? `${seconds} 秒后重发` : '发送验证码'; controls();
    if (seconds) cooldownTimer = setTimeout(updateCooldown, 1000);
  };
  const refresh = async () => {
    const sequence = ++refreshSequence;
    const result = await requestJson<ReaderSession>('/api/reader/session.json', 'GET', undefined, '登录状态暂时无法读取，请刷新页面。');
    if (sequence !== refreshSequence) return;
    session = result;
    if (!result.reader) { returnAccount.hidden = true; panel.querySelector<HTMLElement>('[data-reader-login-title]')!.textContent = '登录 / 注册'; }
    for (const image of document.querySelectorAll<HTMLImageElement>('[data-reader-navigation-avatar]')) {
      image.hidden = !result.reader?.avatarUrl;
      if (result.reader?.avatarUrl) { if (image.getAttribute('src') !== result.reader.avatarUrl) { image.classList.remove('is-ready'); image.src = result.reader.avatarUrl; } }
      else image.removeAttribute('src');
    }
    document.querySelectorAll<HTMLElement>('[data-reader-navigation-identity]').forEach((avatar) => { avatar.hidden = !result.reader?.avatarUrl; });
    controls();
    document.dispatchEvent(new CustomEvent('reader:session', { detail: result.reader }));
  };
  document.addEventListener('reader:refresh', () => { void refresh().catch(() => { setReaderFeedback(feedback, '登录状态暂时无法读取，请刷新页面。'); }); });
  document.addEventListener('reader:open', (event) => {
    const reauthenticate = Boolean((event as CustomEvent<{ reauthenticate?: boolean }>).detail?.reauthenticate);
    if (!reauthenticate && session) session = { ...session, reader: null };
    controls();
    accountContent.hidden = true; loginContent.hidden = false;
    returnAccount.hidden = !session?.reader;
    panel.querySelector<HTMLElement>('[data-reader-login-title]')!.textContent = session?.reader ? '验证身份' : '登录 / 注册';
    setReaderFeedback(feedback, session?.reader ? '验证后请重新选择操作。' : '');
    panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    if (!email.disabled) email.focus({ preventScroll: true });
    else panel.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  });
  returnAccount.addEventListener('click', () => {
    if (busy || !session?.reader) return;
    loginContent.hidden = true; accountContent.hidden = false;
    document.querySelector<HTMLElement>('[data-account-name]')?.focus({ preventScroll: true });
  });
  const perform = async (action: () => Promise<void>, errorTarget = feedback) => {
    if (busy) return;
    busy = true; controls();
    try { await action(); }
    catch (error) { setReaderFeedback(errorTarget, error instanceof Error ? error.message : '操作未能完成，请重试。'); }
    finally { busy = false; controls(); }
  };
  const validEmail = () => {
    emailValidation.value = email.value.trim();
    if (emailValidation.checkValidity() && email.checkValidity()) return true;
    setReaderFeedback(feedback, '请填写有效的邮箱地址。'); email.focus(); return false;
  };
  const finishLogin = () => window.location.replace('/reader');
  send.addEventListener('click', () => {
    if (busy || !validEmail()) return;
    void perform(async () => {
      setReaderFeedback(feedback, '正在发送…');
      const result = await requestJson<{ message: string; cooldownSeconds?: number }>('/api/reader/email-code.json', 'POST', { email: email.value.trim() }, '验证码暂时无法发送。');
      cooldownUntil = Date.now() + Math.max(0, result.cooldownSeconds || 0) * 1000; updateCooldown();
      setReaderFeedback(feedback, result.message);
      busy = false; controls(); code.focus();
    });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !validEmail()) return;
    if (!new RegExp(`^\\d{${code.maxLength}}$`).test(code.value.trim())) { setReaderFeedback(feedback, '请输入三位数字验证码。'); code.focus(); return; }
    void perform(async () => {
      await requestJson('/api/reader/email-login.json', 'POST', { email: email.value.trim(), code: code.value.trim() }, '登录未能完成，输入已保留。');
      finishLogin();
    });
  });
  logout?.addEventListener('click', () => void perform(async () => {
    await requestJson('/api/reader/logout.json', 'POST', {}, '退出未能完成。');
    finishLogin();
  }, document.querySelector<HTMLElement>('[data-account-feedback]') || feedback));
  cancelOAuth.addEventListener('click', () => { oauthController?.abort(); setReaderFeedback(feedback, '正在结束登录请求…'); });
  panel.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => button.addEventListener('click', () => {
    if (busy) return;
    const provider = session?.options.providers.find((item) => item.id === button.dataset.readerProvider);
    if (!provider?.enabled) return;
    oauthController = new AbortController();
    const authorization = openReaderOAuthPopup(provider.startUrl, oauthController.signal);
    cancelOAuth.hidden = false;
    let completed = false;
    void perform(async () => {
      setReaderFeedback(feedback, `请在授权窗口完成 ${provider.name} 登录。`);
      try { await authorization; completed = true; finishLogin(); }
      finally { oauthController = undefined; cancelOAuth.hidden = true; }
    }).finally(() => { if (!completed && !button.disabled) button.focus({ preventScroll: true }); });
  }));
  panel.querySelector('[data-reader-passkey-login]')!.addEventListener('click', () => void perform(async () => {
    setReaderFeedback(feedback, '请在设备上验证 Passkey…');
    const { startAuthentication } = await import('@simplewebauthn/browser').catch(() => { throw new Error('Passkey 组件未能加载，请刷新页面后重试。'); });
    const result = await requestJson<{ error?: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/reader/passkeys/login-options.json', 'POST', {}, '暂时无法使用 Passkey。');
    let response;
    try { response = await startAuthentication({ optionsJSON: result.options }); }
    catch { throw new Error('Passkey 验证未完成，可以重试或使用其他方式登录。'); }
    await requestJson('/api/reader/passkeys/login-verify.json', 'POST', { response }, 'Passkey 验证失败。');
    finishLogin();
  }));
  window.addEventListener('pagehide', () => { oauthController?.abort(); clearTimeout(cooldownTimer); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    oauthController?.abort(); if (!oauthController) busy = false;
    updateCooldown(); void refresh().catch(() => { setReaderFeedback(feedback, '登录状态暂时无法读取，请刷新页面。'); });
  });
  controls();
}

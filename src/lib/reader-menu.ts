import { setReaderFeedback } from './reader-effects';
import { requestJson, RequestError, RequestTimeoutError } from './client-request';
import { attachPaperCaret } from './paper-caret';
import { openReaderOAuthPopup } from './reader-oauth-popup';
import { createReaderCodeVerification, initializeReaderCodeSlots } from './reader-code-slots';
import { animateContentHeight, animateMotion } from './motion';
import { siteConfig } from '../config/site';
import { refreshReaderSurface } from './reader-surface-geometry';

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
  attachPaperCaret(email);
  const emailValidation = document.createElement('input');
  emailValidation.type = 'email'; emailValidation.required = true; emailValidation.maxLength = email.maxLength;
  const feedback = panel.querySelector<HTMLElement>('[data-reader-login-feedback]')!;
  const send = panel.querySelector<HTMLButtonElement>('[data-reader-login-send]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const back = panel.querySelector<HTMLButtonElement>('[data-reader-login-back]')!;
  const emailStep = panel.querySelector<HTMLElement>('[data-reader-email-step]')!;
  const codeStep = panel.querySelector<HTMLElement>('[data-reader-code-step]')!;
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
  let loginGeneration = 0;
  let departed = false;
  let step: 'email' | 'code' = 'email';
  let sentEmail = '';
  let reauthenticating = false;
  const emailAddress = () => email.value.trim().toLowerCase();
  const codeSlots = initializeReaderCodeSlots(panel.querySelector<HTMLElement>('[data-reader-code-slots]')!, code, () => submitCode());
  const controls = () => {
    const locked = busy || codeVerification.accepted;
    codeSlots.setBusy(locked);
    const canContinue = Boolean(sentEmail && sentEmail === emailAddress() && Date.now() < cooldownUntil);
    email.disabled = locked || step !== 'email' || !session?.options.email;
    code.disabled = submit.disabled = locked || step !== 'code' || !session?.options.email;
    back.disabled = locked || step !== 'code';
    send.disabled = locked || step !== 'email' || !session?.options.email || (!canContinue && Date.now() < cooldownUntil);
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    send.textContent = canContinue ? '继续验证' : seconds ? `${seconds} 秒后获取` : '获取验证码';
    if (logout) logout.disabled = locked || !session?.reader;
    returnAccount.disabled = locked;
    panel.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => {
      button.disabled = locked || step !== 'email' || !session?.options.providers.find((provider) => provider.id === button.dataset.readerProvider)?.enabled;
    });
    panel.querySelector<HTMLButtonElement>('[data-reader-passkey-login]')!.disabled = locked || step !== 'email' || !session?.options.passkey || !window.PublicKeyCredential;
    panel.setAttribute('aria-busy', String(locked));
  };
  const updateCooldown = () => {
    clearTimeout(cooldownTimer);
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    controls();
    if (seconds) cooldownTimer = setTimeout(updateCooldown, 1000);
  };
  const changeStep = (next: typeof step) => {
    animateContentHeight(panel, () => {
      step = next; panel.dataset.step = next;
      emailStep.hidden = next !== 'email'; codeStep.hidden = next !== 'code';
      setReaderFeedback(feedback, ''); controls();
      (next === 'email' ? emailStep : codeStep).querySelectorAll<HTMLElement>('button,[data-reader-code-surface]').forEach((surface) => refreshReaderSurface(surface));
    });
    animateMotion(next === 'email' ? emailStep : codeStep, [{ opacity: 0, translate: '0 var(--reader-code-digit-rise)' }, { opacity: 1, translate: '0 0' }], {
      duration: siteConfig.interactions.feedbackResizeMilliseconds, easing: getComputedStyle(panel).getPropertyValue('--ease-out').trim(),
    });
  };
  const refresh = async () => {
    const sequence = ++refreshSequence;
    const result = await requestJson<ReaderSession>('/api/reader/session.json', 'GET', undefined, '登录状态暂时无法读取，请刷新页面。');
    if (sequence !== refreshSequence || departed) return;
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
    if (busy || codeVerification.accepted) return;
    codeSlots.reset(); codeVerification.reset();
    changeStep('email');
    const reauthenticate = Boolean((event as CustomEvent<{ reauthenticate?: boolean }>).detail?.reauthenticate);
    reauthenticating = reauthenticate;
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
  const perform = async (action: (current: () => boolean) => Promise<void>, errorTarget = feedback) => {
    if (busy || departed || codeVerification.accepted) return;
    const generation = loginGeneration;
    const current = () => generation === loginGeneration && !departed;
    busy = true; errorTarget.dataset.error = 'false'; controls();
    try { await action(current); }
    catch (error) { if (current()) { errorTarget.dataset.error = 'true'; setReaderFeedback(errorTarget, error instanceof Error ? error.message : '操作未能完成，请重试。'); } }
    finally { if (generation === loginGeneration && !departed) { busy = false; controls(); } }
  };
  const validEmail = () => {
    emailValidation.value = email.value.trim();
    if (emailValidation.checkValidity() && email.checkValidity()) return true;
    feedback.dataset.error = 'true'; setReaderFeedback(feedback, '请填写有效的邮箱地址。'); email.focus(); return false;
  };
  const finishLogin = () => { if (!departed && panel.isConnected) window.location.replace('/reader'); };
  const codeVerification = createReaderCodeVerification(
    (credentials) => requestJson('/api/reader/email-login.json', 'POST', { ...credentials, reauthenticate: reauthenticating }, '登录暂时未能完成，请稍后重新输入验证码。'),
    () => codeSlots.accept(), finishLogin,
  );
  const requestCode = () => {
    if (busy || departed || codeVerification.accepted || step !== 'email' || !session?.options.email || !validEmail()) return;
    if (sentEmail === emailAddress() && Date.now() < cooldownUntil) { changeStep('code'); code.focus({ preventScroll: true }); return; }
    if (Date.now() < cooldownUntil) return;
    const address = emailAddress();
    void perform(async (current) => {
      setReaderFeedback(feedback, '正在发送…');
      const result = await requestJson<{ message: string; cooldownSeconds?: number }>('/api/reader/email-code.json', 'POST', { email: address }, '验证码暂时无法发送。');
      if (!current()) return;
      cooldownUntil = Date.now() + Math.max(0, result.cooldownSeconds || 0) * 1000; updateCooldown();
      sentEmail = address; codeSlots.reset(); codeVerification.reset(); changeStep('code');
      busy = false; controls(); code.focus({ preventScroll: true });
    });
  };
  send.addEventListener('click', requestCode);
  email.addEventListener('input', controls);
  back.addEventListener('click', () => {
    if (busy || departed || codeVerification.accepted || step !== 'code') return;
    changeStep('email'); email.focus({ preventScroll: true });
  });
  function submitCode() {
    if (busy || departed || codeVerification.accepted || codeSlots.composing || step !== 'code' || !sentEmail || !session?.options.email) return;
    if (!new RegExp(`^\\d{${code.maxLength}}$`).test(code.value.trim())) { feedback.dataset.error = 'true'; setReaderFeedback(feedback, '请输入三位数字验证码。'); code.focus(); return; }
    const credentials = { email: sentEmail, code: code.value.trim() };
    const generation = loginGeneration;
    void perform(async (current) => {
      setReaderFeedback(feedback, '');
      try { await codeVerification.submit(credentials); }
      catch (error) {
        if (!current()) return;
        const message = error instanceof RequestError ? error.message : error instanceof RequestTimeoutError
          ? '验证请求超时，结果尚未确认，请稍后重新输入验证码。' : '网络或登录服务暂不可用，请稍后重新输入验证码。';
        feedback.dataset.error = 'true'; setReaderFeedback(feedback, message);
        await codeSlots.reject();
      }
    }).finally(() => {
      if (generation === loginGeneration && !departed && step === 'code' && !codeVerification.accepted && !code.value) code.focus({ preventScroll: true });
    });
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); if (step === 'email') requestCode(); else submitCode(); });
  logout?.addEventListener('click', () => void perform(async () => {
    await requestJson('/api/reader/logout.json', 'POST', {}, '退出未能完成。');
    finishLogin();
  }, document.querySelector<HTMLElement>('[data-account-feedback]') || feedback));
  cancelOAuth.addEventListener('click', () => { oauthController?.abort(); setReaderFeedback(feedback, '正在结束登录请求…'); });
  panel.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => button.addEventListener('click', () => {
    if (busy || step !== 'email' || departed || codeVerification.accepted) return;
    const provider = session?.options.providers.find((item) => item.id === button.dataset.readerProvider);
    if (!provider?.enabled) return;
    oauthController = new AbortController();
    const authorization = openReaderOAuthPopup(provider.startUrl, oauthController.signal, { intent: reauthenticating ? 'reauthenticate' : 'login' });
    cancelOAuth.hidden = false;
    let completed = false;
    void perform(async () => {
      setReaderFeedback(feedback, `请在授权窗口完成 ${provider.name} 登录。`);
      try { await authorization; completed = true; finishLogin(); }
      finally { oauthController = undefined; cancelOAuth.hidden = true; }
    }).finally(() => { if (!completed && !button.disabled) button.focus({ preventScroll: true }); });
  }));
  panel.querySelector('[data-reader-passkey-login]')!.addEventListener('click', () => { if (step !== 'email') return; void perform(async () => {
    setReaderFeedback(feedback, '请在设备上验证 Passkey…');
    const { startAuthentication } = await import('@simplewebauthn/browser').catch(() => { throw new Error('Passkey 组件未能加载，请刷新页面后重试。'); });
    const result = await requestJson<{ error?: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/reader/passkeys/login-options.json', 'POST', { reauthenticate: reauthenticating }, '暂时无法使用 Passkey。');
    let response;
    try { response = await startAuthentication({ optionsJSON: result.options }); }
    catch { throw new Error('Passkey 验证未完成，可以重试或使用其他方式登录。'); }
    await requestJson('/api/reader/passkeys/login-verify.json', 'POST', { response }, 'Passkey 验证失败。');
    finishLogin();
  }); });
  window.addEventListener('pagehide', () => { departed = true; loginGeneration++; refreshSequence++; codeSlots.abort(); codeVerification.reset(); oauthController?.abort(); clearTimeout(cooldownTimer); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    departed = false; codeSlots.reset(); codeVerification.reset();
    oauthController?.abort(); oauthController = undefined; cancelOAuth.hidden = true; busy = false;
    updateCooldown(); void refresh().catch(() => { setReaderFeedback(feedback, '登录状态暂时无法读取，请刷新页面。'); });
  });
  // 软键盘压缩时只滚动登录正文，让正在编辑的字段和确认操作仍可见。
  const viewport = window.visualViewport;
  if (viewport) {
    let viewportFrame = 0;
    const keepInputVisible = () => {
      viewportFrame = 0;
      const field = document.activeElement;
      const editing = !loginContent.hidden && (field === email || field === code);
      if (editing && viewport.height < window.innerHeight) document.body.style.setProperty('--reader-login-viewport-height', `${viewport.height}px`);
      else document.body.style.removeProperty('--reader-login-viewport-height');
      const main = panel.closest('main');
      if (!editing || !main) return;
      const bounds = field.getBoundingClientRect();
      const container = main.getBoundingClientRect();
      const inset = siteConfig.interactions.keyboardInsetPixels;
      const top = Math.max(container.top, viewport.offsetTop) + inset;
      const bottom = Math.min(container.bottom, viewport.offsetTop + viewport.height) - inset;
      const actionBottom = (step === 'email' ? send : submit).getBoundingClientRect().bottom;
      const targetBottom = actionBottom - bounds.top <= bottom - top ? Math.max(bounds.bottom, actionBottom) : bounds.bottom;
      const overflow = targetBottom > bottom ? targetBottom - bottom : bounds.top < top ? bounds.top - top : 0;
      if (overflow) main.scrollBy({ top: overflow, behavior: 'instant' });
    };
    const scheduleViewport = () => { if (!viewportFrame) viewportFrame = requestAnimationFrame(keepInputVisible); };
    viewport.addEventListener('resize', scheduleViewport);
    form.addEventListener('focusin', scheduleViewport); form.addEventListener('focusout', scheduleViewport);
    window.addEventListener('pagehide', () => { cancelAnimationFrame(viewportFrame); viewportFrame = 0; document.body.style.removeProperty('--reader-login-viewport-height'); });
  }
  controls();
}

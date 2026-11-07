import { requestJson } from './client-request';

export interface ReaderIdentity { id: number; displayName: string; avatarUrl: string | null; loginMethod?: 'email' | 'blogsclub' | 'github' | 'google' | 'passkey' }
interface ReaderOptions { email: boolean; passkey?: boolean; providers: Array<{ id: string; name: string; enabled: boolean; startUrl: string }> }
export interface ReaderSession { error?: string; reader: ReaderIdentity | null; options: ReaderOptions }
export const readerMethodLabel = (method?: string) => ({ email: '邮箱验证码', blogsclub: 'BlogsClub', github: 'GitHub', google: 'Google', passkey: 'Passkey' } as Record<string, string>)[method || ''] || '读者身份';

// 导航仅通过私有接口读取身份，不把登录信息嵌入公开页面缓存。
export function initializeReaderMenu() {
  const dialog = document.querySelector<HTMLDialogElement>('[data-reader-menu]');
  if (!dialog) return;
  const triggers = [...document.querySelectorAll<HTMLButtonElement>('[data-reader-open]')];
  const form = dialog.querySelector<HTMLFormElement>('[data-reader-menu-form]')!;
  const email = form.elements.namedItem('email') as HTMLInputElement;
  const code = form.elements.namedItem('code') as HTMLInputElement;
  const feedback = dialog.querySelector<HTMLElement>('[data-reader-menu-feedback]')!;
  const send = dialog.querySelector<HTMLButtonElement>('[data-reader-menu-send]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const logout = dialog.querySelector<HTMLButtonElement>('[data-reader-menu-logout]')!;
  let session: ReaderSession | undefined;
  let busy = false;
  let navigating = false;
  let reauthenticate = false;
  let previousFocus: HTMLElement | null = null;
  let unlock: (() => void) | undefined;
  let refreshSequence = 0;
  let cooldownUntil = 0;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  const controls = () => {
    email.disabled = code.disabled = submit.disabled = busy || !session?.options.email;
    send.disabled = busy || !session?.options.email || Date.now() < cooldownUntil;
    logout.disabled = busy || !session?.reader;
    dialog.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => {
      button.disabled = busy || !session?.options.providers.find((provider) => provider.id === button.dataset.readerProvider)?.enabled;
    });
    const passkey = dialog.querySelector<HTMLButtonElement>('[data-reader-passkey-login]')!;
    passkey.disabled = busy || !session?.options.passkey || !window.PublicKeyCredential;
    dialog.setAttribute('aria-busy', String(busy));
  };
  const updateCooldown = () => {
    clearTimeout(cooldownTimer);
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    send.textContent = seconds ? `${seconds} 秒后重发` : '发送验证码'; controls();
    if (seconds && dialog.open) cooldownTimer = setTimeout(updateCooldown, 1000);
  };
  const render = () => {
    const reader = session?.reader;
    dialog.querySelector<HTMLElement>('[data-reader-menu-login]')!.hidden = Boolean(reader) && !reauthenticate;
    dialog.querySelector<HTMLElement>('[data-reader-menu-account]')!.hidden = !reader || reauthenticate;
    dialog.querySelector<HTMLElement>('[data-reader-menu-name]')!.textContent = reader?.displayName || '读者';
    dialog.querySelector<HTMLElement>('[data-reader-menu-initial]')!.textContent = Array.from(reader?.displayName || '读')[0];
    dialog.querySelector<HTMLElement>('[data-reader-menu-method]')!.textContent = reader ? `已通过 ${readerMethodLabel(reader.loginMethod)} 登录` : '';
    for (const image of document.querySelectorAll<HTMLImageElement>('[data-reader-navigation-avatar],[data-reader-menu-avatar]')) {
      image.hidden = !reader?.avatarUrl;
      if (reader?.avatarUrl) { if (image.getAttribute('src') !== reader.avatarUrl) image.src = reader.avatarUrl; }
      else image.removeAttribute('src');
    }
    controls();
    document.querySelectorAll<HTMLInputElement>('input[name="nickname"][readonly]').forEach((input) => {
      if (reader) input.value = reader.displayName;
    });
    document.querySelectorAll<HTMLElement>('.reader-comment-identity b').forEach((label) => { if (reader) label.textContent = reader.displayName; });
  };
  const refresh = async () => {
    const sequence = ++refreshSequence;
    const result = await requestJson<ReaderSession>('/api/reader/session.json', 'GET', undefined, '登录状态暂时无法读取，请重新打开面板。');
    if (sequence !== refreshSequence) return;
    session = result; render();
    document.dispatchEvent(new CustomEvent('reader:session', { detail: result.reader }));
  };
  const position = () => {
    const viewport = window.visualViewport;
    const offsetTop = viewport?.offsetTop || 0;
    const height = viewport?.height || innerHeight;
    const width = viewport?.width || innerWidth;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reader-menu-gap')) || 12;
    const header = document.querySelector<HTMLElement>('[data-site-header]')!;
    const top = Math.max(offsetTop + gap, Math.min(header.getBoundingClientRect().bottom + gap, offsetTop + height - gap * 2));
    const trigger = previousFocus?.getBoundingClientRect();
    const left = Math.max(gap, Math.min((trigger?.right || width - gap) - dialog.offsetWidth, width - dialog.offsetWidth - gap));
    dialog.style.top = `${top}px`; dialog.style.left = `${left}px`;
    dialog.style.maxHeight = `${Math.max(0, offsetTop + height - top - gap)}px`;
  };
  const open = async (trigger?: HTMLElement) => {
    if (dialog.open) {
      feedback.textContent = reauthenticate ? '请重新验证当前账号，再返回完成操作。' : '';
      if (!email.disabled && reauthenticate) email.focus({ preventScroll: true });
      return;
    }
    previousFocus = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const scrollX = window.scrollX; const scrollY = window.scrollY;
    const body = document.body;
    const names = ['position', 'top', 'left', 'width', 'overflow'] as const;
    const saved = names.map((name) => [name, body.style.getPropertyValue(name), body.style.getPropertyPriority(name)]);
    body.style.position = 'fixed'; body.style.top = `${-scrollY}px`; body.style.left = `${-scrollX}px`; body.style.width = '100%'; body.style.overflow = 'hidden';
    unlock = () => {
      saved.forEach(([name, value, priority]) => { if (value) body.style.setProperty(name, value, priority); else body.style.removeProperty(name); });
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    };
    triggers.forEach((button) => button.setAttribute('aria-expanded', 'true'));
    dialog.showModal(); position(); updateCooldown();
    feedback.textContent = session ? '' : '正在读取登录状态…';
    try {
      await refresh();
      if (!dialog.open) return;
      feedback.textContent = reauthenticate ? '请重新验证当前账号，再返回完成操作。' : '';
      if (!session?.reader && !session?.options.email && !session?.options.providers.some((provider) => provider.enabled) && !session?.options.passkey) feedback.textContent = '登录暂时不可用，请稍后再试。';
      (session?.reader && !reauthenticate ? dialog.querySelector<HTMLElement>('[data-reader-menu-name]') : !email.disabled ? email : dialog.querySelector<HTMLElement>('[data-reader-close]'))?.focus({ preventScroll: true });
    } catch (error) { if (dialog.open) feedback.textContent = error instanceof Error ? error.message : '暂时无法读取登录状态。'; }
  };
  triggers.forEach((button) => button.addEventListener('click', () => { reauthenticate = false; render(); void open(button); }));
  document.addEventListener('reader:open', (event) => {
    reauthenticate = Boolean((event as CustomEvent<{ reauthenticate?: boolean }>).detail?.reauthenticate);
    render(); void open();
  });
  document.addEventListener('reader:refresh', () => { void refresh().catch(() => undefined); });
  dialog.querySelector('[data-reader-close]')!.addEventListener('click', () => dialog.close());
  let backdropPressed = false;
  dialog.addEventListener('pointerdown', (event) => { backdropPressed = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    if (!backdropPressed || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    backdropPressed = false;
  });
  dialog.addEventListener('close', () => {
    clearTimeout(cooldownTimer); unlock?.(); unlock = undefined;
    triggers.forEach((button) => button.setAttribute('aria-expanded', 'false'));
    const target = previousFocus?.getClientRects().length ? previousFocus : document.querySelector<HTMLElement>('[data-menu-button]');
    target?.focus({ preventScroll: true });
  });
  window.addEventListener('resize', () => { if (dialog.open) position(); });
  window.visualViewport?.addEventListener('resize', () => { if (dialog.open) position(); });
  window.visualViewport?.addEventListener('scroll', () => { if (dialog.open) position(); });
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true; controls();
    try { await action(); }
    catch (error) { feedback.textContent = error instanceof Error ? error.message : '操作未能完成，请重试。'; }
    finally { if (!navigating) { busy = false; controls(); } }
  };
  const validEmail = () => {
    if (email.value.trim() && email.checkValidity()) return true;
    feedback.textContent = '请填写有效的邮箱地址。'; email.focus(); return false;
  };
  send.addEventListener('click', () => {
    if (busy || !validEmail()) return;
    void perform(async () => {
      feedback.textContent = '正在发送…';
      const result = await requestJson<{ message: string; cooldownSeconds?: number }>('/api/reader/email-code.json', 'POST', { email: email.value.trim() }, '验证码暂时无法发送。');
      cooldownUntil = Date.now() + Math.max(0, result.cooldownSeconds || 0) * 1000; updateCooldown();
      feedback.textContent = result.message;
      busy = false; controls(); if (dialog.open) code.focus();
    });
  });
  const signedIn = async () => {
    const wasReauthentication = reauthenticate;
    reauthenticate = false; form.reset(); await refresh(); feedback.textContent = wasReauthentication ? '身份已验证，请返回账号页重新选择操作。' : '登录成功。';
    if (dialog.open) dialog.querySelector<HTMLElement>('[data-reader-menu-name]')!.focus({ preventScroll: true });
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !validEmail()) return;
    if (!/^\d{6}$/.test(code.value.trim())) { feedback.textContent = '请输入六位数字验证码。'; code.focus(); return; }
    void perform(async () => {
      await requestJson('/api/reader/email-login.json', 'POST', { email: email.value.trim(), code: code.value.trim() }, '登录未能完成，输入已保留。');
      await signedIn();
    });
  });
  logout.addEventListener('click', () => void perform(async () => {
    await requestJson('/api/reader/logout.json', 'POST', {}, '退出未能完成。');
    await refresh(); feedback.textContent = '已退出登录。';
    busy = false; controls(); if (dialog.open && !email.disabled) email.focus();
  }));
  dialog.querySelectorAll<HTMLButtonElement>('[data-reader-provider]').forEach((button) => button.addEventListener('click', () => void perform(async () => {
    const provider = session?.options.providers.find((item) => item.id === button.dataset.readerProvider);
    if (!provider?.enabled) return;
    feedback.textContent = `正在前往 ${provider.name}…`;
    const result = await requestJson<{ error?: string; url: string }>(provider.startUrl, 'POST', {}, '暂时无法开始登录。');
    const address = new URL(result.url);
    if (!['http:', 'https:'].includes(address.protocol)) throw new Error('登录地址不可用。');
    window.location.assign(address.href); navigating = true;
  })));
  dialog.querySelector('[data-reader-passkey-login]')!.addEventListener('click', () => void perform(async () => {
    feedback.textContent = '请在设备上验证 Passkey…';
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const result = await requestJson<{ error?: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/reader/passkeys/login-options.json', 'POST', {}, '暂时无法使用 Passkey。');
    let response;
    try { response = await startAuthentication({ optionsJSON: result.options }); }
    catch { throw new Error('Passkey 验证未完成，可以重试或使用其他方式登录。'); }
    await requestJson('/api/reader/passkeys/login-verify.json', 'POST', { response }, 'Passkey 验证失败。');
    await signedIn();
  }));
  document.querySelectorAll<HTMLImageElement>('[data-reader-navigation-avatar],[data-reader-menu-avatar]').forEach((image) => image.addEventListener('error', () => { image.hidden = true; }));
  window.addEventListener('pagehide', () => { if (dialog.open) dialog.close(); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    navigating = false; busy = false; controls(); void refresh().catch(() => undefined);
  });
  void refresh().catch(() => undefined);
}

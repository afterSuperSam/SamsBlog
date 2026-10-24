import { siteConfig } from '../config/site';

// 留言和评论共用本机资料；尊重取消记忆的选择，不记忆正文或通知授权。
export function parseVisitorProfile(value: string | null): { nickname: string; email: string } | null {
  if (!value || value.length > 2048) return null;
  try {
    const profile = JSON.parse(value);
    if (!profile || typeof profile.nickname !== 'string' || typeof profile.email !== 'string'
      || [...profile.nickname].length > siteConfig.visitorProfile.nicknameMaximumLength
      || profile.email.length > siteConfig.visitorProfile.emailMaximumLength
      || /[\u0000-\u001f\u007f]/.test(profile.nickname + profile.email)) return null;
    return { nickname: profile.nickname, email: profile.email };
  } catch { return null; }
}

export function rememberVisitor(form: HTMLFormElement) {
  const nickname = form.elements.namedItem('nickname') as HTMLInputElement;
  const email = form.elements.namedItem('email') as HTMLInputElement | null;
  const remember = form.querySelector<HTMLInputElement>('[data-remember-visitor]')!;
  const status = form.querySelector<HTMLElement>('[data-remember-status]')!;
  const key = siteConfig.visitorProfile.storageKey;
  try {
    const stored = localStorage.getItem(key);
    const profile = parseVisitorProfile(stored);
    if (stored === 'disabled') remember.checked = false;
    if (profile) {
      remember.checked = true;
      if (!nickname.value) nickname.value = profile.nickname;
      if (email && !email.value) email.value = profile.email;
    }
  } catch { status.textContent = '浏览器未允许保存资料，本次留言不受影响。'; }
  remember.addEventListener('change', () => {
    try { if (remember.checked) localStorage.removeItem(key); else localStorage.setItem(key, 'disabled'); status.textContent = ''; }
    catch { status.textContent = '无法清除保存的资料，可在浏览器设置中清除本站数据。'; }
  });
  return {
    enabled: () => remember.checked,
    save: () => {
      if (!remember.checked) return;
      const profile = parseVisitorProfile(JSON.stringify({ nickname: nickname.value.trim(), email: email?.value.trim() || '' }));
      if (!profile) return;
      try { localStorage.setItem(key, JSON.stringify(profile)); status.textContent = ''; }
      catch { status.textContent = '资料未能保存在本机，本次留言已经送出。'; }
    },
  };
}

import { siteConfig } from '../config/site';
import { animateMotion, motionDisabled } from './motion';

export const normalizeReaderCode = (value: string, length: number) => value.normalize('NFKC').replace(/\D/g, '').slice(0, length);

// 原生输入负责选区、删除与系统填充；视觉格只呈现同一份数字。
export function initializeReaderCodeSlots(root: HTMLElement, input: HTMLInputElement, onComplete?: () => void) {
  const slots = [...root.querySelectorAll<HTMLElement>('[data-reader-code-slot]')];
  const wash = root.querySelector<HTMLElement>('[data-reader-code-wash]')!;
  const check = root.querySelector<HTMLElement>('[data-reader-code-check]')!;
  const cross = root.querySelector<HTMLElement>('[data-reader-code-cross]')!;
  const status = root.querySelector<HTMLElement>('[data-reader-code-status]')!;
  const config = siteConfig.readerCodeSlots;
  let composing = false;
  let lastValue = input.value;
  let lastCompleted = '';
  let success = false;
  let lifetime = new AbortController();
  const animations = new Set<Animation>();
  const easing = () => getComputedStyle(root).getPropertyValue('--ease-out').trim();
  const animate = (target: Element, frames: Keyframe[], duration: number, delay = 0) => {
    try {
      const animation = animateMotion(target, frames, { duration, delay, easing: easing(), fill: 'backwards' });
      if (!animation) return Promise.resolve();
      animations.add(animation);
      return animation.finished.then(() => {}, () => {}).finally(() => { animations.delete(animation); });
    } catch { return Promise.resolve(); }
  };
  const render = (land = false) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    slots.forEach((slot, index) => {
      const digit = slot.querySelector<HTMLElement>('[data-reader-code-digit]')!;
      const value = input.value[index] || '';
      if (land && value && digit.textContent !== value) void animate(digit, [{ opacity: 0, transform: 'translateY(var(--reader-code-digit-rise))' }, { opacity: 1, transform: 'translateY(0)' }], config.entryMilliseconds, index * config.cascadeMilliseconds);
      digit.textContent = value;
      slot.dataset.filled = String(Boolean(value));
      slot.dataset.active = String(document.activeElement === input && (end > start ? index >= start && index < end : index === Math.min(start, slots.length - 1)));
    });
    status.textContent = success ? '验证码已确认，正在进入账号。' : `已输入 ${input.value.length} 位，共 ${slots.length} 位。`;
  };
  const changed = () => {
    if (composing || input.disabled || input.readOnly || success) return;
    const position = normalizeReaderCode(input.value.slice(0, input.selectionStart ?? input.value.length), slots.length).length;
    input.value = normalizeReaderCode(input.value, slots.length);
    input.setSelectionRange(position, position);
    if (input.value !== lastValue) {
      lastValue = input.value; lastCompleted = '';
      root.dataset.status = 'idle'; input.removeAttribute('aria-invalid');
    }
    render(true);
    if (input.value.length === slots.length && input.value !== lastCompleted) {
      lastCompleted = input.value; onComplete?.();
    }
  };
  input.addEventListener('input', changed);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; changed(); });
  input.addEventListener('paste', (event) => {
    if (input.disabled || success || composing) return;
    event.preventDefault();
    const pasted = normalizeReaderCode(event.clipboardData?.getData('text') || '', slots.length);
    if (!pasted) return;
    const start = pasted.length === slots.length ? 0 : input.selectionStart ?? 0;
    const end = pasted.length === slots.length ? input.value.length : input.selectionEnd ?? start;
    input.setRangeText(pasted, start, end, 'end'); changed();
  });
  input.addEventListener('pointerdown', (event) => {
    if (input.disabled || success || composing) return;
    event.preventDefault(); input.focus({ preventScroll: true });
    const index = slots.findIndex((slot) => event.clientX <= slot.getBoundingClientRect().right);
    const position = Math.min(index < 0 ? slots.length - 1 : index, input.value.length);
    input.setSelectionRange(position, Math.min(position + 1, input.value.length)); render();
  });
  for (const type of ['focus', 'blur', 'select', 'keyup']) input.addEventListener(type, () => render());
  const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
  });
  const abort = () => { lifetime.abort(); animations.forEach((animation) => animation.cancel()); animations.clear(); };
  render();
  return {
    get composing() { return composing; },
    setBusy(value: boolean) { root.dataset.disabled = String(value); },
    async reject() {
      const signal = lifetime.signal;
      if (signal.aborted) return false;
      animations.forEach((animation) => animation.cancel()); animations.clear();
      input.readOnly = true; root.dataset.status = 'error'; input.setAttribute('aria-invalid', 'true'); render();
      status.textContent = '验证未通过，请重新输入验证码。';
      if (!motionDisabled()) void animate(cross, [{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1)' }], config.errorRevealMilliseconds);
      await wait(motionDisabled() ? config.stillErrorMilliseconds : config.errorRevealMilliseconds + config.errorHoldMilliseconds, signal);
      if (signal.aborted) return false;
      animations.forEach((animation) => animation.cancel()); animations.clear();
      lastValue = lastCompleted = ''; input.value = ''; input.setSelectionRange(0, 0); input.readOnly = false;
      root.dataset.status = 'idle'; input.removeAttribute('aria-invalid'); render(); return true;
    },
    reset() {
      abort(); lifetime = new AbortController(); composing = success = false;
      lastValue = lastCompleted = ''; input.value = ''; input.readOnly = false;
      root.dataset.status = 'idle'; input.removeAttribute('aria-invalid'); render();
    },
    abort,
    async accept() {
      const signal = lifetime.signal;
      if (signal.aborted) return false;
      success = true; input.readOnly = true; root.dataset.status = 'merging'; render();
      const playback = new AbortController();
      const stop = () => playback.abort();
      signal.addEventListener('abort', stop, { once: true });
      let ended = false;
      const sequence = async () => {
        if (!motionDisabled()) await Promise.all([
          animate(wash, [{ opacity: 0, transform: 'scaleX(.3)' }, { opacity: 1, transform: 'scaleX(1)' }], config.mergeMilliseconds),
          ...slots.map((slot) => animate(slot, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(var(--reader-code-digit-rise))' }], config.mergeMilliseconds)),
        ]);
        if (signal.aborted || ended) return;
        root.dataset.status = 'success';
        if (!motionDisabled()) await animate(check, [{ opacity: 0, transform: 'translateY(var(--reader-code-digit-rise)) scale(.85)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], config.checkMilliseconds);
        await wait(motionDisabled() ? config.stillSuccessMilliseconds : config.successHoldMilliseconds, playback.signal);
      };
      try {
        const outcome = await Promise.race([sequence().then(() => 'complete'), wait(config.deadlineMilliseconds, playback.signal).then(() => 'deadline')]);
        ended = true;
        if (signal.aborted) return false;
        root.dataset.status = 'success';
        animations.forEach((animation) => animation.cancel());
        if (outcome === 'deadline') await wait(config.stillSuccessMilliseconds, playback.signal);
        return !signal.aborted;
      } finally { ended = true; playback.abort(); signal.removeEventListener('abort', stop); }
    },
  };
}

// 同一次确认覆盖请求和成功呈现；旧页面返回或离开后不允许晚到响应导航。
export function createReaderCodeVerification(verify: (credentials: { email: string; code: string }) => Promise<unknown>, present: () => Promise<boolean>, complete: () => void) {
  let generation = 0;
  let phase: 'idle' | 'checking' | 'accepted' | 'complete' = 'idle';
  return {
    get accepted() { return phase === 'accepted' || phase === 'complete'; },
    reset() { generation++; phase = 'idle'; },
    async submit(credentials: { email: string; code: string }) {
      if (phase !== 'idle') return false;
      const current = ++generation; phase = 'checking';
      try {
        await verify(credentials);
        if (current !== generation) return false;
        phase = 'accepted';
        if (!await present() || current !== generation) return false;
        phase = 'complete'; complete(); return true;
      } catch (error) {
        if (current !== generation) return false;
        phase = 'idle'; throw error;
      }
    },
  };
}

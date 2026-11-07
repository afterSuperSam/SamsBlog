import { siteConfig } from '../config/site';
import { animateMotion, motionDisabled } from './motion';

export function readerRippleBounds(width: number, height: number, horizontal?: number, vertical?: number) {
  const left = Math.max(0, Math.min(width, horizontal ?? width / 2));
  const top = Math.max(0, Math.min(height, vertical ?? height / 2));
  const diameter = 2 * Math.hypot(Math.max(left, width - left), Math.max(top, height - top));
  return { left, top, diameter };
}

// 点击反馈独立于操作处理，不阻断用户手势或第三方授权窗口。
export function initializeReaderEffects(root: HTMLElement) {
  const cleanupByControl = new Map<HTMLElement, () => void>();
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>('button.reader-curved-surface,a.reader-curved-surface');
    if (!control || !root.contains(control) || control.matches(':disabled,[aria-disabled="true"],[data-avatar-select]')) return;
    cleanupByControl.get(control)?.();
    const bounds = control.getBoundingClientRect();
    const geometry = readerRippleBounds(bounds.width, bounds.height, event.detail ? event.clientX - bounds.left : undefined, event.detail ? event.clientY - bounds.top : undefined);
    const layer = document.createElement('span'); layer.className = 'reader-ripple-layer'; layer.setAttribute('aria-hidden', 'true');
    const ripple = document.createElement('span'); ripple.className = 'reader-ripple';
    ripple.style.left = `${geometry.left}px`; ripple.style.top = `${geometry.top}px`;
    ripple.style.width = ripple.style.height = `${geometry.diameter}px`;
    layer.append(ripple); control.append(layer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let animation: Animation | undefined;
    const cleanup = () => { clearTimeout(timer); animation?.cancel(); layer.remove(); if (cleanupByControl.get(control) === cleanup) cleanupByControl.delete(control); };
    cleanupByControl.set(control, cleanup);
    if (motionDisabled()) {
      ripple.style.transform = 'translate(-50%,-50%)'; ripple.style.opacity = String(siteConfig.readerEffects.rippleOpacity);
      timer = setTimeout(cleanup, siteConfig.readerEffects.stillFeedbackMilliseconds);
    } else {
      animation = animateMotion(ripple, [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: siteConfig.readerEffects.rippleOpacity },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
      ], { duration: siteConfig.readerEffects.rippleMilliseconds, easing: getComputedStyle(root).getPropertyValue('--ease-out').trim() });
      if (animation) void animation.finished.then(cleanup, cleanup); else cleanup();
    }
  }, { capture: true });
  window.addEventListener('pagehide', () => { [...cleanupByControl.values()].forEach((cleanup) => cleanup()); });
}

// 一行反馈位置保持稳定，多行错误只平滑扩展必要高度。
export function setReaderFeedback(target: HTMLElement, message: string) {
  if (target.textContent === message) return;
  target.getAnimations().forEach((animation) => animation.cancel());
  const previousHeight = target.getBoundingClientRect().height;
  target.textContent = message;
  const nextHeight = target.getBoundingClientRect().height;
  if (!message) return;
  animateMotion(target, [
    { height: `${previousHeight}px`, opacity: .3, translate: '0 3px' },
    { height: `${nextHeight}px`, opacity: 1, translate: '0 0' },
  ], { duration: siteConfig.interactions.feedbackResizeMilliseconds, easing: getComputedStyle(target).getPropertyValue('--ease-out').trim() });
}

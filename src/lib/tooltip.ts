import { siteConfig } from '../config/site';
import { animateMotion } from './motion';

interface TooltipContent {
  show(trigger: HTMLElement): void;
  hide?(trigger: HTMLElement): void;
}

// 让触发器、键盘焦点与浮层共享一次阅读停留。
export const createTooltip = (popover: HTMLElement, content: TooltipContent) => {
  const triggers: HTMLElement[] = [];
  let activeTrigger: HTMLElement | null = null;
  let hoveredTrigger: HTMLElement | null = null;
  let hoveringPopover = false;
  let dismissTimer: number | undefined;
  let focusFrame: number | undefined;
  let revealAnimation: Animation | undefined;
  const cancelDismiss = () => { window.clearTimeout(dismissTimer); dismissTimer = undefined; };
  const focusedTrigger = () => triggers.find((trigger) => trigger.contains(document.activeElement));
  const hide = (cancelPendingFocus = true) => {
    cancelDismiss();
    revealAnimation?.cancel();
    if (cancelPendingFocus && focusFrame !== undefined) {
      cancelAnimationFrame(focusFrame);
      focusFrame = undefined;
    }
    if (activeTrigger) content.hide?.(activeTrigger);
    activeTrigger = null;
    hoveredTrigger = null;
    hoveringPopover = false;
    if (popover.matches(':popover-open')) popover.hidePopover();
  };
  const show = (trigger: HTMLElement) => {
    cancelDismiss();
    if (activeTrigger && activeTrigger !== trigger) content.hide?.(activeTrigger);
    activeTrigger = trigger;
    content.show(trigger);
    const opening = !popover.matches(':popover-open');
    if (opening) popover.showPopover();
    else revealAnimation?.cancel();
    const anchor = trigger.getBoundingClientRect();
    const detail = { width: popover.offsetWidth, height: popover.offsetHeight };
    const above = anchor.top >= detail.height + 20;
    const top = above ? anchor.top - detail.height - 10 : anchor.bottom + 10;
    const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - detail.width / 2, window.innerWidth - detail.width - 12));
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(12, Math.min(top, window.innerHeight - detail.height - 12))}px`;
    popover.style.transformOrigin = `${Math.max(0, Math.min(anchor.left + anchor.width / 2 - left, detail.width))}px ${above ? 'bottom' : 'top'}`;
    if (opening) revealAnimation = animateMotion(popover, [
      { opacity: .85, transform: `translateY(${above ? 3 : -3}px) scale(.98)` },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: siteConfig.interactions.tooltipRevealMilliseconds, easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() });
  };
  const scheduleDismiss = () => {
    cancelDismiss();
    if (!popover.matches(':popover-open')) return;
    dismissTimer = window.setTimeout(() => {
      dismissTimer = undefined;
      if (!popover.matches(':popover-open')) return;
      const retainedTrigger = focusedTrigger() || hoveredTrigger;
      if (retainedTrigger && retainedTrigger !== activeTrigger) show(retainedTrigger);
      else if (!retainedTrigger && !hoveringPopover) hide();
    }, siteConfig.interactions.tooltipDismissMilliseconds);
  };
  popover.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse') return;
    hoveringPopover = true;
    cancelDismiss();
  });
  popover.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    hoveringPopover = false;
    scheduleDismiss();
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && !popover.contains(event.target) && !activeTrigger?.contains(event.target)) hide();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  // 聚焦引起的平滑滚动持续更新位置，悬停提示随普通滚动关闭。
  window.addEventListener('scroll', () => {
    const focused = focusedTrigger();
    if (focused && focused === activeTrigger) show(focused);
    else hide(false);
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => hide());
  return {
    bind(trigger: HTMLElement) {
      triggers.push(trigger);
      trigger.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'mouse') return;
        hoveredTrigger = trigger;
        cancelDismiss();
        const focused = focusedTrigger();
        if (!focused || focused === trigger) show(trigger);
      });
      trigger.addEventListener('pointerleave', (event) => {
        if (event.pointerType !== 'mouse') return;
        if (hoveredTrigger === trigger) hoveredTrigger = null;
        scheduleDismiss();
      });
      trigger.addEventListener('focusin', () => {
        cancelDismiss();
        if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
        focusFrame = requestAnimationFrame(() => {
          focusFrame = undefined;
          if (trigger.contains(document.activeElement)) show(trigger);
        });
      });
      trigger.addEventListener('focusout', scheduleDismiss);
      trigger.addEventListener('click', () => show(trigger));
    },
  };
};

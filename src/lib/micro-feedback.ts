import { siteConfig } from '../config/site';
import { animateMotion, setFeedbackText } from './motion';

export type TaskState = 'idle' | 'pending' | 'success' | 'error';
export function markTaskState(target: HTMLElement, state: TaskState) {
  if (state === 'idle') delete target.dataset.taskState;
  else target.dataset.taskState = state;
  target.style.setProperty('--status-spin-duration', `${siteConfig.interactionFeedback.statusSpinMilliseconds}ms`);
}
export function setTaskFeedback(target: HTMLElement, text: string, state: TaskState) {
  markTaskState(target, text ? state : 'idle');
  setFeedbackText(target, text);
}

// 选中面保留同一 C2 轮廓；连续操作从当前可见位置接续，不改变原控件语义。
export function moveSelectionSurface(surface: HTMLElement, target: HTMLElement, duration: number, stretch = 0, instant = false) {
  const parent = surface.offsetParent;
  if (!(parent instanceof HTMLElement)) return;
  const origin = parent.getBoundingClientRect();
  const destination = target.getBoundingClientRect();
  const previous = surface.getBoundingClientRect();
  const first = !surface.hasAttribute('data-positioned');
  surface.getAnimations().forEach((animation) => animation.cancel());
  const left = destination.left - origin.left + parent.scrollLeft - parent.clientLeft;
  const top = destination.top - origin.top + parent.scrollTop - parent.clientTop;
  const frame = { left: `${left}px`, top: `${top}px`, width: `${destination.width}px`, height: `${destination.height}px` };
  Object.assign(surface.style, frame);
  surface.dataset.positioned = '';
  if (first || instant) return;
  const initial = { left: `${previous.left - origin.left + parent.scrollLeft - parent.clientLeft}px`, top: `${previous.top - origin.top + parent.scrollTop - parent.clientTop}px`, width: `${previous.width}px`, height: `${previous.height}px` };
  const distance = destination.left - previous.left;
  const middleWidth = Math.max(previous.width, destination.width) + Math.min(Math.abs(distance) * stretch, destination.width * .5);
  const frames: Keyframe[] = stretch ? [initial, { left: `${left - (distance > 0 ? middleWidth - destination.width : 0)}px`, top: frame.top, width: `${middleWidth}px`, height: frame.height, offset: .65 }, frame] : [initial, frame];
  animateMotion(surface, frames, { duration, easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() });
}

export function initializeMicroFeedback() {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const configuration = siteConfig.interactionFeedback;
  const segments = [...document.querySelectorAll<HTMLElement>('[data-rubber-segment]')];
  const updateSegments = (instant = false) => segments.forEach((segment) => {
    const surface = segment.querySelector<HTMLElement>('.rubber-segment__indicator');
    const active = segment.querySelector<HTMLElement>('a[aria-current="page"],a[aria-current="true"]');
    if (!surface || !active) return;
    moveSelectionSurface(surface, active, configuration.segmentMilliseconds, configuration.segmentStretchRatio, instant);
    segment.dataset.segmentReady = '';
  });
  document.addEventListener('articles:updated', () => updateSegments(), options);
  window.addEventListener('resize', () => updateSegments(true), options);
  const resize = new ResizeObserver(() => updateSegments(true));
  segments.forEach((segment) => resize.observe(segment));
  updateSegments(true);
  void document.fonts.ready.then(() => { if (!controller.signal.aborted) updateSegments(true); });

  document.addEventListener('visibilitychange', () => { document.documentElement.toggleAttribute('data-feedback-hidden', document.hidden); }, options);
  window.addEventListener('pagehide', (event) => {
    segments.forEach((segment) => segment.querySelector('.rubber-segment__indicator')?.getAnimations().forEach((animation) => animation.cancel()));
    if (!event.persisted) { controller.abort(); resize.disconnect(); }
  }, options);
}

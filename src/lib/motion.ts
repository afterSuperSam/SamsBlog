import { siteConfig } from '../config/site';

const preference = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new Set<Animation>();
export const motionDisabled = () => preference.matches || document.documentElement.classList.contains('motion-paused');

export function animateMotion(target: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  if (motionDisabled()) return;
  const animation = target.animate(keyframes, options);
  animations.add(animation);
  animation.onfinish = animation.oncancel = () => animations.delete(animation);
  return animation;
}

export function createCharacters(text: string) {
  return [...text].map((character) => {
    const span = document.createElement('span');
    span.className = 'reveal-character';
    span.textContent = character === ' ' ? '\u00a0' : character;
    span.setAttribute('aria-hidden', 'true');
    return span;
  });
}

export function animateCharacters(target: HTMLElement) {
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-link').trim();
  target.querySelectorAll<HTMLElement>('.reveal-character').forEach((character, index) => {
    animateMotion(character, [{ opacity: 0, translate: '0 .5em', scale: '.92' }, { opacity: 1, translate: '0 0', scale: '1' }], {
      duration: siteConfig.reveal.characterDurationMilliseconds,
      delay: index * siteConfig.reveal.characterStaggerMilliseconds, easing, fill: 'backwards',
    });
  });
}

// 反馈文案保留逐字出现，同时让相邻布局跟随文字高度舒展。
export function animateContentHeight(target: HTMLElement, update: () => void) {
  const previousHeight = target.getBoundingClientRect().height;
  target.getAnimations().filter((animation) => animation.effect instanceof KeyframeEffect
    && animation.effect.getKeyframes().some((frame) => 'height' in frame)).forEach((animation) => animation.cancel());
  update();
  const nextHeight = target.getBoundingClientRect().height;
  if (Math.abs(previousHeight - nextHeight) < 1) return;
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim();
  animateMotion(target, [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], {
    duration: siteConfig.interactions.feedbackResizeMilliseconds, easing,
  });
}

// 暂停和系统减少动效立即恢复最终状态，避免未完成的动画遮住内容。
function finishAnimations() {
  if (!motionDisabled()) return;
  animations.forEach((animation) => animation.cancel());
}
preference.addEventListener('change', finishAnimations);
new MutationObserver(finishAnimations).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

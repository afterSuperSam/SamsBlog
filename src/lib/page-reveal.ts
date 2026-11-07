// 已在首屏出现的内容保持可见，延迟执行的模块不把它再次隐藏。
export function isInitiallyVisible(element: Pick<HTMLElement, 'getBoundingClientRect'>, viewportHeight: number): boolean {
  const bounds = element.getBoundingClientRect();
  return bounds.top <= viewportHeight && bounds.bottom >= 0;
}

export function preparePageReveal(element: Pick<HTMLElement, 'getBoundingClientRect' | 'classList'>, viewportHeight: number): boolean {
  const deferred = !isInitiallyVisible(element, viewportHeight);
  element.classList.toggle('reveal-pending', deferred);
  return deferred;
}

export type SurfacePoint = readonly [number, number];

// 每角由两段三次曲线组成：直边连接处曲率为零，中点一阶、二阶导数相同。
export function readerCornerControls(radius: number): readonly SurfacePoint[] {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('圆角尺寸必须是正有限数。');
  return [[0, 0], [radius / 3, 0], [radius * 2 / 3, 0], [radius * 5 / 6, radius / 6],
    [radius, radius / 3], [radius, radius * 2 / 3], [radius, radius]];
}

export function createReaderSurfacePath(width: number, height: number, cornerSize: number): string {
  if (![width, height, cornerSize].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError('轮廓尺寸必须是正有限数。');
  const radius = Math.min(cornerSize, width / 2, height / 2);
  const controls = readerCornerControls(radius);
  const number = (value: number) => String(Number(value.toFixed(6)));
  const point = (horizontal: number, vertical: number) => `${number(horizontal)} ${number(vertical)}`;
  const corner = (transform: (point: SurfacePoint) => SurfacePoint) => {
    const transformed = controls.slice(1).map((value) => transform(value)).map(([horizontal, vertical]) => point(horizontal, vertical));
    return `C ${transformed.slice(0, 3).join(' ')} C ${transformed.slice(3).join(' ')}`;
  };
  return `M ${point(radius, 0)} L ${point(width - radius, 0)} ${corner(([horizontal, vertical]) => [width - radius + horizontal, vertical])}`
    + ` L ${point(width, height - radius)} ${corner(([horizontal, vertical]) => [width - vertical, height - radius + horizontal])}`
    + ` L ${point(radius, height)} ${corner(([horizontal, vertical]) => [radius - horizontal, height - vertical])}`
    + ` L ${point(0, radius)} ${corner(([horizontal, vertical]) => [vertical, radius - horizontal])} Z`;
}

// 仅裁剪背景伪元素；内容、焦点轮廓和头像均保持原有边界。
export function initializeReaderSurfaces(root: HTMLElement) {
  const observed = new WeakSet<HTMLElement>();
  const update = (target: HTMLElement, width: number, height: number) => {
    if (!width || !height) return;
    const configured = Number.parseFloat(getComputedStyle(target).getPropertyValue('--reader-corner-size'));
    const corner = target.matches('button,a,.reader-card-count,.reader-method-badge,[data-account-website]') ? Math.min(width, height) / 2 : configured;
    if (!Number.isFinite(corner) || corner <= 0) return;
    target.style.setProperty('--reader-surface-fallback-radius', '0px');
    target.style.setProperty('--reader-surface-path', `path("${createReaderSurfacePath(width, height, corner)}")`);
  };
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      update(target, entry.borderBoxSize[0]?.inlineSize || target.offsetWidth, entry.borderBoxSize[0]?.blockSize || target.offsetHeight);
    }
  });
  const refresh = () => {
    const elements = [...root.querySelectorAll<HTMLElement>('.reader-paper,button:not([data-avatar-select]),.reader-card-count,.reader-method-badge,[data-account-website]')];
    elements.forEach((element) => {
      if (observed.has(element)) return;
      observed.add(element); element.classList.add('reader-curved-surface');
      const bounds = element.getBoundingClientRect();
      update(element, bounds.width, bounds.height);
      resize.observe(element);
    });
  };
  refresh();
  if (root.matches('[data-reader-account-page]')) {
    const presentation = document.documentElement;
    if (presentation.dataset.readerSurfaces === 'pending') presentation.dataset.readerSurfaces = 'ready';
    window.dispatchEvent(new Event('reader:surfaces-ready'));
  }
  const mutations = new MutationObserver(refresh);
  mutations.observe(root, { childList: true, subtree: true });
}

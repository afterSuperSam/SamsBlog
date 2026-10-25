import { siteConfig } from '../config/site';

export function initializeArticleImageViewer(prose: HTMLElement, dialog: HTMLDialogElement) {
  // 原生模态对话框处理焦点与 Escape，图片区域保留系统触摸缩放。
  const configuration = siteConfig.articleReading;
  let fullImage = dialog.querySelector<HTMLImageElement>('[data-image-full]')!;
  const viewport = dialog.querySelector<HTMLElement>('[data-image-viewport]')!;
  const zoom = dialog.querySelector<HTMLButtonElement>('[data-image-zoom]')!;
  const imageStatus = dialog.querySelector<HTMLElement>('[data-image-status]')!;
  const retry = dialog.querySelector<HTMLButtonElement>('[data-image-retry]')!;
  let pendingImage: HTMLImageElement | undefined;
  let imageTimeout: ReturnType<typeof setTimeout> | undefined;
  let imageAddress = '';
  let imageDescription = '';
  let imageAttempt = 0;
  let imageTrigger: HTMLElement | undefined;
  let previousOverflow = '';
  const resetZoom = () => {
    fullImage.style.removeProperty('width'); dialog.classList.remove('is-zoomed');
    zoom.setAttribute('aria-pressed', 'false'); zoom.textContent = '放大图片';
    viewport.scrollTo(0, 0);
  };
  const cancelImageLoad = () => {
    clearTimeout(imageTimeout);
    if (pendingImage) { pendingImage.onload = null; pendingImage.onerror = null; pendingImage.removeAttribute('src'); pendingImage = undefined; }
  };
  const loadImage = () => {
    cancelImageLoad(); resetZoom();
    const attempt = ++imageAttempt;
    const loader = new Image(); pendingImage = loader;
    fullImage.hidden = true; zoom.disabled = true; retry.disabled = true;
    imageStatus.textContent = '正在加载图片…'; viewport.setAttribute('aria-busy', 'true');
    const fail = () => {
      if (attempt !== imageAttempt || !dialog.open) return;
      cancelImageLoad(); viewport.setAttribute('aria-busy', 'false');
      imageStatus.textContent = '图片暂时未能加载，可以在这里重试。'; retry.hidden = false; retry.disabled = false;
    };
    loader.onload = () => {
      if (attempt !== imageAttempt || !dialog.open) return;
      if (!loader.naturalWidth) { fail(); return; }
      clearTimeout(imageTimeout); pendingImage = undefined; loader.onload = null; loader.onerror = null;
      loader.dataset.imageFull = ''; loader.alt = imageDescription;
      fullImage.replaceWith(loader); fullImage = loader;
      viewport.setAttribute('aria-busy', 'false'); imageStatus.textContent = ''; zoom.disabled = false;
      if (document.activeElement === retry) zoom.focus({ preventScroll: true });
      retry.hidden = true; retry.disabled = false;
    };
    loader.onerror = fail; loader.referrerPolicy = 'no-referrer'; loader.decoding = 'async';
    imageTimeout = setTimeout(fail, configuration.imageLoadTimeoutMilliseconds);
    loader.src = imageAddress;
  };
  retry.addEventListener('click', loadImage);
  prose.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const link = image.closest<HTMLAnchorElement>('a');
    // 外部目标和多图链接保留原始导航，只有明确的单图链接参与放大。
    if (link && (link.querySelectorAll('img').length !== 1 || ![image.src, image.currentSrc].includes(link.href))) return;
    const trigger = link || document.createElement('button');
    if (!link) {
      (trigger as HTMLButtonElement).type = 'button';
      trigger.className = 'article-image-trigger';
      image.before(trigger); trigger.append(image);
    }
    if (!link || link.querySelector('img') === image) trigger.setAttribute('aria-label', `放大图片：${image.alt || '正文图片'}`);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.addEventListener('click', (event) => {
      if (link && event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
      event.preventDefault();
      imageTrigger = trigger;
      imageAddress = image.currentSrc || image.src; imageDescription = image.alt;
      dialog.querySelector<HTMLElement>('[data-image-caption]')!.textContent = image.alt;
      resetZoom();
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
      retry.hidden = true; loadImage();
    });
  });
  zoom.addEventListener('click', () => {
    if (dialog.classList.contains('is-zoomed')) { resetZoom(); return; }
    fullImage.style.width = `${Math.max(fullImage.getBoundingClientRect().width, viewport.clientWidth) * configuration.imageZoomScale}px`;
    dialog.classList.add('is-zoomed'); zoom.setAttribute('aria-pressed', 'true'); zoom.textContent = '适应屏幕';
  });
  dialog.querySelector('[data-image-close]')!.addEventListener('click', () => dialog.close());
  let backdropPressed = false;
  dialog.addEventListener('pointerdown', (event) => { backdropPressed = event.target === dialog || event.target === viewport; });
  dialog.addEventListener('click', (event) => {
    if (backdropPressed && (event.target === dialog || event.target === viewport)) dialog.close();
    backdropPressed = false;
  });
  dialog.addEventListener('close', () => {
    imageAttempt++; cancelImageLoad(); imageStatus.textContent = ''; retry.hidden = true;
    document.body.style.overflow = previousOverflow;
    imageTrigger?.focus({ preventScroll: true });
    fullImage.removeAttribute('src'); resetZoom();
  });
}

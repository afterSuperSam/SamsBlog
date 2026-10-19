import { siteConfig } from '../config/site';
import { motionDisabled } from './motion';

const root = document.querySelector<HTMLElement>('[data-article-reading]');
const prose = root?.querySelector<HTMLElement>('[data-article-prose]');

if (root && prose) {
  const configuration = siteConfig.articleReading;
  const status = root.querySelector<HTMLElement>('[data-reading-status]')!;
  const mode = root.querySelector<HTMLButtonElement>('[data-reading-mode]')!;
  const resume = root.querySelector<HTMLButtonElement>('[data-reading-resume]')!;
  root.querySelector<HTMLElement>('[data-reading-tools]')!.hidden = false;
  const applyMode = (enabled: boolean) => {
    document.body.classList.toggle('article-reading-mode', enabled);
    mode.setAttribute('aria-pressed', String(enabled));
    mode.textContent = enabled ? '退出舒适阅读' : '舒适阅读';
  };
  try { applyMode(localStorage.getItem(configuration.preferenceStorageKey) === 'true'); }
  catch (error) { console.warn('Reading preference unavailable', error); }
  mode.addEventListener('click', () => {
    const enabled = mode.getAttribute('aria-pressed') !== 'true';
    applyMode(enabled);
    try { localStorage.setItem(configuration.preferenceStorageKey, String(enabled)); }
    catch (error) { console.warn('Reading preference save failed', error); status.textContent = '本机无法保存设置，本次切换仍然有效。'; }
  });

  // 位置只在读者主动选择后恢复，不接管目录锚点或浏览器返回滚动。
  interface ReadingPosition { version: string; progress: number; heading: string; offset: number; updatedAt: number }
  const positions = (): Record<string, ReadingPosition> => {
    const parsed: unknown = JSON.parse(localStorage.getItem(configuration.positionStorageKey) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([identifier, value]) => /^\d+$/.test(identifier)
      && value && typeof value.version === 'string' && typeof value.heading === 'string'
      && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1
      && Number.isFinite(value.offset) && Number.isFinite(value.updatedAt)));
  };
  const identifier = root.dataset.articleId!;
  let saved: ReadingPosition | undefined;
  try { saved = positions()[identifier]; }
  catch (error) { console.warn('Reading position unavailable', error); }
  resume.hidden = !saved || saved.version !== root.dataset.articleVersion;
  const headerOffset = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) + 24;
  resume.addEventListener('click', () => {
    if (!saved) return;
    const heading = saved.heading ? document.getElementById(saved.heading) : undefined;
    const top = heading && prose.contains(heading)
      ? heading.getBoundingClientRect().top + window.scrollY + saved.offset - headerOffset()
      : prose.getBoundingClientRect().top + window.scrollY + saved.progress * prose.offsetHeight - headerOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: motionDisabled() ? 'instant' : 'smooth' });
    (heading || prose).focus({ preventScroll: true });
    status.textContent = '已回到上次阅读位置。';
  });
  prose.tabIndex = -1;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let moved = false;
  const savePosition = () => {
    saveTimer = undefined;
    if (!moved || document.querySelector('[data-article-image-dialog][open]')) return;
    const offset = headerOffset();
    const bounds = prose.getBoundingClientRect();
    if (offset - bounds.top < configuration.positionMinimumPixels || bounds.bottom < 0) return;
    const heading = [...prose.querySelectorAll<HTMLElement>('[id]')].reverse().find((item) => item.getBoundingClientRect().top <= offset);
    const position: ReadingPosition = {
      version: root.dataset.articleVersion!, progress: Math.max(0, Math.min(1, (offset - bounds.top) / prose.offsetHeight)),
      heading: heading?.id || '', offset: heading ? offset - heading.getBoundingClientRect().top : 0, updatedAt: Date.now(),
    };
    try {
      const entries = { ...positions(), [identifier]: position };
      localStorage.setItem(configuration.positionStorageKey, JSON.stringify(Object.fromEntries(Object.entries(entries)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, configuration.positionLimit))));
    } catch (error) { console.warn('Reading position save failed', error); }
  };
  window.addEventListener('scroll', () => {
    moved = true;
    if (!saveTimer) saveTimer = setTimeout(savePosition, configuration.positionSaveMilliseconds);
  }, { passive: true });
  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });

  // 代码工具从原始文本复制，换行只影响排版，不修改代码内容。
  prose.querySelectorAll<HTMLPreElement>('pre').forEach((block) => {
    const code = block.querySelector('code');
    if (!code) return;
    const tools = document.createElement('div');
    tools.className = 'article-code-tools';
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'article-code-copy copy-feedback';
    copy.setAttribute('aria-live', 'polite'); copy.setAttribute('aria-atomic', 'true');
    const copyLabel = document.createElement('span');
    copyLabel.textContent = '复制代码'; copy.append(copyLabel);
    let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const wrap = document.createElement('button');
    wrap.type = 'button'; wrap.textContent = '自动换行'; wrap.setAttribute('aria-pressed', 'false');
    tools.append(copy, wrap);
    block.before(tools);
    block.tabIndex = 0;
    block.setAttribute('aria-label', '代码，可横向滚动');
    copy.addEventListener('click', async () => {
      if (copy.disabled) return;
      clearTimeout(copyFeedbackTimer);
      copy.disabled = true;
      copy.dataset.copyState = 'pending'; copyLabel.textContent = '复制中…';
      status.textContent = '';
      try {
        await navigator.clipboard.writeText(code.textContent || '');
        copy.dataset.copyState = 'success'; copyLabel.textContent = '复制成功';
        copyFeedbackTimer = setTimeout(() => {
          delete copy.dataset.copyState; copyLabel.textContent = '复制代码';
        }, configuration.copyFeedbackMilliseconds);
      }
      catch (error) {
        console.warn('Code clipboard write failed', error);
        copy.dataset.copyState = 'error'; copyLabel.textContent = '复制失败，请手动选择';
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        block.focus({ preventScroll: true });
        status.textContent = '无法直接复制，已选中代码，请使用系统复制。';
      }
      finally { copy.disabled = false; }
    });
    wrap.addEventListener('click', () => {
      const enabled = block.classList.toggle('article-code-wrap');
      wrap.setAttribute('aria-pressed', String(enabled));
      block.setAttribute('aria-label', enabled ? '代码，自动换行' : '代码，可横向滚动');
    });
  });

  // 原生模态对话框处理焦点与 Escape，图片区域保留系统触摸缩放。
  const dialog = document.querySelector<HTMLDialogElement>('[data-article-image-dialog]')!;
  const fullImage = dialog.querySelector<HTMLImageElement>('[data-image-full]')!;
  const viewport = dialog.querySelector<HTMLElement>('[data-image-viewport]')!;
  const zoom = dialog.querySelector<HTMLButtonElement>('[data-image-zoom]')!;
  let imageTrigger: HTMLElement | undefined;
  let previousOverflow = '';
  const resetZoom = () => {
    fullImage.style.removeProperty('width'); dialog.classList.remove('is-zoomed');
    zoom.setAttribute('aria-pressed', 'false'); zoom.textContent = '放大图片';
    viewport.scrollTo(0, 0);
  };
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
      fullImage.src = image.currentSrc || image.src; fullImage.alt = image.alt;
      dialog.querySelector<HTMLElement>('[data-image-caption]')!.textContent = image.alt;
      resetZoom();
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal();
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
    document.body.style.overflow = previousOverflow;
    imageTrigger?.focus({ preventScroll: true });
    fullImage.removeAttribute('src'); resetZoom();
  });
}

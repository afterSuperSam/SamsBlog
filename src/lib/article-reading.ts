import { siteConfig } from '../config/site';
import { motionDisabled } from './motion';
import { readReadingHistory, saveReadingHistory, measureReadingChapters, type ReadingPosition } from './reading-history';
import { initializeReadingExtras } from './reading-extras';

const root = document.querySelector<HTMLElement>('[data-article-reading]');
const prose = root?.querySelector<HTMLElement>('[data-article-prose]');

if (root && prose) {
  const configuration = siteConfig.articleReading;
  const status = root.querySelector<HTMLElement>('[data-reading-status]')!;
  const mode = root.querySelector<HTMLButtonElement>('[data-reading-mode]')!;
  const font = root.querySelector<HTMLButtonElement>('[data-reading-font]')!;
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
  const applyFont = (enabled: boolean) => {
    document.documentElement.dataset.articleFont = enabled ? 'default' : 'handwritten';
    font.setAttribute('aria-pressed', String(enabled));
    font.textContent = enabled ? '恢复艺术字体' : '使用默认字体';
  };
  applyFont(document.documentElement.dataset.articleFont === 'default');
  font.addEventListener('click', () => {
    const enabled = font.getAttribute('aria-pressed') !== 'true';
    applyFont(enabled);
    try { localStorage.setItem(configuration.fontPreferenceStorageKey, enabled ? 'default' : 'handwritten'); }
    catch (error) { console.warn('Reading font preference save failed', error); status.textContent = '本机无法保存字体设置，本次切换仍然有效。'; }
  });

  // 位置只在读者主动选择后恢复，不接管目录锚点或浏览器返回滚动。
  const positions = readReadingHistory;
  const identifier = root.dataset.articleId!;
  let saved: ReadingPosition | undefined;
  try { saved = positions()[identifier]; }
  catch (error) { console.warn('Reading position unavailable', error); }
  resume.hidden = !saved || saved.progress === 0 || saved.version !== root.dataset.articleVersion;
  const title = root.querySelector('h1')!.textContent || '';
  const visitedAt = Date.now();
  try {
    saveReadingHistory({ ...positions(), [identifier]: {
      ...(saved && saved.version === root.dataset.articleVersion ? saved : { version: root.dataset.articleVersion!, progress: 0, heading: '', offset: 0, updatedAt: visitedAt }),
      title, visitedAt,
    } });
  } catch (error) { console.warn('Reading trail save failed', error); }
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
  // 桌面目录停留在正文旁，手机仍用原来的折叠入口与唯一标题锚点。
  const toc = root.querySelector<HTMLDetailsElement>('.article-toc');
  const tocNavigation = toc?.querySelector<HTMLElement>('nav');
  const chapters = [...toc?.querySelectorAll<HTMLAnchorElement>('a[href^="#"]') || []].flatMap((link) => {
    const heading = document.getElementById(link.getAttribute('href')!.slice(1));
    return heading && prose.contains(heading) ? [{ link, heading }] : [];
  });
  let tocFrame = 0;
  let tocSidebar: boolean | undefined;
  let currentChapter: HTMLAnchorElement | undefined;
  const updateToc = () => {
    tocFrame = 0;
    if (!toc || !tocNavigation) return;
    const sidebar = getComputedStyle(toc).position === 'sticky';
    if (sidebar !== tocSidebar) { tocSidebar = sidebar; toc.open = sidebar; }
    const offset = headerOffset();
    const positions = chapters.map(({ heading }) => ({ top: heading.getBoundingClientRect().top, level: Number(heading.tagName.slice(1)) }));
    const measurements = measureReadingChapters(positions, prose.getBoundingClientRect().bottom, offset);
    const current = chapters[positions.findLastIndex(({ top }) => top <= offset + 1)] || chapters[0];
    chapters.forEach(({ link }, index) => {
      if (link === current?.link) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
      link.style.setProperty('--chapter-length', String(measurements[index].lengthRatio));
      link.style.setProperty('--chapter-progress', `${measurements[index].progress * 100}%`);
      link.setAttribute('aria-description', `章节进度 ${Math.round(measurements[index].progress * 100)}%，下方横线长度表示章节篇幅`);
    });
    if (!current || !toc.open) return;
    if (currentChapter !== current.link && sidebar && !toc.matches(':hover') && !toc.contains(document.activeElement)) {
      const viewport = tocNavigation.getBoundingClientRect();
      const item = current.link.getBoundingClientRect();
      if (item.top < viewport.top) tocNavigation.scrollTop -= viewport.top - item.top;
      else if (item.bottom > viewport.bottom) tocNavigation.scrollTop += item.bottom - viewport.bottom;
    }
    currentChapter = current.link;
    tocNavigation.style.setProperty('--toc-active-top', `${current.link.offsetTop}px`);
    tocNavigation.style.setProperty('--toc-active-height', `${current.link.offsetHeight}px`);
  };
  const scheduleToc = () => { if (toc && !tocFrame) tocFrame = requestAnimationFrame(updateToc); };
  toc?.querySelector('summary')?.addEventListener('click', (event) => { if (tocSidebar) event.preventDefault(); });
  toc?.addEventListener('toggle', scheduleToc);
  chapters.forEach(({ link, heading }) => link.addEventListener('click', (event) => {
    if (event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (!tocSidebar && toc) toc.open = false;
    if (location.hash !== link.hash) history.pushState(history.state, '', link.hash);
    heading.scrollIntoView({ block: 'start', behavior: motionDisabled() ? 'instant' : 'smooth' });
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    scheduleToc();
  }));
  if (toc) {
    const observer = new ResizeObserver(scheduleToc);
    observer.observe(prose); observer.observe(toc);
    window.addEventListener('resize', scheduleToc);
    window.addEventListener('pageshow', scheduleToc);
    void document.fonts.ready.then(scheduleToc);
    updateToc();
  }
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
      title, visitedAt,
    };
    try {
      const entries = { ...positions(), [identifier]: position };
      saveReadingHistory(entries);
    } catch (error) { console.warn('Reading position save failed', error); }
  };
  window.addEventListener('scroll', () => {
    moved = true;
    scheduleToc();
    if (!saveTimer) saveTimer = setTimeout(savePosition, configuration.positionSaveMilliseconds);
  }, { passive: true });
  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  initializeReadingExtras(root, prose);

  // 代码工具从原始文本复制，换行只影响排版，不修改代码内容。
  prose.querySelectorAll<HTMLPreElement>('pre').forEach((block, index) => {
    const code = block.querySelector('code');
    if (!code) return;
    const tools = document.createElement('div');
    tools.className = 'article-code-tools';
    const container = document.createElement('div');
    container.className = 'article-code';
    block.before(container);
    container.append(tools, block);
    block.id = `article-code-${index + 1}`;
    const filename = document.createElement('span');
    filename.className = 'article-code-filename';
    filename.textContent = code.dataset.filename || code.className.replace(/^language-/, '');
    const expand = document.createElement('button');
    expand.type = 'button'; expand.textContent = '展开'; expand.hidden = true;
    expand.setAttribute('aria-expanded', 'false'); expand.setAttribute('aria-controls', block.id);
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'article-code-copy copy-feedback';
    copy.setAttribute('aria-live', 'polite'); copy.setAttribute('aria-atomic', 'true');
    const copyLabel = document.createElement('span');
    copyLabel.textContent = '复制代码'; copy.append(copyLabel);
    let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const wrap = document.createElement('button');
    wrap.type = 'button'; wrap.textContent = '自动换行'; wrap.setAttribute('aria-pressed', 'false');
    tools.append(filename, copy, wrap, expand);
    const updateCollapse = () => {
      if (container.dataset.expanded === 'true') return;
      expand.hidden = block.scrollHeight <= block.clientHeight + 1;
    };
    // 同一高度上限用于初始折叠与换行后的重新测量，工具条始终留在滚动区外。
    block.style.maxBlockSize = `${configuration.codeCollapsedLines * 1.8 + 2.5}em`;
    new ResizeObserver(updateCollapse).observe(block);
    expand.addEventListener('click', () => {
      const expanded = expand.getAttribute('aria-expanded') !== 'true';
      container.dataset.expanded = String(expanded);
      expand.setAttribute('aria-expanded', String(expanded)); expand.textContent = expanded ? '收起' : '展开';
      block.style.maxBlockSize = expanded ? 'none' : `${configuration.codeCollapsedLines * 1.8 + 2.5}em`;
      if (!expanded) { block.scrollTop = 0; tools.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
    });
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
      updateCollapse();
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

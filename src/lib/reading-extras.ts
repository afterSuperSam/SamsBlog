import { siteConfig } from '../config/site';
import { animateContentHeight, animateMotion } from './motion';

// 短记录与编辑器卡片共用展开状态，正文仍走安全 Markdown 渲染。
export function initializeInlineNotes(container: ParentNode) {
  container.querySelectorAll<HTMLButtonElement>('[data-note-toggle]').forEach((button) => {
    const card = button.closest<HTMLElement>('.article-card')!;
    const content = card.querySelector<HTMLElement>('[data-note-content]')!;
    const excerpt = content.querySelector<HTMLElement>('[data-card-excerpt]')!;
    const prose = content.querySelector<HTMLElement>('[data-note-prose]')!;
    const setExpanded = (expanded: boolean) => {
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? '收起' : '展开';
      button.setAttribute('aria-label', `${button.textContent}短记录：${card.querySelector('[data-card-title]')!.textContent}`);
      card.dataset.noteExpanded = String(expanded);
      excerpt.hidden = expanded;
      prose.hidden = !expanded;
    };
    const fallback = card.querySelector<HTMLElement>('[data-note-fallback]');
    if (fallback) fallback.hidden = true;
    const refresh = () => {
      const enabled = card.dataset.contentType === 'note';
      const requested = button.dataset.requestedExpanded === 'true';
      // 内容能完整放进摘要时直接展示；结构复杂或有手写摘要的记录仍可展开。
      prose.hidden = false;
      const paragraph = prose.firstElementChild as HTMLElement | null;
      const sameText = prose.textContent?.replace(/\s+/g, '') === excerpt.textContent?.replace(/\s+/g, '');
      const visibleLines = Number.parseInt(getComputedStyle(excerpt).webkitLineClamp, 10);
      const fits = enabled && content.clientWidth > 0 && sameText && prose.children.length === 1
        && paragraph?.tagName === 'P' && !paragraph.querySelector('img')
        && paragraph.scrollHeight <= Number.parseFloat(getComputedStyle(paragraph).lineHeight) * visibleLines + 1;
      button.hidden = !enabled || Boolean(fits);
      setExpanded(enabled && (Boolean(fits) || requested));
    };
    refresh();
    initializeExplanations(prose);
    if (button.dataset.enhanced) return;
    button.dataset.enhanced = 'true';
    let previousWidth = content.clientWidth;
    const observer = new ResizeObserver(() => {
      if (content.clientWidth === previousWidth) return;
      previousWidth = content.clientWidth; refresh();
    });
    observer.observe(content);
    void document.fonts.ready.then(refresh);
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.dataset.requestedExpanded = String(expanded);
      animateContentHeight(content, () => setExpanded(expanded));
    });
  });
}

// 原生 details 保留无脚本阅读；增强只负责展开与收起的高度过渡。
export function initializeExplanations(container: HTMLElement) {
  container.querySelectorAll<HTMLDetailsElement>('.article-explanation').forEach((details) => {
    if (details.dataset.enhanced) return;
    details.dataset.enhanced = 'true';
    const summary = details.querySelector('summary')!;
    let expanded = details.open;
    let animation: Animation | undefined;
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      if (animation?.playState !== 'running') expanded = details.open;
      const height = details.getBoundingClientRect().height;
      animation?.cancel(); expanded = !expanded; details.open = true;
      const nextHeight = expanded ? details.scrollHeight : summary.offsetHeight;
      const targetExpanded = expanded;
      animation = animateMotion(details, [{ height: `${height}px` }, { height: `${nextHeight}px` }], {
        duration: siteConfig.interactions.feedbackResizeMilliseconds,
        easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim(),
      });
      const settle = () => { if (expanded === targetExpanded) details.open = targetExpanded; };
      if (animation) void animation.finished.then(settle, settle); else settle();
    });
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const { segment } of segments.segment(paragraph)) {
      if (line && context.measureText(line + segment).width > width) { lines.push(line); line = ''; }
      line += segment;
    }
    lines.push(line);
  }
  return lines;
}

// 摘录背景复用页面星点与主题色，只绘制一帧，正文下方减淡装饰。
function drawQuoteBackground(context: CanvasRenderingContext2D, width: number, height: number, styles: CSSStyleDeclaration) {
  context.save();
  context.fillStyle = styles.getPropertyValue('--quote-background').trim();
  context.fillRect(0, 0, width, height);
  const halos = [
    { x: 0, y: height * .25, color: '--quote-glow-blue' },
    { x: width, y: height * .85, color: '--quote-glow-pink' },
  ];
  for (const halo of halos) {
    const gradient = context.createRadialGradient(halo.x, halo.y, 0, halo.x, halo.y, width * .66);
    const color = styles.getPropertyValue(halo.color).trim();
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, /^#[\da-f]{6}$/i.test(color) ? `${color}00` : 'transparent');
    context.globalAlpha = Number(styles.getPropertyValue('--quote-halo-opacity'));
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  }
  const padding = siteConfig.readingExtras.quotePadding;
  const stars = [...document.querySelectorAll<HTMLElement>('.ambient-mote')].map((particle, index) => {
    const appearance = getComputedStyle(particle);
    const x = Number(particle.dataset.moteLeft) * width / 100;
    const y = Number(particle.dataset.moteTop) * height / 100;
    return { x, y, index: index + 1, color: appearance.backgroundColor, radius: Number.parseFloat(appearance.width) / 2,
      behindText: x > padding && x < width - padding && y > padding && y < height - padding };
  });
  let connections = 0;
  const constellation = siteConfig.effects.constellation;
  const maximumDistance = Math.hypot(width, height) * constellation.maximumDistanceRatio;
  context.strokeStyle = styles.getPropertyValue('--summer-blue').trim();
  context.lineWidth = 1;
  context.globalAlpha = Number(styles.getPropertyValue('--constellation-line-opacity')) * .65;
  stars.forEach((star, index) => {
    if (star.behindText || connections >= constellation.desktopLineCount) return;
    const next = stars.slice(index + 1).find((other) => !other.behindText && Math.hypot(star.x - other.x, star.y - other.y) < maximumDistance);
    if (!next) return;
    context.beginPath(); context.moveTo(star.x, star.y); context.lineTo(next.x, next.y); context.stroke(); connections++;
  });
  for (const star of stars) {
    context.save(); context.translate(star.x, star.y); context.fillStyle = star.color;
    context.globalAlpha = Number(styles.getPropertyValue('--quote-star-opacity')) * (star.behindText ? .2 : 1);
    const radius = star.radius;
    if (star.index % 5 === 0) {
      context.beginPath(); context.moveTo(0, -radius);
      context.lineTo(radius * .2, -radius * .24); context.lineTo(radius, 0); context.lineTo(radius * .2, radius * .24);
      context.lineTo(0, radius); context.lineTo(-radius * .2, radius * .24); context.lineTo(-radius, 0); context.lineTo(-radius * .2, -radius * .24);
      context.closePath(); context.fill();
    } else if (star.index % 3 === 0) {
      context.rotate(Math.PI / 4); context.fillRect(-radius, -radius, radius * 2, radius * 2);
    } else {
      context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill();
    }
    context.restore();
  }
  context.restore();
}

export function initializeReadingExtras(root: HTMLElement, prose: HTMLElement) {
  initializeExplanations(prose);
  const revealHash = () => {
    let identifier: string;
    try { identifier = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(identifier);
    let opened = false;
    let ancestor = target?.parentElement;
    while (ancestor && prose.contains(ancestor)) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) { ancestor.open = true; opened = true; }
      ancestor = ancestor.parentElement;
    }
    if (opened) target?.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  revealHash(); window.addEventListener('hashchange', revealHash);

  // 引用区块直接生成整段摘录，Canvas 沿用本站字体，不读取正文选区。
  const dialog = document.querySelector<HTMLDialogElement>('[data-quote-dialog]')!;
  const canvas = dialog.querySelector<HTMLCanvasElement>('[data-quote-canvas]')!;
  const download = dialog.querySelector<HTMLAnchorElement>('[data-quote-download]')!;
  const status = dialog.querySelector<HTMLElement>('[data-quote-status]')!;
  let trigger: HTMLButtonElement | undefined;
  let imageUrl = '';
  let previousOverflow = '';
  let generation = 0;
  const exportQuote = async (text: string, button: HTMLButtonElement) => {
    if (!text || dialog.open) return;
    trigger = button;
    const currentGeneration = ++generation;
    const configuration = siteConfig.readingExtras;
    const quote = [...text].slice(0, configuration.quoteMaximumCharacters).join('');
    const title = root.querySelector('h1')!.textContent || siteConfig.name;
    const source = new URL(`/articles/${root.dataset.articleId}`, siteConfig.siteUrl);
    previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    download.removeAttribute('href'); canvas.hidden = true; status.textContent = '正在排版…'; dialog.showModal();
    try {
      const wordmark = document.querySelector<HTMLImageElement>('.site-brand__wordmark');
      const [, loadedWordmark] = await Promise.all([document.fonts.ready, wordmark?.decode().then(() => wordmark).catch((error) => {
        console.warn('Quote wordmark unavailable', error); return null;
      })]);
      if (!dialog.open || currentGeneration !== generation) return;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas context unavailable');
      const styles = getComputedStyle(document.documentElement);
      const font = styles.getPropertyValue('--playful').trim();
      const padding = configuration.quotePadding;
      const width = configuration.quoteWidth;
      context.font = `${configuration.quoteFontSize}px ${font}`;
      const lines = wrapCanvasText(context, quote, width - padding * 2);
      context.font = `${configuration.quoteFontSize * .65}px ${font}`;
      const titleLines = wrapCanvasText(context, title, width - padding * 2);
      const height = Math.max(configuration.quoteMinimumHeight, padding * 3 + lines.length * configuration.quoteLineHeight + titleLines.length * configuration.quoteLineHeight * .6 + 120);
      canvas.width = width; canvas.height = height;
      drawQuoteBackground(context, width, height, styles);
      context.textBaseline = 'top'; context.fillStyle = styles.getPropertyValue('--summer-pink').trim();
      context.font = `${configuration.quoteFontSize * 2}px ${font}`; context.fillText('“', padding - 12, padding - 36);
      context.fillStyle = styles.getPropertyValue('--text').trim(); context.font = `${configuration.quoteFontSize}px ${font}`;
      lines.forEach((line, index) => context.fillText(line, padding, padding + 80 + index * configuration.quoteLineHeight));
      const footer = height - padding - titleLines.length * configuration.quoteLineHeight * .6 - 80;
      context.font = `${configuration.quoteFontSize * .65}px ${font}`; context.fillStyle = styles.getPropertyValue('--text-soft').trim();
      titleLines.forEach((line, index) => context.fillText(line, padding, footer + index * configuration.quoteLineHeight * .6));
      context.fillStyle = styles.getPropertyValue('--summer-blue').trim();
      if (loadedWordmark) {
        const wordmarkHeight = configuration.quoteWordmarkWidth * loadedWordmark.naturalHeight / loadedWordmark.naturalWidth;
        context.drawImage(loadedWordmark, padding, height - padding - wordmarkHeight / 2, configuration.quoteWordmarkWidth, wordmarkHeight);
      } else context.fillText(siteConfig.name, padding, height - padding - 12);
      context.textAlign = 'right'; context.font = `${configuration.quoteFontSize * .5}px ${font}`;
      context.fillText(source.host + source.pathname, width - padding, height - padding - 8, width * .6);
      canvas.hidden = false; canvas.setAttribute('aria-label', `${quote} —— ${title}，${source.href}`);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!dialog.open || currentGeneration !== generation) return;
      if (!blob) throw new Error('Quote image encoding failed');
      imageUrl = URL.createObjectURL(blob); download.href = imageUrl;
      status.textContent = [...text].length > configuration.quoteMaximumCharacters ? `已截取前 ${configuration.quoteMaximumCharacters} 字` : '图片已就绪';
    } catch (error) {
      console.warn('Quote card export failed', error);
      if (currentGeneration === generation) status.textContent = '图片生成失败，请关闭后重试';
    }
  };
  prose.querySelectorAll<HTMLElement>('blockquote').forEach((block) => {
    if (block.parentElement?.closest('blockquote')) return;
    const text = [...block.childNodes].map((node) => node instanceof HTMLElement ? node.innerText : node.textContent).join('\n').trim();
    if (!text) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'article-quote-export'; button.textContent = '摘录成卡';
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => { void exportQuote(text, button); });
    block.classList.add('article-quote'); block.prepend(button);
  });
  dialog.querySelector('[data-quote-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => {
    generation++;
    document.body.style.overflow = previousOverflow;
    if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; download.removeAttribute('href');
    trigger?.focus({ preventScroll: true });
  });
}

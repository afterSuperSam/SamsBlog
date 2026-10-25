import type { ArticleRecord } from './articles';
import { articleExcerpt, renderArticleMarkdown, renderMarkdown } from './markdown';
import { animateMotion } from './motion';
import { siteConfig } from '../config/site';
import { articleContentTypes, articleDateLabel, articleLinkHost } from './article-catalog';
import { initializeExplanations, initializeInlineContent } from './reading-extras';

type PreviewArticle = Omit<ArticleRecord, 'id' | 'deletedAt' | 'publicationStatus'>;

// 编辑器只提供草稿值，预览复用公开页的 Markdown、卡片结构和样式。
export function createArticlePreview(editor: HTMLFormElement) {
  const shell = editor.querySelector<HTMLElement>('[data-preview-shell]')!;
  const reading = shell.querySelector<HTMLElement>('[data-preview-reading]')!;
  const home = shell.querySelector<HTMLElement>('[data-preview-home]')!;
  const card = home.querySelector<HTMLElement>('[data-preview-card]')!;
  const prose = reading.querySelector<HTMLElement>('[data-article-preview]')!;
  const cover = reading.querySelector<HTMLImageElement>('[data-preview-cover]')!;
  const cardCover = card.querySelector<HTMLElement>('.article-card__cover')!;
  const images = [cover, ...cardCover.querySelectorAll<HTMLImageElement>('img')];
  const modes = [...shell.querySelectorAll<HTMLButtonElement>('[data-preview-mode]')];
  const contents = { reading, home };
  let renderedContent: string | undefined;
  let excerpt = '';
  let failedCoverUrl = '';
  modes.forEach((button) => button.addEventListener('click', () => {
    const active = button.dataset.previewMode as keyof typeof contents;
    if (button.getAttribute('aria-pressed') === 'true') return;
    modes.forEach((mode) => mode.setAttribute('aria-pressed', String(mode === button)));
    Object.entries(contents).forEach(([name, panel]) => { panel.hidden = name !== active; });
    animateMotion(contents[active], [{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], {
      duration: siteConfig.interactions.feedbackResizeMilliseconds,
      easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim(),
    });
  }));
  images.forEach((image) => image.addEventListener('error', () => {
    failedCoverUrl = image.src;
    cover.hidden = true;
    cardCover.hidden = true;
  }));
  const setDate = (element: HTMLTimeElement, value: string, compact = false) => {
    element.textContent = articleDateLabel(value, compact);
    if (value) element.dateTime = value;
    else element.removeAttribute('datetime');
  };
  const publicUrl = (value: string, localImage = false) => {
    if (!value.trim() || (!/^https?:\/\//i.test(value.trim()) && !(localImage && /^\/uploads\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(value.trim())))) return '';
    try {
      const url = new URL(value.trim(), location.origin);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };

  return (article: PreviewArticle) => {
    card.dataset.contentType = article.contentType;
    card.querySelector<HTMLElement>('[data-card-kind]')!.textContent = articleContentTypes.find((type) => type.value === article.contentType)!.label;
    const externalUrl = article.contentType === 'link' ? publicUrl(article.externalUrl) : '';
    const host = card.querySelector<HTMLElement>('[data-card-host]')!;
    host.hidden = article.contentType !== 'link';
    host.textContent = articleLinkHost(externalUrl) || '填写链接后显示目标站点';
    const external = reading.querySelector<HTMLElement>('[data-preview-external]')!;
    external.hidden = !externalUrl;
    const externalLink = external.querySelector<HTMLAnchorElement>('a')!;
    if (externalUrl) externalLink.href = externalUrl;
    else externalLink.removeAttribute('href');
    reading.querySelector<HTMLElement>('[data-preview-title]')!.textContent = article.title || '文章题目';
    card.querySelector<HTMLElement>('[data-card-title]')!.textContent = article.title || '文章题目';
    shell.querySelectorAll('[data-preview-title],[data-card-title]').forEach((title) => title.classList.toggle('article-title--starred', article.starred));
    shell.querySelectorAll<HTMLElement>('[data-preview-source],[data-card-source]').forEach((element) => { element.textContent = article.source === 'original' ? '原创' : '搬运'; });
    shell.querySelectorAll<HTMLElement>('[data-preview-category],[data-card-category]').forEach((element) => { element.textContent = article.category === 'discussion' ? '杂谈' : '日志'; });
    shell.querySelectorAll<HTMLElement>('[data-preview-tags],[data-card-tags]').forEach((container) => {
      container.hidden = !article.tags.length;
      container.replaceChildren(...article.tags.map((tag) => {
        const span = document.createElement('span');
        span.textContent = '# ' + tag;
        return span;
      }));
    });
    setDate(reading.querySelector('[data-preview-created]')!, article.createdAt);
    setDate(reading.querySelector('[data-preview-updated]')!, article.updatedAt);
    setDate(card.querySelector('[data-card-date]')!, article.createdAt, article.contentType === 'update');
    const attribution = reading.querySelector<HTMLElement>('[data-preview-attribution]')!;
    const author = attribution.querySelector<HTMLElement>('[data-preview-author]')!;
    const original = attribution.querySelector<HTMLAnchorElement>('a')!;
    const originalUrl = publicUrl(article.originalUrl);
    attribution.hidden = article.source !== 'repost' || (!article.originalAuthor.trim() && !originalUrl);
    author.textContent = article.originalAuthor.trim() ? '原作者：' + article.originalAuthor.trim() : '';
    original.hidden = !originalUrl;
    if (originalUrl) original.href = originalUrl;
    else original.removeAttribute('href');
    if (renderedContent !== article.content) {
      const rendered = renderArticleMarkdown(article.content);
      card.querySelector<HTMLElement>('[data-note-prose]')!.innerHTML = renderMarkdown(article.content);
      prose.innerHTML = rendered.html || '<p class="article-editor__empty">写下正文后，预览会出现在这里。</p>';
      initializeExplanations(prose);
      const headingIds = new Set(rendered.headings.map((heading) => heading.id));
      prose.querySelectorAll<HTMLElement>('[id]').forEach((heading) => { heading.id = 'article-preview-' + heading.id; });
      prose.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
        const href = link.getAttribute('href')!;
        if (href.startsWith('#') && headingIds.has(href.slice(1))) link.href = '#article-preview-' + href.slice(1);
        else if (!href.startsWith('#')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      });
      const toc = reading.querySelector<HTMLElement>('[data-preview-toc]')!;
      toc.hidden = rendered.headings.length === 0;
      toc.querySelector('summary span')!.textContent = rendered.headings.length + ' 节';
      toc.querySelector('ol')!.replaceChildren(...rendered.headings.map((heading) => {
        const item = document.createElement('li');
        item.dataset.level = String(heading.level);
        item.dataset.depth = String(Math.min(2, heading.level - Math.min(...rendered.headings.map((entry) => entry.level))));
        const link = document.createElement('a');
        link.href = '#article-preview-' + heading.id;
        link.textContent = heading.text;
        item.append(link);
        return item;
      }));
      excerpt = articleExcerpt(article.content);
      renderedContent = article.content;
    }
    card.querySelector<HTMLElement>('[data-card-excerpt]')!.textContent = article.summary.trim() || excerpt || '正文的前两行摘要会显示在这里。';
    initializeInlineContent(card);
    const imageUrl = publicUrl(article.coverUrl, true);
    const showImage = Boolean(imageUrl) && imageUrl !== failedCoverUrl;
    const usesCoverLayout = Boolean(imageUrl) && article.cardLayout !== 'text' && article.contentType === 'article';
    images.forEach((image) => {
      if (imageUrl && image.getAttribute('src') !== imageUrl) image.src = imageUrl;
      else if (!imageUrl) image.removeAttribute('src');
    });
    cover.hidden = !showImage;
    card.dataset.imageSide = article.cardLayout;
    cardCover.hidden = !showImage || !usesCoverLayout;
    card.classList.toggle('article-card--cover', usesCoverLayout);
  };
}

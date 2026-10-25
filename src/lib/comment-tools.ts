import { siteConfig } from '../config/site';
import { animateMotion } from './motion';

const discussion = siteConfig.discussion;

export function parseRecentEmoticons(raw: string | null): string[] {
  if (!raw) return [];
  let values: unknown;
  try { values = JSON.parse(raw); } catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && discussion.emoticons.some((emoticon) => emoticon === value)))].slice(0, discussion.recentEmoticonLimit);
}

export function insertCommentText(value: string, text: string, start: number, end: number, maximumLength: number) {
  const selectionStart = Math.max(0, Math.min(value.length, start));
  const selectionEnd = Math.max(selectionStart, Math.min(value.length, end));
  if (maximumLength >= 0 && value.length - (selectionEnd - selectionStart) + text.length > maximumLength) return null;
  return { value: value.slice(0, selectionStart) + text + value.slice(selectionEnd), position: selectionStart + text.length };
}

// 留言与评论共用输入辅助，原生选区和既有手绘光标继续处理编辑位置。
export function initializeCommentInput(form: HTMLFormElement, textarea: HTMLTextAreaElement) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let selectionStart = textarea.selectionStart;
  let selectionEnd = textarea.selectionEnd;
  let composing = false;
  let compositionAwaitingRelease = false;
  let recent: string[] = [];
  let storageAvailable = true;
  try { recent = parseRecentEmoticons(localStorage.getItem(discussion.recentEmoticonStorageKey)); }
  catch (error) { storageAvailable = false; console.warn('Comment emoticon storage unavailable', error); }

  const originalStyle = { height: textarea.style.height, maxHeight: textarea.style.maxHeight, overflowY: textarea.style.overflowY };
  const tools = document.createElement('div');
  tools.className = 'comment-input-tools';
  const picker = document.createElement('details');
  picker.className = 'comment-emoticons';
  const summary = document.createElement('summary');
  summary.textContent = '颜文字';
  const groups = document.createElement('div');
  groups.className = 'comment-emoticon-groups';
  picker.append(summary, groups);
  const notice = document.createElement('span');
  notice.className = 'comment-input-notice';
  notice.setAttribute('role', 'status');
  tools.append(picker, notice);
  (textarea.closest('label') || textarea).after(tools);

  let pickerExpanded = false;
  let pickerRevision = 0;
  let pickerAnimation: Animation | undefined;
  let contentAnimation: Animation | undefined;
  const setPickerOpen = (expanded: boolean) => {
    const revision = ++pickerRevision;
    pickerExpanded = expanded; picker.dataset.expanded = String(expanded);
    if (!picker.open && !expanded) { renderEmoticons(); return; }
    const height = picker.getBoundingClientRect().height;
    const opacity = picker.open ? getComputedStyle(groups).opacity : '0';
    pickerAnimation?.cancel(); contentAnimation?.cancel();
    picker.open = true; groups.inert = !expanded;
    const options = { duration: siteConfig.interactions.feedbackResizeMilliseconds, easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() };
    pickerAnimation = animateMotion(picker, [{ height: `${height}px` }, { height: `${expanded ? picker.scrollHeight : summary.offsetHeight}px` }], options);
    contentAnimation = animateMotion(groups, [{ opacity }, { opacity: expanded ? 1 : 0 }], options);
    const settle = () => {
      if (revision !== pickerRevision) return;
      picker.open = expanded;
      if (!expanded) renderEmoticons();
    };
    if (pickerAnimation) void pickerAnimation.finished.then(settle, settle); else settle();
  };
  summary.addEventListener('click', (event) => { event.preventDefault(); setPickerOpen(!pickerExpanded); }, options);

  const rememberSelection = () => {
    selectionStart = textarea.selectionStart;
    selectionEnd = textarea.selectionEnd;
  };
  const resize = () => {
    const styles = getComputedStyle(textarea);
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const border = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    const borderBox = styles.boxSizing === 'border-box';
    const maximum = discussion.textareaMaximumLines * lineHeight + (borderBox ? padding + border : 0);
    const minimum = Math.min(maximum, Math.max(parseFloat(styles.minHeight) || 0, Math.min(textarea.rows, discussion.textareaMaximumLines) * lineHeight + (borderBox ? padding + border : 0)));
    textarea.style.maxHeight = `${maximum}px`;
    textarea.style.height = '0px';
    textarea.style.overflowY = 'hidden';
    const contentHeight = textarea.scrollHeight + (borderBox ? border : -padding);
    textarea.style.height = `${Math.max(minimum, Math.min(maximum, contentHeight))}px`;
    textarea.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
  };
  const insertText = (text: string) => {
    if (textarea.disabled || textarea.readOnly || composing || textarea.dataset.composing === 'true') return false;
    const insertion = insertCommentText(textarea.value, text, selectionStart, selectionEnd, textarea.maxLength);
    const maximumCharacters = Number(textarea.dataset.characterMaximum);
    if (!insertion || (Number.isSafeInteger(maximumCharacters) && maximumCharacters > 0 && Array.from(insertion.value).length > maximumCharacters)) {
      notice.textContent = `内容最多 ${maximumCharacters > 0 ? maximumCharacters : textarea.maxLength} 字，请删减后再添加。`;
      textarea.focus({ preventScroll: true });
      return false;
    }
    textarea.setRangeText(text, selectionStart, selectionEnd, 'end');
    textarea.focus({ preventScroll: true });
    rememberSelection();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
    notice.textContent = '';
    return true;
  };
  const renderEmoticons = () => {
    groups.replaceChildren();
    const appendGroup = (title: string, values: readonly string[]) => {
      if (!values.length) return;
      const group = document.createElement('div');
      group.className = 'comment-emoticon-group';
      const label = document.createElement('span');
      label.textContent = title;
      const choices = document.createElement('div');
      choices.className = 'comment-emoticon-options';
      values.forEach((value) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = value;
        button.setAttribute('aria-label', `插入颜文字 ${value}`);
        button.addEventListener('pointerdown', (event) => { event.preventDefault(); }, options);
        button.addEventListener('click', () => {
          if (!insertText(value)) return;
          recent = [value, ...recent.filter((entry) => entry !== value)].slice(0, discussion.recentEmoticonLimit);
          if (storageAvailable) {
            try { localStorage.setItem(discussion.recentEmoticonStorageKey, JSON.stringify(recent)); }
            catch (error) { storageAvailable = false; console.warn('Comment emoticon storage write failed', error); }
          }
          if (!storageAvailable) notice.textContent = '当前浏览器无法保存最近使用记录。';
          setPickerOpen(false);
        }, options);
        choices.append(button);
      });
      group.append(label, choices);
      groups.append(group);
    };
    appendGroup('最近使用', recent);
    appendGroup('精选', discussion.emoticons.filter((emoticon) => !recent.includes(emoticon)));
  };
  renderEmoticons();
  ['input', 'select', 'keyup', 'click'].forEach((event) => textarea.addEventListener(event, rememberSelection, options));
  textarea.addEventListener('input', () => { resize(); notice.textContent = ''; }, options);
  textarea.addEventListener('compositionstart', () => { composing = true; compositionAwaitingRelease = false; }, options);
  textarea.addEventListener('compositionend', () => { composing = false; compositionAwaitingRelease = true; rememberSelection(); resize(); }, options);
  textarea.addEventListener('keyup', () => { if (!composing) compositionAwaitingRelease = false; }, options);
  textarea.addEventListener('keydown', (event) => {
    const compositionKey = event.isComposing || Reflect.get(event, 'keyCode') === 229;
    if (event.key !== 'Enter') { if (!composing && !compositionKey) compositionAwaitingRelease = false; return; }
    if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (composing || compositionKey || compositionAwaitingRelease || textarea.disabled || textarea.readOnly) return;
    event.preventDefault();
    const submitter = form.querySelector<HTMLButtonElement | HTMLInputElement>('button[type="submit"], input[type="submit"], button:not([type])');
    if (submitter?.disabled) return;
    form.requestSubmit(submitter || undefined);
  }, options);
  document.addEventListener('selectionchange', () => { if (document.activeElement === textarea) rememberSelection(); }, options);
  form.addEventListener('reset', () => { queueMicrotask(() => { rememberSelection(); resize(); notice.textContent = ''; }); }, options);
  window.addEventListener('resize', resize, options);
  let width = textarea.clientWidth;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (textarea.clientWidth !== width) { width = textarea.clientWidth; resize(); }
  });
  observer?.observe(textarea);
  resize();
  return { resize, insertText, destroy: () => { pickerRevision++; pickerAnimation?.cancel(); contentAnimation?.cancel(); controller.abort(); observer?.disconnect(); tools.remove(); Object.assign(textarea.style, originalStyle); } };
}

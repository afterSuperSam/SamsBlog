// 留言与搜索共用手绘光标，原生输入框继续处理选区、滚动和输入法。
export function attachPaperCaret(field: HTMLInputElement | HTMLTextAreaElement | null | undefined) {
  const label = field?.closest('label');
  if (!field || !label) return () => {};
  const caret = document.createElement('span');
  caret.className = 'paper-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.hidden = true;
  label.append(caret);
  label.classList.add('has-paper-caret');
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.className = 'paper-caret-mirror';
  const before = document.createTextNode('');
  const marker = document.createElement('span');
  marker.className = 'paper-caret-marker';
  const after = document.createTextNode('');
  mirror.append(before, marker, after);
  document.body.append(mirror);
  let frame = 0;
  let revealCaret = false;
  let composing = false;
  const updateCaret = () => {
    frame = 0;
    const reveal = revealCaret;
    revealCaret = false;
    if (composing || document.activeElement !== field || field.selectionStart !== field.selectionEnd) {
      caret.hidden = true;
      return;
    }
    const styles = getComputedStyle(field);
    mirror.style.font = styles.font;
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.padding = styles.padding;
    mirror.style.boxSizing = styles.boxSizing;
    mirror.style.width = `${field.clientWidth}px`;
    mirror.style.whiteSpace = field instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
    const position = field.selectionStart || 0;
    before.data = field.value.slice(0, position);
    after.data = field.value.slice(position) || '\u200b';
    const markerBounds = marker.getBoundingClientRect();
    const mirrorBounds = mirror.getBoundingClientRect();
    const fieldBounds = field.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    const verticalOffset = field instanceof HTMLInputElement ? Math.max(0, (field.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) - parseFloat(styles.lineHeight)) / 2) : 0;
    let x = markerBounds.left - mirrorBounds.left - field.scrollLeft;
    let y = markerBounds.top - mirrorBounds.top - field.scrollTop + verticalOffset;
    if (reveal) {
      const insetTop = parseFloat(styles.paddingTop);
      const insetBottom = parseFloat(styles.paddingBottom);
      if (y < insetTop) field.scrollTop = Math.max(0, field.scrollTop + y - insetTop);
      else if (y + markerBounds.height > field.clientHeight - insetBottom) field.scrollTop += y + markerBounds.height - field.clientHeight + insetBottom;
      if (field instanceof HTMLInputElement) {
        const insetLeft = parseFloat(styles.paddingLeft);
        const insetRight = parseFloat(styles.paddingRight);
        if (x < insetLeft) field.scrollLeft = Math.max(0, field.scrollLeft + x - insetLeft);
        else if (x + caret.offsetWidth > field.clientWidth - insetRight) field.scrollLeft += x + caret.offsetWidth - field.clientWidth + insetRight;
      }
      x = markerBounds.left - mirrorBounds.left - field.scrollLeft;
      y = markerBounds.top - mirrorBounds.top - field.scrollTop + verticalOffset;
    }
    caret.style.left = `${fieldBounds.left - labelBounds.left + x}px`;
    caret.style.top = `${fieldBounds.top - labelBounds.top + y}px`;
    caret.hidden = x < 0 || x > field.clientWidth || y < 0 || y + markerBounds.height > field.clientHeight;
    caret.getAnimations().forEach((animation) => { animation.currentTime = 0; });
  };
  const scheduleCaret = (reveal = false) => {
    revealCaret ||= reveal;
    if (!frame) frame = requestAnimationFrame(updateCaret);
  };
  ['focus', 'input', 'keyup', 'click', 'select'].forEach((event) => field.addEventListener(event, () => { if (!composing) scheduleCaret(true); }));
  field.addEventListener('compositionstart', () => {
    composing = true;
    field.dataset.composing = 'true';
    caret.hidden = true;
  });
  field.addEventListener('compositionend', () => {
    composing = false;
    delete field.dataset.composing;
    scheduleCaret();
  });
  field.addEventListener('scroll', () => scheduleCaret(), { passive: true });
  field.addEventListener('blur', () => { caret.hidden = true; composing = false; delete field.dataset.composing; });
  document.addEventListener('selectionchange', () => { if (!composing && document.activeElement === field) scheduleCaret(); });
  field.form?.addEventListener('reset', () => scheduleCaret(true));
  new ResizeObserver(() => scheduleCaret()).observe(field);
  return scheduleCaret;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

// 正文只接受公开网页地址和站内路径，重复解码检查编码后的协议绕过。
function safeDestination(value: string, image: boolean): string | null {
  const destination = value.trim();
  let decoded = destination;
  try {
    for (let index = 0; index < 5; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }
  if (!destination || /\s/u.test(destination) || /[\u0000-\u001f\u007f\\]/u.test(decoded) || decoded.trim() !== decoded || decoded.includes('%') || /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(decoded)) return null;
  if (/^https?:\/\//i.test(decoded)) {
    try {
      const address = new URL(destination);
      return ['https:', 'http:'].includes(address.protocol) && !!address.hostname && !address.username && !address.password ? destination : null;
    } catch {
      return null;
    }
  }
  if (decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  if (decoded.startsWith('#')) return image ? null : destination;
  if (decoded.includes(':') || decoded.startsWith('?')) return null;
  return destination;
}

// 单次索引括号，畸形链接不再逐个扫描剩余正文。
function closingBrackets(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const square: number[] = [];
  const round: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '[') square.push(index);
    else if (text[index] === '(') round.push(index);
    else if (text[index] === ']' || text[index] === ')') {
      const opening = (text[index] === ']' ? square : round).pop();
      if (opening !== undefined) pairs.set(opening, index);
    }
  }
  return pairs;
}

function parseDestination(value: string): { address: string; title: string } | null {
  const match = value.trim().match(/^(?:<([^<>]+)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'))?$/);
  return match ? { address: (match[1] || match[2]).replace(/\\([()])/g, '$1'), title: match[3] || match[4] || '' } : null;
}

// 行内格式在输出时统一转义，不执行 Markdown 中的 HTML。
function inlineMarkdown(text: string, baseUrl?: string, depth = 0, allowLinks = true): string {
  if (depth > 10) return escapeHtml(text);
  const brackets = closingBrackets(text);
  const codeRuns = Array.from(text.matchAll(/`+/g), (match) => ({ start: match.index, length: match[0].length }));
  const maximumCodeRun = new Array<number>(codeRuns.length + 1).fill(0);
  for (let index = codeRuns.length - 1; index >= 0; index--) maximumCodeRun[index] = Math.max(codeRuns[index]!.length, maximumCodeRun[index + 1]!);
  let codeRunIndex = 0;
  let result = '';
  let plain = '';
  const flush = () => { result += escapeHtml(plain); plain = ''; };
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && /[\\`*{}\[\]()#+\-.!_~>]/.test(text[index + 1] || '')) {
      plain += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '`') {
      while (codeRuns[codeRunIndex]!.start + codeRuns[codeRunIndex]!.length <= index) codeRunIndex++;
      const run = codeRuns[codeRunIndex]!;
      const remaining = run.start + run.length - index;
      const delimiterLength = Math.min(remaining, maximumCodeRun[codeRunIndex + 1]!);
      plain += text.slice(index, index + remaining - delimiterLength);
      index += remaining - delimiterLength;
      if (!delimiterLength) continue;
      let closingRunIndex = codeRunIndex + 1;
      while (codeRuns[closingRunIndex]!.length < delimiterLength) closingRunIndex++;
      const end = codeRuns[closingRunIndex]!.start;
      flush();
      result += `<code>${escapeHtml(text.slice(index + delimiterLength, end))}</code>`;
      index = end + delimiterLength;
      codeRunIndex = closingRunIndex;
      continue;
    }
    const isImage = text.startsWith('![', index);
    if ((isImage || text[index] === '[') && (allowLinks || isImage)) {
      const start = index + (isImage ? 1 : 0);
      const labelEnd = brackets.get(start) ?? -1;
      if (labelEnd < 0) { plain += text.slice(index); break; }
      if (labelEnd > start && text[labelEnd + 1] === '(') {
        const destinationEnd = brackets.get(labelEnd + 1) ?? -1;
        const destination = destinationEnd >= 0 ? parseDestination(text.slice(labelEnd + 2, destinationEnd)) : null;
        const address = destination && safeDestination(destination.address, isImage);
        if (address && destination) {
          flush();
          const resolvedAddress = baseUrl ? new URL(address, baseUrl).href : address;
          const label = text.slice(start + 1, labelEnd);
          const title = destination.title ? ` title="${escapeHtml(destination.title)}"` : '';
          if (isImage) result += `<img src="${escapeHtml(resolvedAddress)}" alt="${escapeHtml(label)}"${title} loading="lazy" decoding="async">`;
          else result += `<a href="${escapeHtml(resolvedAddress)}"${title}${/^https?:/i.test(address) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inlineMarkdown(label, baseUrl, depth + 1, false)}</a>`;
          index = destinationEnd + 1; continue;
        }
      }
    }
    const delimiter = ['**', '__', '~~', '*', '_'].find((candidate) => text.startsWith(candidate, index));
    if (delimiter && !(delimiter.includes('_') && /[\p{L}\p{N}]/u.test(text[index - 1] || ''))) {
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end > index + delimiter.length && !/^\s|\s$/.test(text.slice(index + delimiter.length, end))) {
        flush();
        const tag = delimiter === '~~' ? 'del' : delimiter.length === 2 ? 'strong' : 'em';
        result += `<${tag}>${inlineMarkdown(text.slice(index + delimiter.length, end), baseUrl, depth + 1, allowLinks)}</${tag}>`;
        index = end + delimiter.length; continue;
      }
    }
    plain += text[index]; index += 1;
  }
  flush();
  return result;
}

const listMarker = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/;
const fenceMarker = /^ {0,3}(`{3,}|~{3,})([\w+-]*)(?:[\t ]+(.+?))?[\t ]*$/;
const headingMarker = /^ {0,3}(#{1,6})\s+(.+?)\s*#*$/;
const ruleMarker = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const quoteMarker = /^ {0,3}>\s?/;

function startsBlock(line: string): boolean {
  return !line.trim() || fenceMarker.test(line) || headingMarker.test(line) || ruleMarker.test(line) || quoteMarker.test(line) || listMarker.test(line);
}

// 保持单一的浏览器和服务端渲染入口，代码围栏、引用和列表均不接受原始 HTML。
function renderBlocks(markdown: string, baseUrl?: string, depth = 0): string {
  if (depth > 16) return `<p>${escapeHtml(markdown)}</p>`;
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const result: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const annotation = line.match(/^:::(details|aside)\s+(.+)$/);
    if (annotation) {
      const body: string[] = [];
      let closing = index + 1;
      let nesting = 1;
      let fenced = '';
      for (; closing < lines.length; closing++) {
        const marker = lines[closing].match(fenceMarker);
        if (marker && !fenced) fenced = marker[1];
        else if (fenced && new RegExp(`^ {0,3}${fenced[0]}{${fenced.length},}\\s*$`).test(lines[closing])) fenced = '';
        else if (!fenced) {
          if (/^:::(?:details|aside)\s+.+$/.test(lines[closing])) nesting++;
          else if (/^:::\s*$/.test(lines[closing]) && --nesting === 0) break;
        }
        body.push(lines[closing]);
      }
      if (!nesting) {
        const title = inlineMarkdown(annotation[2], baseUrl, 0, false);
        const content = renderBlocks(body.join('\n'), baseUrl, depth + 1);
        result.push(annotation[1] === 'details'
          ? `<details class="article-explanation"><summary>${title}</summary><div class="article-explanation__body">${content}</div></details>`
          : `<aside class="article-aside"><strong class="article-aside__title">${title}</strong>${content}</aside>`);
        index = closing + 1;
        continue;
      }
      // 未闭合时保留原文，避免多个畸形开头反复扫描同一段正文。
      result.push(`<p>${escapeHtml(lines.slice(index).join('\n'))}</p>`);
      break;
    }
    const fence = line.match(fenceMarker);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) body.push(lines[index++]);
      const code = body.join('\n') + (body.length && index < lines.length ? '\n' : '');
      index += 1;
      const file = fence[3]?.match(/^(?:(?:title|filename)=)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'<>]+))$/);
      const filename = file ? file[1] || file[2] || file[3] : '';
      result.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}${filename ? ` data-filename="${escapeHtml(filename)}"` : ''}>${escapeHtml(code)}</code></pre>`);
      continue;
    }
    const heading = line.match(headingMarker);
    if (heading) { result.push(`<h${heading[1].length}>${inlineMarkdown(heading[2], baseUrl)}</h${heading[1].length}>`); index += 1; continue; }
    if (ruleMarker.test(line)) { result.push('<hr>'); index += 1; continue; }
    if (quoteMarker.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quoteMarker.test(lines[index])) body.push(lines[index++].replace(quoteMarker, ''));
      result.push(`<blockquote>${renderBlocks(body.join('\n'), baseUrl, depth + 1)}</blockquote>`);
      continue;
    }
    const list = line.match(listMarker);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const tag = ordered ? 'ol' : 'ul';
      const indentation = line.length - line.trimStart().length;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(listMarker);
        if (!item || /^\d/.test(item[1]) !== ordered || lines[index].length - lines[index].trimStart().length !== indentation || ruleMarker.test(lines[index])) break;
        const contentIndentation = lines[index].length - item[2].length;
        const body = [item[2]];
        index += 1;
        while (index < lines.length) {
          if (!lines[index].trim()) {
            const next = lines[index + 1];
            if (next && next.length - next.trimStart().length >= contentIndentation) { body.push(''); index += 1; continue; }
            break;
          }
          if (lines[index].length - lines[index].trimStart().length < contentIndentation) break;
          body.push(lines[index++].slice(contentIndentation));
        }
        let content = renderBlocks(body.join('\n'), baseUrl, depth + 1);
        if (content.startsWith('<p>') && content.indexOf('</p>') === content.length - 4) content = content.slice(3, -4);
        items.push(`<li>${content}</li>`);
      }
      const start = ordered && Number.parseInt(list[1], 10) !== 1 ? ` start="${Number.parseInt(list[1], 10)}"` : '';
      result.push(`<${tag}${start}>${items.join('')}</${tag}>`);
      continue;
    }
    const body = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index]) && !/^:::(?:details|aside)\s+.+$/.test(lines[index])) body.push(lines[index++]);
    result.push(`<p>${inlineMarkdown(body.join('\n'), baseUrl).replace(/ {2,}\n/g, '<br>')}</p>`);
  }
  return result.join('\n');
}

export function renderMarkdown(markdown: string, baseUrl?: string): string {
  return renderBlocks(markdown, baseUrl);
}

export interface ArticleHeading { id: string; level: number; text: string }

// 阅读目录只处理已安全渲染的标题，重复标题和自然后缀均保持唯一。
export function renderArticleMarkdown(markdown: string) {
  const headings: ArticleHeading[] = [];
  const identifiers = new Set<string>();
  const html = renderMarkdown(markdown).replace(/<h([1-6])>(.*?)<\/h\1>/g, (_, level: string, content: string) => {
    const text = content.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!);
    const slug = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
    const base = `article-heading-${slug}`;
    let id = base;
    let suffix = 2;
    while (identifiers.has(id)) id = `${base}-${suffix++}`;
    identifiers.add(id);
    headings.push({ id, level: Number(level), text });
    return `<h${level} id="${escapeHtml(id)}" tabindex="-1">${content}</h${level}>`;
  });
  return { html, headings };
}

export function articleExcerpt(markdown: string): string {
  const text = renderMarkdown(markdown)
    .replace(/<pre>[\s\S]*?<\/pre>/g, ' ')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!)
    .replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 180 ? `${characters.slice(0, 180).join('')}…` : text;
}

// 检索保留代码文字，列表摘要仍单独跳过代码块。
export function articlePlainText(markdown: string): string {
  return renderMarkdown(markdown).replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!)
    .replace(/\s+/g, ' ').trim();
}

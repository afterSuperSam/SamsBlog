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
      return ['https:', 'http:'].includes(address.protocol) && !!address.hostname ? destination : null;
    } catch {
      return null;
    }
  }
  if (decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  if (decoded.startsWith('#')) return image ? null : destination;
  if (decoded.includes(':') || decoded.startsWith('?')) return null;
  return destination;
}

function closingBracket(text: string, start: number, opening: string, closing: string): number {
  let depth = 1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === opening) depth += 1;
    if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function parseDestination(value: string): { address: string; title: string } | null {
  const match = value.trim().match(/^(?:<([^<>]+)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'))?$/);
  return match ? { address: (match[1] || match[2]).replace(/\\([()])/g, '$1'), title: match[3] || match[4] || '' } : null;
}

// 行内格式在输出时统一转义，不执行 Markdown 中的 HTML。
function inlineMarkdown(text: string, depth = 0, allowLinks = true): string {
  if (depth > 10) return escapeHtml(text);
  let result = '';
  let plain = '';
  const flush = () => { result += escapeHtml(plain); plain = ''; };
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && /[\\`*{}\[\]()#+\-.!_~>]/.test(text[index + 1] || '')) {
      plain += text[index + 1]; index += 2; continue;
    }
    if (text[index] === '`') {
      const delimiter = text.slice(index).match(/^`+/)![0];
      const end = text.indexOf(delimiter, index + delimiter.length);
      if (end >= 0) {
        flush();
        result += `<code>${escapeHtml(text.slice(index + delimiter.length, end))}</code>`;
        index = end + delimiter.length; continue;
      }
    }
    const isImage = text.startsWith('![', index);
    if ((isImage || text[index] === '[') && (allowLinks || isImage)) {
      const start = index + (isImage ? 1 : 0);
      const labelEnd = closingBracket(text, start, '[', ']');
      if (labelEnd < 0) { plain += text.slice(index); break; }
      if (labelEnd > start && text[labelEnd + 1] === '(') {
        const destinationEnd = closingBracket(text, labelEnd + 1, '(', ')');
        const destination = destinationEnd >= 0 ? parseDestination(text.slice(labelEnd + 2, destinationEnd)) : null;
        const address = destination && safeDestination(destination.address, isImage);
        if (address && destination) {
          flush();
          const label = text.slice(start + 1, labelEnd);
          const title = destination.title ? ` title="${escapeHtml(destination.title)}"` : '';
          if (isImage) result += `<img src="${escapeHtml(address)}" alt="${escapeHtml(label)}"${title} loading="lazy" decoding="async">`;
          else result += `<a href="${escapeHtml(address)}"${title}${/^https?:/i.test(address) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inlineMarkdown(label, depth + 1, false)}</a>`;
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
        result += `<${tag}>${inlineMarkdown(text.slice(index + delimiter.length, end), depth + 1, allowLinks)}</${tag}>`;
        index = end + delimiter.length; continue;
      }
    }
    plain += text[index]; index += 1;
  }
  flush();
  return result;
}

const listMarker = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/;
const fenceMarker = /^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/;
const headingMarker = /^ {0,3}(#{1,6})\s+(.+?)\s*#*$/;
const ruleMarker = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const quoteMarker = /^ {0,3}>\s?/;

function startsBlock(line: string): boolean {
  return !line.trim() || fenceMarker.test(line) || headingMarker.test(line) || ruleMarker.test(line) || quoteMarker.test(line) || listMarker.test(line);
}

// 保持单一的浏览器和服务端渲染入口，代码围栏、引用和列表均不接受原始 HTML。
function renderBlocks(markdown: string, depth = 0): string {
  if (depth > 16) return `<p>${escapeHtml(markdown)}</p>`;
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const result: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(fenceMarker);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) body.push(lines[index++]);
      index += 1;
      result.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(headingMarker);
    if (heading) { result.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (ruleMarker.test(line)) { result.push('<hr>'); index += 1; continue; }
    if (quoteMarker.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quoteMarker.test(lines[index])) body.push(lines[index++].replace(quoteMarker, ''));
      result.push(`<blockquote>${renderBlocks(body.join('\n'), depth + 1)}</blockquote>`);
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
        let content = renderBlocks(body.join('\n'), depth + 1);
        if (content.startsWith('<p>') && content.indexOf('</p>') === content.length - 4) content = content.slice(3, -4);
        items.push(`<li>${content}</li>`);
      }
      const start = ordered && Number.parseInt(list[1], 10) !== 1 ? ` start="${Number.parseInt(list[1], 10)}"` : '';
      result.push(`<${tag}${start}>${items.join('')}</${tag}>`);
      continue;
    }
    const body = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index])) body.push(lines[index++]);
    result.push(`<p>${inlineMarkdown(body.join('\n')).replace(/ {2,}\n/g, '<br>')}</p>`);
  }
  return result.join('\n');
}

export function renderMarkdown(markdown: string): string {
  return renderBlocks(markdown);
}

export function articleExcerpt(markdown: string): string {
  const text = renderMarkdown(markdown)
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!)
    .replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 180 ? `${characters.slice(0, 180).join('')}…` : text;
}

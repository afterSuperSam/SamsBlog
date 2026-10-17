import { describe, expect, it } from 'vitest';
import { articleExcerpt, renderMarkdown } from '../src/lib/markdown';

describe('article Markdown', () => {
  it('renders writing formats and preserves fenced code as text', () => {
    const html = renderMarkdown('# 文章\n\n**粗体**、*斜体*、~~删除~~ 和 `code`\n\n- 第一条\n- 第二条\n\n3. 日志\n4. 杂谈\n\n> 一句话\n\n---\n\n```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('<h1>文章</h1>');
    expect(html).toContain('<strong>粗体</strong>、<em>斜体</em>、<del>删除</del> 和 <code>code</code>');
    expect(html).toContain('<ul><li>第一条</li><li>第二条</li></ul>');
    expect(html).toContain('<ol start="3"><li>日志</li><li>杂谈</li></ol>');
    expect(html).toContain('<blockquote><p>一句话</p></blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
  });

  it('supports safe links, image titles and balanced destination parentheses', () => {
    const html = renderMarkdown('[站内](/about#articles) [锚点](#content) [外链](https://example.com/a_(b)) ![风景](https://example.com/image.png "首图") ![本地](/images/cover.webp)');
    expect(html).toContain('href="/about#articles"');
    expect(html).toContain('href="#content"');
    expect(html).toContain('href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('alt="风景" title="首图" loading="lazy"');
    expect(html).toContain('src="/images/cover.webp"');
  });

  it('supports encoded spaces in URL paths, relative anchors and mixed quotes in titles', () => {
    const html = renderMarkdown('[网页](https://example.com/my%20page "Bob\'s page") [文档](./guide#reading) [图片页](https://example.com/a_(b) \'A "title"\') ![封面](/images/my%20cover.webp)');
    expect(html).toContain('href="https://example.com/my%20page" title="Bob&#39;s page" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="./guide#reading"');
    expect(html).toContain('href="https://example.com/a_(b)" title="A &quot;title&quot;"');
    expect(html).toContain('src="/images/my%20cover.webp"');
  });

  it('keeps nested list structure and bounds adversarial nesting', () => {
    const html = renderMarkdown('- 一级\n  - 二级\n  - 二级另一项\n- 下一项');
    expect(html).toContain('<li><p>一级</p>\n<ul><li>二级</li><li>二级另一项</li></ul></li>');
    expect(html).toContain('<li>下一项</li>');
    expect(() => renderMarkdown('>'.repeat(10_000))).not.toThrow();
    expect(() => renderMarkdown('['.repeat(10_000))).not.toThrow();
  });

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,payload', 'vbscript:payload',
    '//example.com', '\\example.com', '%2f%2fexample.com', '%5cexample.com',
    'java%73cript%3Aalert(1)', 'java%2573cript%253Aalert(1)', 'https:%5c%5cexample.com',
    'java%0ascript:alert(1)', 'javascript&#58;alert(1)', 'file:///secret',
    'java%20script:alert(1)', 'https://example.com/a%0Ab', 'https://example.com/a%5Cb', '%20//example.com',
  ])('does not generate active markup for unsafe destination %s', (destination) => {
    const html = renderMarkdown(`[点击](${destination}) ![图片](${destination})`);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img ');
  });

  it('escapes raw HTML and attribute quotes; cannot nest links inside links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n![" onerror="bad](/image.png) [**文字** [嵌套](/inside)](/outside)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('alt="&quot; onerror=&quot;bad"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<strong>文字</strong>');
  });

  it('creates a bounded plain-text excerpt without tags or destinations', () => {
    expect(articleExcerpt('# 标题\n\n[链接](https://example.com) 和 **内容** ![图片说明](/image.webp)')).toBe('标题 链接 和 内容 图片说明');
    expect(Array.from(articleExcerpt('字'.repeat(181)))).toHaveLength(181);
    expect(articleExcerpt('字'.repeat(181))).toMatch(/…$/);
    expect(articleExcerpt('你好😀')).toBe('你好😀');
  });
});

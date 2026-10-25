import { describe, expect, it } from 'vitest';
import { articleExcerpt, renderArticleMarkdown, renderMarkdown } from '../src/lib/markdown';

describe('article Markdown', () => {
  it('conceals spoiler blocks natively and excludes hidden headings from the directory', () => {
    const markdown = '## 开头\n:::spoiler 结局\n## 秘密标题\n\n<script>bad()</script>\n\n:::details 更多\n### 第二个秘密\n:::\n:::\n## 之后';
    const rendered = renderArticleMarkdown(markdown);
    expect(rendered.html).toContain('<details class="article-explanation article-spoiler">');
    expect(rendered.html).not.toContain(' open');
    expect(rendered.html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(rendered.headings.map((heading) => heading.text)).toEqual(['开头', '之后']);
    expect(articleExcerpt(markdown)).not.toContain('秘密');
    expect(renderMarkdown(markdown, 'https://example.com/articles/1', { concealSpoilers: true })).not.toContain('秘密');
    expect(renderMarkdown('```md\n:::spoiler 语法示例\n秘密\n:::\n```')).not.toContain('article-spoiler');
  });
  it('conceals nested spoilers in lists, quotes and explanations for subscription readers', () => {
    const markdown = '- 外层\n  :::spoiler 提示\n  secret-list\n  :::\n\n> :::spoiler 提示\n> secret-quote\n> :::\n\n:::details 展开\n:::spoiler 提示\nsecret-detail\n:::\n:::';
    expect(renderMarkdown(markdown, undefined, { concealSpoilers: true })).not.toContain('secret');
  });
  it('renders safe expandable explanations and margin notes, keeping nested fences intact', () => {
    const rendered = renderArticleMarkdown('正文\n:::details 为什么\n说明 **内容**\n\n:::aside 提醒\n[链接](/articles/1)\n:::\n\n```txt\n:::\n```\n\n## 一节\n:::\n\n结束');
    expect(rendered.html).toContain('<details class="article-explanation"><summary>为什么</summary>');
    expect(rendered.html).toContain('<aside class="article-aside">');
    expect(rendered.html).toContain('<code class="language-txt">:::\n</code>');
    expect(rendered.html).toContain('<p>结束</p>');
    expect(rendered.headings).toHaveLength(1);
    expect(renderMarkdown(':::aside <img onerror="alert(1)">\n<script>x</script>\n:::')).not.toContain('<script>');
    expect(renderMarkdown(':::details [标题](/a)\n正文\n:::')).not.toContain('<summary><a');
  });

  it('keeps malformed annotation markers inert without quadratic suffix scans', () => {
    const text = ':::details 尚未闭合\n'.repeat(3000);
    const start = performance.now();
    expect(renderMarkdown(text)).toBe(`<p>${text}</p>`);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(renderMarkdown('```txt\n:::aside 文字\n::: \n```')).not.toContain('<aside');
  });
  it('builds stable unique heading anchors without collecting fenced or escaped headings', () => {
    const markdown = '## 重复\n\n## **重复**\n\n### 重复-2\n\n> ## 重复\n\n```md\n# 围栏内\n```\n\n<h2>原始 HTML</h2>';
    const rendered = renderArticleMarkdown(markdown);
    expect(rendered.headings.map((heading) => heading.id)).toEqual([
      'article-heading-重复', 'article-heading-重复-2', 'article-heading-重复-2-2', 'article-heading-重复-3',
    ]);
    expect(rendered.headings.map((heading) => heading.level)).toEqual([2, 2, 3, 2]);
    expect(renderArticleMarkdown(markdown)).toEqual(rendered);
    expect(rendered.html).toContain('id="article-heading-重复" tabindex="-1"');
    expect(rendered.html).toContain('&lt;h2&gt;原始 HTML&lt;/h2&gt;');
    expect(renderMarkdown(markdown)).not.toContain(' id=');
  });

  it('keeps code indentation, blank lines, tabs and escaped text intact for clipboard textContent', () => {
    const html = renderArticleMarkdown('```js\n  const value = "<标签>";\n\n\treturn value;\n```').html;
    expect(html).toContain('<code class="language-js">  const value = &quot;&lt;标签&gt;&quot;;\n\n\treturn value;\n</code>');
  });

  it('renders writing formats and preserves fenced code as text', () => {
    const html = renderMarkdown('# 文章\n\n**粗体**、*斜体*、~~删除~~ 和 `code`\n\n- 第一条\n- 第二条\n\n3. 日志\n4. 杂谈\n\n> 一句话\n\n---\n\n```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('<h1>文章</h1>');
    expect(html).toContain('<strong>粗体</strong>、<em>斜体</em>、<del>删除</del> 和 <code>code</code>');
    expect(html).toContain('<ul><li>第一条</li><li>第二条</li></ul>');
    expect(html).toContain('<ol start="3"><li>日志</li><li>杂谈</li></ol>');
    expect(html).toContain('<blockquote><p>一句话</p></blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>');
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

  it('resolves feed links and images against the article while preserving escaping and URL safety', () => {
    const html = renderMarkdown('> **[站内](/about?a=1&b=2)**\n\n- ![图片](../images/a%20b.webp)\n- [锚点](#content)\n- [外链](https://example.com/path)\n\n[恶意](javascript:alert(1))', 'https://blog.example.com/articles/7');
    expect(html).toContain('href="https://blog.example.com/about?a=1&amp;b=2"');
    expect(html).toContain('src="https://blog.example.com/images/a%20b.webp"');
    expect(html).toContain('href="https://blog.example.com/articles/7#content"');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).not.toContain('href="javascript:');
  });

  it('keeps nested list structure and bounds adversarial nesting', () => {
    const html = renderMarkdown('- 一级\n  - 二级\n  - 二级另一项\n- 下一项');
    expect(html).toContain('<li><p>一级</p>\n<ul><li>二级</li><li>二级另一项</li></ul></li>');
    expect(html).toContain('<li>下一项</li>');
    expect(() => renderMarkdown('>'.repeat(10_000))).not.toThrow();
    expect(() => renderMarkdown('['.repeat(10_000))).not.toThrow();
  });

  it('preserves code spans, unmatched runs and shorter delimiter fallback', () => {
    expect(renderMarkdown('x``code ` literal``')).toBe('<p>x<code>code ` literal</code></p>');
    expect(renderMarkdown('x``unfinished `tail')).toBe('<p>x`<code>unfinished </code>tail</p>');
    expect(renderMarkdown('x`first```second``')).toBe('<p>x<code>first</code><code>second</code></p>');
    expect(renderMarkdown('x`[link](/a)`')).toBe('<p>x<code>[link](/a)</code></p>');
    expect(renderMarkdown('x\\`literal\\`')).toBe('<p>x`literal`</p>');
    expect(renderMarkdown('x```unfinished')).toBe('<p>x```unfinished</p>');
  });

  it('preserves nested and escaped brackets while recovering after malformed destinations', () => {
    expect(renderMarkdown('[outer [inner]](/a_(b))')).toBe('<p><a href="/a_(b)">outer [inner]</a></p>');
    expect(renderMarkdown('[escaped\\]](/a\\(b\\))')).toBe('<p><a href="/a(b)">escaped]</a></p>');
    expect(renderMarkdown('x[a]([b]([valid](/ok)')).toBe('<p>x[a]([b](<a href="/ok">valid</a></p>');
    expect(renderMarkdown('x\\[label](/plain)')).toBe('<p>x[label](/plain)</p>');
  });

  it.each(['`', '[a]('])('scales bounded malformed input without repeated suffix scans: %s', (token) => {
    const measure = (size: number) => {
      const input = 'x' + token.repeat(Math.floor((size - 1) / token.length));
      const samples: number[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        const html = renderMarkdown(input);
        samples.push(performance.now() - started);
        expect(html).toBe(`<p>${input}</p>`);
      }
      return Math.min(...samples);
    };
    measure(1000);
    const small = measure(10000);
    const large = measure(100000);
    expect(large).toBeLessThan(small * 30 + 100);
  });

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,payload', 'vbscript:payload',
    '//example.com', '\\example.com', '%2f%2fexample.com', '%5cexample.com',
    'java%73cript%3Aalert(1)', 'java%2573cript%253Aalert(1)', 'https:%5c%5cexample.com',
    'java%0ascript:alert(1)', 'javascript&#58;alert(1)', 'file:///secret',
    'java%20script:alert(1)', 'https://example.com/a%0Ab', 'https://example.com/a%5Cb', '%20//example.com',
    'https://user:secret@example.com/', 'http://user@example.com/image.png',
    'https://:secret@example.com/', 'https://us%65r:sec%72et@example.com/',
  ])('does not generate active markup for unsafe destination %s', (destination) => {
    for (const baseUrl of [undefined, 'https://blog.example.com/articles/7']) {
      const html = renderMarkdown(`[点击](${destination}) ![图片](${destination})`, baseUrl);
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('<img ');
    }
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

  it.each([
    ['```css\n#NOW { color: red; }\n```\n\n这是正文摘要。', '这是正文摘要。'],
    ['正文之前\n\n~~~~html\n</pre><p>代码内容</p>\n~~~\n仍在代码块内\n~~~~\n\n正文之后', '正文之前 正文之后'],
    ['正文\n\n```ts\nconst unfinished = true;', '正文'],
    ['```js\nconsole.log("only code");\n```', ''],
    ['使用 `#NOW` 选择器。', '使用 #NOW 选择器。'],
  ])('omits fenced code from excerpts while preserving prose and inline code: %s', (markdown, expected) => {
    expect(articleExcerpt(markdown)).toBe(expected);
  });
});
describe('code filenames', () => {
  it('keeps filename metadata out of copied code and escapes attribute text', () => {
    const source = '```ts title="src/my file.ts"\n  const value = 1;\n\tvalue++;\n```';
    expect(renderMarkdown(source)).toBe('<pre><code class="language-ts" data-filename="src/my file.ts">  const value = 1;\n\tvalue++;\n</code></pre>');
    expect(renderMarkdown('~~~js filename="<script>&"\nrun();\n~~~')).toContain('data-filename="&lt;script&gt;&amp;"');
    expect(articleExcerpt('摘要\n\n' + source)).toBe('摘要');
  });
});

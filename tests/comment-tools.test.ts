import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeCommentInput, insertCommentText, parseRecentEmoticons } from '../src/lib/comment-tools';
import { siteConfig } from '../src/config/site';
import { isLongMessage, renderCommentList } from '../src/lib/comment-rendering';
import type { MessageRecord } from '../src/lib/db';
import { animateMotion } from '../src/lib/motion';

vi.mock('../src/lib/motion', () => ({ animateMotion: vi.fn() }));

class ElementStub extends EventTarget {
  constructor(public tagName = 'div') { super(); }
  id = '';
  parentElement: ElementStub | null = null;
  children: ElementStub[] = [];
  className = '';
  textContent = '';
  type = '';
  open = false;
  disabled = false;
  readOnly = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style = { height: '', maxHeight: '', overflowY: '' };
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  maxLength = 100;
  rows = 2;
  clientWidth = 300;
  scrollHeight = 60;
  offsetHeight = 44;
  getBoundingClientRect() { return { height: this.open ? 260 : 44 }; }
  after = vi.fn();
  remove = vi.fn();
  requestSubmit = vi.fn();
  descendants(): ElementStub[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelector = vi.fn((selector?: string): ElementStub | null => this.descendants().find((node) => selector?.startsWith('#') ? node.id === selector.slice(1) : node.tagName === selector) || null);
  closest = () => null;
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...elements: ElementStub[]) { elements.forEach((element) => { element.parentElement = this; }); this.children.push(...elements); }
  prepend(...elements: ElementStub[]) { elements.forEach((element) => { element.parentElement = this; }); this.children.unshift(...elements); }
  replaceChildren(...elements: ElementStub[]) { this.children = []; this.append(...elements); }
  focus() { (document as unknown as { activeElement: Element | null }).activeElement = this as unknown as Element; }
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}

function fixture() {
  const documentStub = new ElementStub() as ElementStub & { activeElement: Element | null; createElement: () => ElementStub };
  documentStub.activeElement = null;
  documentStub.createElement = () => new ElementStub();
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', new ElementStub());
  vi.stubGlobal('getComputedStyle', () => ({ opacity: '1', getPropertyValue: () => 'cubic-bezier(.22,1,.36,1)', lineHeight: '20px', fontSize: '16px', paddingTop: '10px', paddingBottom: '10px', borderTopWidth: '1px', borderBottomWidth: '1px', boxSizing: 'border-box', minHeight: '0px' }));
  const storage = { getItem: vi.fn(() => null as string | null), setItem: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  const form = new ElementStub();
  const textarea = new ElementStub();
  const initialize = () => initializeCommentInput(form as unknown as HTMLFormElement, textarea as unknown as HTMLTextAreaElement);
  return { form, textarea, storage, initialize };
}

function key(target: ElementStub, type: string, properties: Record<string, unknown>) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key: 'Enter', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13 }, properties);
  target.dispatchEvent(event);
  return event;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(animateMotion).mockReset(); });

describe('comment list refresh', () => {
  it('uses trusted owner identity, folds long replies, retains quotes and reveals the submitted reply', () => {
    class DetailsStub extends ElementStub { constructor() { super('details'); } }
    vi.stubGlobal('HTMLDetailsElement', DetailsStub);
    vi.stubGlobal('document', { createElement: (tag: string) => tag === 'details' ? new DetailsStub() : new ElementStub(tag), createElementNS: (_namespace: string, tag: string) => new ElementStub(tag) });
    const list = new ElementStub();
    const base: MessageRecord = { id: 1, parentId: null, articleId: 1, nickname: 'SuperSam', isAdmin: false, content: '访客内容', status: 'published', createdAt: '2026-10-25T00:00:00Z', quoteMessageId: null, quoteContent: '', quoteNickname: '' };
    const replies = Array.from({ length: 5 }, (_, index) => ({ ...base, id: index + 2, parentId: 1, isAdmin: index === 0, content: index === 1 ? '长'.repeat(181) : '<script>纯文本</script>', quoteMessageId: 1, quoteContent: '访客内容', quoteNickname: 'SuperSam' }));
    renderCommentList(list as unknown as HTMLElement, [{ ...base, replies }], 6);
    const nodes = list.descendants();
    expect(nodes.filter((node) => node.tagName === 'svg')).toHaveLength(1);
    expect(nodes.find((node) => node.tagName === 'use')?.attributes.href).toBe('#message-owner-signature');
    expect(nodes.find((node) => node.id === 'comment-1')?.querySelector('b')?.textContent).toBe('SuperSam');
    expect(nodes.filter((node) => node.className === 'comment-quote')).toHaveLength(5);
    expect(nodes.find((node) => node.className === 'message-collapse')?.open).toBe(false);
    expect(nodes.find((node) => node.className === 'message-replies-more')?.open).toBe(true);
    expect(nodes.filter((node) => node.textContent === '<script>纯文本</script>')).toHaveLength(4);
    expect(nodes.find((node) => node.id === 'comment-6')?.querySelector('button')?.dataset).toMatchObject({ commentReply: '1', commentMessage: '6' });
  });
  it('bounds previews by Unicode characters and folds short but tall paragraphs', () => {
    expect(isLongMessage('😀'.repeat(180))).toBe(false);
    expect(isLongMessage('😀'.repeat(181))).toBe(true);
    expect(isLongMessage('x\n'.repeat(9))).toBe(true);
  });
});

describe('comment text insertion and local emoticons', () => {
  it('replaces the current selection and rejects overflow without truncating an emoticon', () => {
    expect(insertCommentText('你好世界', '(≧▽≦)', 2, 4, 7)).toEqual({ value: '你好(≧▽≦)', position: 7 });
    expect(insertCommentText('你好世界', '(≧▽≦)', 2, 2, 7)).toBeNull();
    expect(insertCommentText('', '😀', 0, 0, 1)).toBeNull();
    expect(insertCommentText('abc', 'd', 3, 3, -1)?.value).toBe('abcd');
  });
  it('keeps only configured, unique recent emoticons and enforces the local limit', () => {
    const emoticons = siteConfig.discussion.emoticons;
    expect(parseRecentEmoticons(JSON.stringify([emoticons[0], 'unsafe', emoticons[0], ...emoticons, null, 2])))
      .toEqual(emoticons.slice(0, siteConfig.discussion.recentEmoticonLimit));
    for (const value of [null, '{', '{}', '"text"']) expect(parseRecentEmoticons(value)).toEqual([]);
  });
});

describe('shared comment input', () => {
  it('keeps closing content visible until the animation ends and ignores stale reversals', async () => {
    const { textarea, initialize } = fixture();
    const helper = initialize();
    const picker = (textarea.after.mock.calls[0][0] as ElementStub).children[0];
    const summary = picker.children[0];
    const pending: Array<{ finish: () => void }> = [];
    vi.mocked(animateMotion).mockImplementation((element) => {
      if (element !== picker as unknown as Element) return;
      let finish!: () => void; let cancel!: () => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = () => reject(new Error('cancelled')); });
      pending.push({ finish });
      return { finished, cancel } as unknown as Animation;
    });
    const click = () => summary.dispatchEvent(new Event('click', { cancelable: true }));
    click(); click();
    expect(picker.open).toBe(true);
    expect(picker.dataset.expanded).toBe('false');
    pending[1].finish(); await Promise.resolve();
    expect(picker.open).toBe(false);
    click(); click(); click();
    await Promise.resolve();
    expect(picker.open).toBe(true);
    pending[4].finish(); await Promise.resolve();
    expect(picker.open).toBe(true);
    helper.destroy();
  });
  it('opens and closes immediately when motion is disabled', () => {
    const { textarea, initialize } = fixture();
    const helper = initialize();
    const picker = (textarea.after.mock.calls[0][0] as ElementStub).children[0];
    picker.children[0].dispatchEvent(new Event('click', { cancelable: true }));
    expect(picker.open).toBe(true);
    picker.children[0].dispatchEvent(new Event('click', { cancelable: true }));
    expect(picker.open).toBe(false);
    helper.destroy();
  });
  it('expands to eight lines, scrolls above the cap, and shrinks after deletion', () => {
    const { textarea, initialize } = fixture();
    const helper = initialize();
    expect(textarea.style.height).toBe('62px');
    textarea.scrollHeight = 400;
    textarea.dispatchEvent(new Event('input'));
    expect(textarea.style.height).toBe('182px');
    expect(textarea.style.overflowY).toBe('auto');
    textarea.scrollHeight = 60;
    textarea.dispatchEvent(new Event('input'));
    expect(textarea.style.height).toBe('62px');
    expect(textarea.style.overflowY).toBe('hidden');
    helper.destroy();
    expect(textarea.style.height).toBe('');
  });
  it('inserts at the saved selection after focus leaves and preserves input events and focus', () => {
    const { textarea, initialize } = fixture();
    textarea.value = '前面后面';
    textarea.selectionStart = textarea.selectionEnd = 2;
    const helper = initialize();
    const input = vi.fn();
    textarea.addEventListener('input', input);
    expect(helper.insertText('(≧▽≦)')).toBe(true);
    expect(textarea.value).toBe('前面(≧▽≦)后面');
    expect(textarea.selectionStart).toBe(7);
    expect(document.activeElement).toBe(textarea);
    expect(input).toHaveBeenCalledOnce();
    textarea.maxLength = textarea.value.length;
    expect(helper.insertText('x')).toBe(false);
    expect(textarea.value).toBe('前面(≧▽≦)后面');
    textarea.maxLength = 100;
    textarea.dataset.characterMaximum = '10';
    expect(helper.insertText('😀')).toBe(true);
    expect(helper.insertText('x')).toBe(false);
    helper.destroy();
  });
  it('submits only Ctrl+Enter outside composition and after the commit key is released', () => {
    const { form, textarea, initialize } = fixture();
    const helper = initialize();
    expect(key(textarea, 'keydown', { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(form.requestSubmit).not.toHaveBeenCalled();
    textarea.dispatchEvent(new Event('compositionstart'));
    key(textarea, 'keydown', {});
    textarea.dispatchEvent(new Event('compositionend'));
    key(textarea, 'keydown', {});
    expect(form.requestSubmit).not.toHaveBeenCalled();
    key(textarea, 'keyup', {});
    expect(key(textarea, 'keydown', {}).defaultPrevented).toBe(true);
    expect(form.requestSubmit).toHaveBeenCalledOnce();
    key(textarea, 'keydown', { keyCode: 229 });
    key(textarea, 'keydown', { isComposing: true });
    expect(form.requestSubmit).toHaveBeenCalledOnce();
    helper.destroy();
  });
  it('honors a disabled submitter and does not insert during composition', () => {
    const { form, textarea, initialize } = fixture();
    const submitter = new ElementStub();
    submitter.disabled = true;
    form.querySelector.mockReturnValue(submitter);
    const helper = initialize();
    key(textarea, 'keydown', {});
    expect(form.requestSubmit).not.toHaveBeenCalled();
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(helper.insertText('x')).toBe(false);
    expect(textarea.value).toBe('');
    helper.destroy();
  });
  it('stores an inserted emoticon as most recent and caps the local list', () => {
    const { textarea, storage, initialize } = fixture();
    storage.getItem.mockReturnValue(JSON.stringify(siteConfig.discussion.emoticons.slice(0, 6)));
    const helper = initialize();
    const tools = textarea.after.mock.calls[0][0] as ElementStub;
    const picker = tools.children[0];
    const groups = picker.children[1];
    const featured = groups.children[1].children[1];
    featured.children[6].dispatchEvent(new Event('click'));
    expect(textarea.value).toBe(siteConfig.discussion.emoticons[6]);
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual([siteConfig.discussion.emoticons[6], ...siteConfig.discussion.emoticons.slice(0, 5)]);
    expect(picker.open).toBe(false);
    helper.destroy();
  });
});

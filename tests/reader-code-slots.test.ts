import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReaderCodeVerification, initializeReaderCodeSlots, normalizeReaderCode } from '../src/lib/reader-code-slots';
import { siteConfig } from '../src/config/site';
import { initializeReaderLogin } from '../src/lib/reader-menu';
import { RequestError, RequestTimeoutError } from '../src/lib/client-request';

const motion = vi.hoisted(() => ({ disabled: true, animate: vi.fn() }));
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/motion', () => ({ motionDisabled: () => motion.disabled, animateMotion: motion.animate, animateContentHeight: (_target: unknown, update: () => void) => update() }));
vi.mock('../src/lib/client-request', async (original) => ({ ...await original<typeof import('../src/lib/client-request')>(), requestJson: transport.request }));
vi.mock('../src/lib/paper-caret', () => ({ attachPaperCaret: vi.fn() }));
vi.mock('../src/lib/reader-oauth-popup', () => ({ openReaderOAuthPopup: vi.fn() }));
vi.mock('../src/lib/reader-surface-geometry', () => ({ refreshReaderSurface: vi.fn() }));
vi.mock('../src/lib/reader-effects', () => ({ setReaderFeedback: (target: { textContent: string }, message: string) => { target.textContent = message; } }));
beforeEach(() => { vi.useFakeTimers(); motion.disabled = true; motion.animate.mockReset(); transport.request.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

class Node extends EventTarget {
  dataset: Record<string, string> = {};
  textContent = '';
  attributes = new Map<string, string>();
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  disabled = false;
  readOnly = false;
  hidden = false;
  isConnected = true;
  maxLength = 3;
  type = 'text';
  right = 0;
  child?: Node;
  queries = new Map<string, Node>();
  lists = new Map<string, Node[]>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getBoundingClientRect() { return { right: this.right }; }
  querySelector(selector = '') { return this.queries.get(selector) || this.child; }
  querySelectorAll(selector: string) { return this.lists.get(selector) || []; }
  checkValidity() { return Boolean(this.value) && (this.type !== 'email' || /^[^@]+@[^@]+\.[^@]+$/.test(this.value)); }
  scrollIntoView() {}
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  setRangeText(value: string, start: number, end: number) { this.value = this.value.slice(0, start) + value + this.value.slice(end); this.setSelectionRange(start + value.length, start + value.length); }
  focus() { Object.assign(document, { activeElement: this }); this.dispatchEvent(new Event('focus')); }
}

function fixture() {
  const input = new Node();
  const slots = Array.from({ length: 3 }, (_, index) => { const node = new Node(); node.child = new Node(); node.right = 56 + index * 66; return node; });
  const wash = new Node(); const check = new Node(); const cross = new Node(); const status = new Node();
  const root = { dataset: {} as Record<string, string>, querySelectorAll: () => slots,
    querySelector: (selector: string) => selector.includes('wash') ? wash : selector.includes('check') ? check : selector.includes('cross') ? cross : status };
  vi.stubGlobal('document', { activeElement: input });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'cubic-bezier(.22,1,.36,1)' }));
  const complete = vi.fn();
  const controller = initializeReaderCodeSlots(root as unknown as HTMLElement, input as unknown as HTMLInputElement, complete);
  const type = (value: string, position = value.length) => { input.value = value; input.setSelectionRange(position, position); input.dispatchEvent(new Event('input')); };
  return { input, slots, root, wash, check, cross, status, complete, controller, type };
}
function deferred<Value>() { let resolve!: (value: Value) => void; const promise = new Promise<Value>((finish) => { resolve = finish; }); return { promise, resolve }; }

describe('reader code editing', () => {
  it('preserves leading zeroes and native selection/deletion, completing each full edit only once', () => {
    const view = fixture();
    view.type('0'); view.type('00'); view.type('003');
    expect(view.slots.map((slot) => slot.child!.textContent)).toEqual(['0', '0', '3']);
    view.input.dispatchEvent(new Event('input'));
    expect(view.complete).toHaveBeenCalledOnce();
    view.input.setSelectionRange(1, 2); view.input.dispatchEvent(new Event('select'));
    expect(view.slots.map((slot) => slot.dataset.active)).toEqual(['false', 'true', 'false']);
    view.type('03', 1);
    expect(view.slots[2].dataset.filled).toBe('false');
    view.type('013', 2);
    expect(view.complete).toHaveBeenCalledTimes(2);
    view.type('014');
    expect(view.complete).toHaveBeenCalledTimes(3);
    expect(view.root.dataset.status).toBe('idle');
  });
  it('accepts an entire pasted or system-filled code, handles IME and pointer slot selection', () => {
    const view = fixture();
    const paste = new Event('paste', { cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '００３' } });
    view.input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true); expect(view.input.value).toBe('003');
    expect(view.complete).toHaveBeenCalledOnce();
    view.controller.reset();
    view.input.dispatchEvent(new Event('compositionstart')); view.type('０１２');
    expect(view.controller.composing).toBe(true);
    expect(view.complete).toHaveBeenCalledOnce();
    view.input.dispatchEvent(new Event('compositionend'));
    expect(view.input.value).toBe('012');
    expect(view.complete).toHaveBeenCalledTimes(2);
    const pointer = new Event('pointerdown', { cancelable: true }); Object.defineProperty(pointer, 'clientX', { value: 80 });
    view.input.dispatchEvent(pointer);
    expect([view.input.selectionStart, view.input.selectionEnd]).toEqual([1, 2]);
    view.controller.reset(); view.type('009');
    expect(view.complete).toHaveBeenCalledTimes(3);
    expect(normalizeReaderCode('a０ ０3z', 3)).toBe('003');
  });
  it('leaves disabled presentation untouched and resumes editing after a restored page reset', () => {
    const view = fixture(); view.input.disabled = true; view.type('003'); expect(view.slots.map((slot) => slot.child!.textContent)).toEqual(['', '', '']);
    view.controller.abort(); view.controller.reset(); view.input.disabled = false; view.type('007');
    expect(view.input.readOnly).toBe(false); expect(view.slots.map((slot) => slot.child!.textContent)).toEqual(['0', '0', '7']);
  });
});

describe('reader code verification ordering', () => {
  it('waits for server confirmation then complete success presentation, and rejects overlapping or terminal submissions', async () => {
    const request = deferred<void>(); const presentation = deferred<boolean>();
    const verify = vi.fn(() => request.promise); const present = vi.fn(() => presentation.promise); const navigate = vi.fn();
    const gate = createReaderCodeVerification(verify, present, navigate);
    const credentials = { email: 'fixture@example.com', code: '003' };
    const first = gate.submit(credentials);
    expect(await gate.submit(credentials)).toBe(false); expect(verify).toHaveBeenCalledOnce(); expect(present).not.toHaveBeenCalled();
    request.resolve(); await Promise.resolve();
    expect(present).toHaveBeenCalledOnce(); expect(gate.accepted).toBe(true); expect(navigate).not.toHaveBeenCalled();
    presentation.resolve(true); expect(await first).toBe(true); expect(navigate).toHaveBeenCalledOnce();
    expect(await gate.submit(credentials)).toBe(false);
  });
  it('retains editing on rejected codes and prevents late navigation from a departed or restored page', async () => {
    const request = deferred<void>(); const present = vi.fn(async () => true); const navigate = vi.fn();
    const verify = vi.fn().mockRejectedValueOnce(new Error('验证码不正确')).mockImplementationOnce(() => request.promise).mockResolvedValue(undefined);
    const gate = createReaderCodeVerification(verify, present, navigate);
    await expect(gate.submit({ email: 'fixture@example.com', code: '003' })).rejects.toThrow('验证码不正确');
    expect(gate.accepted).toBe(false); expect(present).not.toHaveBeenCalled();
    const pending = gate.submit({ email: 'fixture@example.com', code: '004' }); gate.reset(); request.resolve();
    expect(await pending).toBe(false); expect(navigate).not.toHaveBeenCalled();
    expect(await gate.submit({ email: 'fixture@example.com', code: '005' })).toBe(true);
  });
});

describe('reader code success presentation', () => {
  it('shows a bounded rejection cross even if animation completion stalls, and aborts without a delayed reset', async () => {
    motion.disabled = false; motion.animate.mockImplementation(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }));
    const view = fixture(); view.type('003'); const rejected = view.controller.reject(); const timing = siteConfig.readerCodeSlots;
    expect(view.root.dataset.status).toBe('error'); expect(view.input.readOnly).toBe(true);
    await vi.advanceTimersByTimeAsync(timing.errorRevealMilliseconds + timing.errorHoldMilliseconds - 1); expect(view.input.value).toBe('003');
    await vi.advanceTimersByTimeAsync(1); expect(await rejected).toBe(true); expect(view.input.value).toBe(''); expect(vi.getTimerCount()).toBe(0);
    view.type('004'); const interrupted = view.controller.reject(); view.controller.abort();
    expect(await interrupted).toBe(false); expect(view.input.value).toBe('004');
  });
  it('holds a static check briefly for reduced motion or paused animations, without stale timers', async () => {
    const view = fixture(); const accepted = view.controller.accept();
    expect(view.input.readOnly).toBe(true); expect(view.root.dataset.status).toBe('success');
    let complete = false; void accepted.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(siteConfig.readerCodeSlots.stillSuccessMilliseconds - 1); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await accepted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('completes merge, check and hold in order, and aborts without delayed completion', async () => {
    motion.disabled = false;
    motion.animate.mockImplementation((_target, _frames, options) => {
      let finish!: () => void; const finished = new Promise<void>((resolve) => { finish = resolve; });
      const timer = setTimeout(finish, options.duration + (options.delay || 0));
      return { finished, cancel: () => { clearTimeout(timer); finish(); } };
    });
    const view = fixture(); const accepted = view.controller.accept(); const timing = siteConfig.readerCodeSlots;
    expect(view.root.dataset.status).toBe('merging');
    await vi.advanceTimersByTimeAsync(timing.mergeMilliseconds); expect(view.root.dataset.status).toBe('success');
    let complete = false; void accepted.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(timing.checkMilliseconds + timing.successHoldMilliseconds - 1); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await accepted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    view.controller.reset(); const cancelled = view.controller.accept(); view.controller.abort();
    expect(await cancelled).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds failed or stuck animation APIs and still shows a check before completing', async () => {
    motion.disabled = false; motion.animate.mockImplementation(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }));
    const view = fixture(); const accepted = view.controller.accept(); const timing = siteConfig.readerCodeSlots;
    let complete = false; void accepted.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(timing.deadlineMilliseconds); expect(view.root.dataset.status).toBe('success'); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(timing.stillSuccessMilliseconds); expect(await accepted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    view.controller.reset(); motion.disabled = true; expect(view.root.dataset.status).toBe('idle');
  });
});

function loginFixture() {
  const panel = new Node(); const form = new Node(); const email = new Node(); const code = new Node();
  const emailStep = new Node(); const codeStep = new Node(); codeStep.hidden = true;
  const send = new Node(); const back = new Node(); const confirm = new Node(); const feedback = new Node();
  const codeRoot = new Node(); const wash = new Node(); const check = new Node(); const cross = new Node(); const status = new Node();
  const slots = Array.from({ length: 3 }, () => { const slot = new Node(); slot.child = new Node(); return slot; });
  codeRoot.lists.set('[data-reader-code-slot]', slots);
  codeRoot.queries = new Map([['[data-reader-code-wash]', wash], ['[data-reader-code-check]', check], ['[data-reader-code-cross]', cross], ['[data-reader-code-status]', status]]);
  const session = { reader: null, options: { email: true, providers: [] } };
  panel.dataset = { step: 'email', readerSession: JSON.stringify(session) };
  panel.queries = new Map([
    ['[data-reader-login-form]', form], ['[data-reader-login-feedback]', feedback], ['[data-reader-login-send]', send],
    ['[data-reader-login-back]', back], ['[data-reader-email-step]', emailStep], ['[data-reader-code-step]', codeStep],
    ['[data-reader-oauth-cancel]', new Node()], ['[data-reader-return-account]', new Node()], ['[data-reader-passkey-login]', new Node()],
    ['[data-reader-code-slots]', codeRoot], ['[data-reader-login-title]', new Node()],
  ]);
  form.queries.set('[type="submit"]', confirm);
  Object.assign(form, { elements: { namedItem: (name: string) => name === 'email' ? email : code } });
  email.value = 'fixture@example.com'; email.maxLength = 254;
  const document = Object.assign(new EventTarget(), { activeElement: email, createElement: () => new Node(),
    querySelector: (selector: string) => selector === '[data-reader-login]' ? panel : selector === '[data-reader-logout]' ? null : new Node(),
    querySelectorAll: () => [] });
  const navigate = vi.fn(); const window = Object.assign(new EventTarget(), { location: { replace: navigate } });
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'cubic-bezier(.22,1,.36,1)' }));
  initializeReaderLogin();
  const typeCode = (value: string) => { code.value = value; code.setSelectionRange(value.length, value.length); code.dispatchEvent(new Event('input')); };
  const changeEmail = (value: string) => { email.value = value; email.dispatchEvent(new Event('input')); };
  const click = (target: Node) => target.dispatchEvent(new Event('click'));
  const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }));
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return { panel, email, code, emailStep, codeStep, send, back, confirm, feedback, codeRoot, navigate, window, session, typeCode, changeEmail, click, submit, settle };
}

describe('two-step reader email login', () => {
  it('stays at email until a successful send and retains the address after a send failure', async () => {
    const view = loginFixture(); const request = deferred<{ cooldownSeconds: number }>();
    transport.request.mockRejectedValueOnce(new Error('验证码暂时无法发送。')).mockReturnValueOnce(request.promise);
    expect(view.codeStep.hidden).toBe(true); expect(view.code.disabled).toBe(true);
    view.click(view.send); await view.settle();
    expect(view.panel.dataset.step).toBe('email'); expect(view.email.value).toBe('fixture@example.com');
    expect(view.feedback.textContent).toBe('验证码暂时无法发送。');
    view.click(view.send); view.click(view.send); view.click(view.back);
    expect(transport.request).toHaveBeenCalledTimes(2); expect(view.panel.dataset.step).toBe('email');
    request.resolve({ cooldownSeconds: 60 }); await view.settle();
    expect(view.panel.dataset.step).toBe('code'); expect(view.emailStep.hidden).toBe(true);
    expect(view.codeStep.hidden).toBe(false); expect(view.feedback.textContent).toBe('');
    expect(view.code.disabled).toBe(false); expect(document.activeElement).toBe(view.code);
  });

  it('automatically confirms the third digit once, prevents concurrent submits and waits for server and success presentation', async () => {
    const view = loginFixture(); const verification = deferred<object>();
    transport.request.mockResolvedValueOnce({ cooldownSeconds: 60 }).mockReturnValueOnce(verification.promise);
    view.click(view.send); await view.settle();
    view.typeCode('0'); view.typeCode('00'); expect(transport.request).toHaveBeenCalledOnce();
    view.typeCode('003'); view.typeCode('003'); await view.settle();
    view.submit(); view.submit(); view.click(view.back);
    expect(view.panel.dataset.step).toBe('code'); expect(view.back.disabled).toBe(true);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(transport.request).toHaveBeenLastCalledWith('/api/reader/email-login.json', 'POST', { email: 'fixture@example.com', code: '003' }, expect.any(String));
    expect(view.codeRoot.dataset.status).toBe('idle'); expect(view.navigate).not.toHaveBeenCalled();
    verification.resolve({}); await view.settle();
    expect(view.codeRoot.dataset.status).toBe('success'); expect(view.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(siteConfig.readerCodeSlots.stillSuccessMilliseconds);
    expect(view.navigate).toHaveBeenCalledOnce(); expect(view.navigate).toHaveBeenCalledWith('/reader');
  });

  it('allows continuing the same challenge but does not let back or editing bypass the send cooldown', async () => {
    const view = loginFixture(); transport.request.mockResolvedValue({ cooldownSeconds: 60 });
    view.click(view.send); await view.settle(); view.click(view.back);
    expect(view.email.value).toBe('fixture@example.com'); expect(view.send.textContent).toBe('继续验证');
    view.click(view.send); expect(view.panel.dataset.step).toBe('code'); expect(transport.request).toHaveBeenCalledOnce();
    view.click(view.back); view.changeEmail('other@example.com');
    expect(view.send.disabled).toBe(true); view.click(view.send); view.submit();
    expect(view.panel.dataset.step).toBe('email'); expect(transport.request).toHaveBeenCalledOnce();
    view.changeEmail('fixture@example.com'); expect(view.send.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(60000); expect(view.send.textContent).toBe('获取验证码');
    view.click(view.send); await view.settle(); expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('waits for IME completion, shows a rejection cross before clearing, then restores first-slot focus', async () => {
    const view = loginFixture(); transport.request.mockResolvedValueOnce({ cooldownSeconds: 60 }).mockRejectedValueOnce(new RequestError('验证码不正确。', 400));
    view.click(view.send); await view.settle();
    view.code.dispatchEvent(new Event('compositionstart')); view.typeCode('００３'); view.submit();
    expect(transport.request).toHaveBeenCalledOnce();
    view.code.dispatchEvent(new Event('compositionend')); expect(view.code.value).toBe('003');
    expect(transport.request).toHaveBeenCalledTimes(2); view.submit(); await view.settle();
    expect(view.code.value).toBe('003'); expect(view.code.disabled).toBe(true); expect(view.codeRoot.dataset.status).toBe('error');
    expect(view.feedback.textContent).toBe('验证码不正确。'); expect(view.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(siteConfig.readerCodeSlots.stillErrorMilliseconds - 1); expect(view.code.value).toBe('003');
    await vi.advanceTimersByTimeAsync(1); expect(view.code.value).toBe(''); expect(view.code.disabled).toBe(false);
    expect([view.code.selectionStart, view.code.selectionEnd]).toEqual([0, 0]); expect(document.activeElement).toBe(view.code);
    expect(view.codeRoot.dataset.status).toBe('idle'); expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('ignores a send response after page departure and permits editing after a cached page returns', async () => {
    const view = loginFixture(); const request = deferred<object>();
    transport.request.mockReturnValueOnce(request.promise).mockResolvedValue(view.session);
    view.click(view.send); view.window.dispatchEvent(new Event('pagehide'));
    request.resolve({ cooldownSeconds: 60 }); await view.settle();
    expect(view.panel.dataset.step).toBe('email'); expect(view.navigate).not.toHaveBeenCalled();
    const restored = new Event('pageshow'); Object.defineProperty(restored, 'persisted', { value: true });
    view.window.dispatchEvent(restored); await view.settle();
    expect(view.email.disabled).toBe(false); expect(view.send.disabled).toBe(false);
  });

  it.each([
    [new RequestError('验证码验证过于频繁，每分钟最多 5 次，请稍后再试', 429), '每分钟最多 5 次'],
    [new RequestTimeoutError(), '结果尚未确认'],
  ])('preserves readable rate-limit or timeout feedback and never retries automatically after rejection', async (failure, message) => {
    const view = loginFixture(); transport.request.mockResolvedValueOnce({ cooldownSeconds: 60 }).mockRejectedValueOnce(failure);
    view.click(view.send); await view.settle();
    const paste = new Event('paste', { cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '003' } });
    view.code.dispatchEvent(paste); await view.settle();
    expect(transport.request).toHaveBeenCalledTimes(2); expect(view.codeRoot.dataset.status).toBe('error');
    expect(view.feedback.textContent).toContain(message);
    await vi.advanceTimersByTimeAsync(60000);
    expect(view.code.value).toBe(''); expect(view.codeRoot.dataset.status).toBe('idle');
    expect(view.feedback.textContent).toContain(message); expect(transport.request).toHaveBeenCalledTimes(2);
    expect(view.navigate).not.toHaveBeenCalled();
  });
});

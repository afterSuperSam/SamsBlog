import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeReaderEffects, readerRippleBounds, setReaderFeedback } from '../src/lib/reader-effects';
import { siteConfig } from '../src/config/site';

const motion = vi.hoisted(() => ({ disabled: true, animate: vi.fn() }));
vi.mock('../src/lib/motion', () => ({ motionDisabled: () => motion.disabled, animateMotion: motion.animate }));
beforeEach(() => { vi.useFakeTimers(); motion.disabled = true; motion.animate.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reader interaction effects', () => {
  it('uses pointer coordinates or the keyboard center and reaches all four corners', () => {
    expect(readerRippleBounds(100, 40)).toEqual({ left: 50, top: 20, diameter: 2 * Math.hypot(50, 20) });
    expect(readerRippleBounds(100, 40, 10, 5)).toEqual({ left: 10, top: 5, diameter: 2 * Math.hypot(90, 35) });
    expect(readerRippleBounds(100, 40, -10, 80)).toMatchObject({ left: 0, top: 40 });
  });
  it('adds only an absolute overlay in capture phase, skips disabled controls and removes paused feedback', async () => {
    class Node {
      style: Record<string, string> = {};
      children: Node[] = [];
      className = '';
      disabled = false;
      parent?: Node;
      setAttribute() {}
      append(node: Node) { node.parent = this; this.children.push(node); }
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
      closest() { return this; }
      matches() { return this.disabled; }
      getBoundingClientRect() { return { width: 100, height: 40, left: 10, top: 20 }; }
    }
    vi.stubGlobal('Element', Node);
    vi.stubGlobal('document', { createElement: () => new Node() });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    let click!: (event: unknown) => void;
    const listen = vi.fn((_name: string, listener: (event: unknown) => void) => { click = listener; });
    const root = { addEventListener: listen, contains: () => true } as unknown as HTMLElement;
    initializeReaderEffects(root);
    expect(listen).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
    const control = new Node();
    const event = { target: control, detail: 1, clientX: 30, clientY: 35, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    click(event);
    expect(control.children[0].className).toBe('reader-ripple-layer');
    expect(control.children[0].children[0].style.left).toBe('20px');
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(siteConfig.readerEffects.stillFeedbackMilliseconds);
    expect(control.children).toHaveLength(0);
    control.disabled = true; click(event); expect(control.children).toHaveLength(0);
  });
  it('updates aria-live feedback in place and animates from the existing stable height', () => {
    const cancel = vi.fn();
    const target = { textContent: '', getAnimations: () => [{ cancel }], getBoundingClientRect: () => ({ height: 30 }) } as unknown as HTMLElement;
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'cubic-bezier(.22,1,.36,1)' }));
    setReaderFeedback(target, '已保存');
    expect(target.textContent).toBe('已保存'); expect(cancel).toHaveBeenCalledOnce();
    expect(motion.animate).toHaveBeenCalledWith(target, expect.arrayContaining([expect.objectContaining({ height: '30px', opacity: 1 })]), expect.any(Object));
    setReaderFeedback(target, '已保存'); expect(motion.animate).toHaveBeenCalledOnce();
  });
});

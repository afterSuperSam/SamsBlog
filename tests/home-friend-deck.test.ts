import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceFriendInertia, friendDeckDistance, friendDeckOpacity, friendDeckTilt, initializeFriendDeck, interpolateFriendPhase, preserveFriendPhase, settleFriendMotion } from '../src/lib/home-friend-deck';
import { siteConfig } from '../src/config/site';

// 控制器回归只使用内存节点与事件，不连接页面、网络或数据库。
class DeckElement extends EventTarget {
  hidden = false;
  inert = false;
  focusVisible = false;
  textContent = '';
  clientWidth = 600;
  offsetWidth = 360;
  offsetHeight = 400;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  children: DeckElement[] = [];
  selectors: Record<string, DeckElement> = {};
  style = {
    visibility: '', opacity: '', transform: '', zIndex: '', pointerEvents: '', willChange: '',
    setProperty: (name: string, value: string) => { this.properties.set(name, value); },
    removeProperty: (name: string) => { this.properties.delete(name); },
  };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string) { return this.selectors[selector] || null; }
  querySelectorAll(selector: string) { return selector === '[data-friend-card]' ? this.children : []; }
  contains(element: unknown): boolean { return element === this || this.children.some((child) => child.contains(element)); }
  matches(selector: string) { return selector === ':focus-visible' && this.focusVisible; }
  closest() { return this.dataset.friendCard ? this : null; }
  focus = () => {};
  hasPointerCapture() { return false; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { top: 0, bottom: 500 }; }
}

function deckFixture(mode: 'reduced' | 'paused') {
  vi.useFakeTimers();
  const root = new DeckElement();
  const stage = new DeckElement();
  const counter = new DeckElement();
  const announcement = new DeckElement();
  const cards = ['1', '2', '3'].map((identifier) => {
    const card = new DeckElement(); card.dataset.friendCard = identifier; return card;
  });
  root.children = [stage]; stage.children = cards;
  root.selectors = { '[data-friend-deck-stage]': stage, '[data-friend-deck-count]': counter, '[data-friend-deck-status]': announcement };
  const documentStub = Object.assign(new EventTarget(), {
    hidden: false, activeElement: root,
    documentElement: { classList: { contains: () => mode === 'paused' } },
  });
  const windowStub = new EventTarget();
  root.focus = () => { documentStub.activeElement = root; };
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('Element', DeckElement);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: mode === 'reduced' }));
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '0', lineHeight: '20px' }));
  vi.stubGlobal('WheelEvent', { DOM_DELTA_PAGE: 2, DOM_DELTA_LINE: 1 });
  const requestFrame = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let show: () => void = () => {};
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { show = () => callback([{ isIntersecting: true }]); }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  const controller = initializeFriendDeck(root as unknown as HTMLElement);
  show();
  const dispatch = (target: EventTarget, type: string, properties: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (type: string, clientX: number, clientY = 0) => dispatch(type === 'pointerup' || type === 'pointercancel' ? windowStub : stage, type, { pointerId: 1, isPrimary: true, button: 0, clientX, clientY });
  const wheel = (deltaX: number, deltaY = 0) => dispatch(stage, 'wheel', { deltaX, deltaY, deltaMode: 0 });
  return { root, stage, counter, cards, controller, documentStub, requestFrame, dispatch, pointer, wheel };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('首页友链连续卡组', () => {
  it.each(['reduced', 'paused'] as const)('%s 模式保留整张手势切换，不播放动画或拦截纵向滚动', (mode) => {
    const { counter, cards, controller, pointer, wheel, requestFrame } = deckFixture(mode);
    pointer('pointerdown', 100); pointer('pointermove', 20);
    expect(counter.textContent).toBe('1 / 3');
    pointer('pointerup', 20);
    expect(counter.textContent).toBe('2 / 3');
    expect(cards[1].inert).toBe(false);
    pointer('pointerdown', 20); pointer('pointermove', 100); pointer('pointerup', 100);
    expect(counter.textContent).toBe('1 / 3');
    pointer('pointerdown', 100);
    expect(pointer('pointermove', 98, 50).defaultPrevented).toBe(false);
    pointer('pointerup', 98, 50);
    expect(wheel(1, 20).defaultPrevented).toBe(false);
    expect(counter.textContent).toBe('1 / 3');
    wheel(siteConfig.friendDeck.dragThresholdPixels / 2);
    expect(counter.textContent).toBe('1 / 3');
    wheel(siteConfig.friendDeck.dragThresholdPixels / 2);
    wheel(100);
    expect(counter.textContent).toBe('2 / 3');
    vi.advanceTimersByTime(siteConfig.friendDeck.wheelIdleMilliseconds);
    wheel(20);
    expect(counter.textContent).toBe('3 / 3');
    vi.advanceTimersByTime(10000);
    expect(counter.textContent).toBe('3 / 3');
    expect(requestFrame).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('刷新排除隐藏节点，保留当前站点并正确收敛到一张、零张和恢复', () => {
    const { root, counter, cards, controller, dispatch } = deckFixture('paused');
    dispatch(root, 'keydown', { key: 'ArrowRight' });
    expect(counter.textContent).toBe('2 / 3');
    controller.refresh(() => { cards[0].hidden = true; });
    expect(counter.textContent).toBe('1 / 2');
    expect(cards[1].inert).toBe(false);
    expect(cards[0].inert).toBe(true);
    controller.refresh(() => { cards[1].hidden = true; });
    expect(counter.textContent).toBe('1 / 1');
    expect(cards[2].inert).toBe(false);
    dispatch(root, 'keydown', { key: 'ArrowRight' });
    expect(counter.textContent).toBe('1 / 1');
    controller.refresh(() => { cards[2].hidden = true; });
    expect(counter.textContent).toBe('0 / 0');
    expect(cards.every((card) => card.inert)).toBe(true);
    expect(root.properties.get('--friend-deck-stage-height')).toBe('0px');
    controller.refresh(() => { cards[2].hidden = false; });
    expect(counter.textContent).toBe('1 / 1');
    expect(cards[2].inert).toBe(false);
    controller.destroy();
    expect(cards.every((card) => !card.inert)).toBe(true);
  });

  it('键盘焦点仍阻止滚轮换卡和刷新，拖动取消不换卡', async () => {
    const { root, counter, cards, controller, documentStub, dispatch, wheel, pointer } = deckFixture('reduced');
    cards[0].focusVisible = true; documentStub.activeElement = cards[0];
    expect(wheel(50).defaultPrevented).toBe(false);
    controller.refresh(() => { cards[0].hidden = true; });
    expect(cards[0].hidden).toBe(false);
    expect(counter.textContent).toBe('1 / 3');
    documentStub.activeElement = root; dispatch(root, 'focusout');
    await Promise.resolve();
    expect(cards[0].hidden).toBe(true);
    expect(counter.textContent).toBe('1 / 2');
    pointer('pointerdown', 100); pointer('pointermove', 20); pointer('pointercancel', 20);
    expect(counter.textContent).toBe('1 / 2');
    controller.destroy();
  });

  it('微倾角随友链编号稳定，重排不变且幅度受限', () => {
    const identifiers = ['1', '2', '3', '42', '100'];
    const forward = new Map(identifiers.map((identifier) => [identifier, friendDeckTilt(identifier)]));
    for (const identifier of [...identifiers].reverse()) {
      const tilt = friendDeckTilt(identifier);
      expect(tilt).toBe(forward.get(identifier));
      expect(Math.abs(tilt)).toBeLessThanOrEqual(1);
    }
    expect(new Set(forward.values()).size).toBe(identifiers.length);
  });

  it.each([2, 3, 6, 20])('%i 张卡回绕时已完全淡出，负向与多圈相位一致', (count) => {
    const seam = count / 2;
    for (const direction of [-1, 1]) {
      const before = friendDeckDistance(0, direction * (seam - .00001), count);
      const after = friendDeckDistance(0, direction * (seam + .00001), count);
      expect(Math.sign(before)).not.toBe(Math.sign(after));
      expect(friendDeckOpacity(before, count)).toBeLessThan(.000001);
      expect(friendDeckOpacity(after, count)).toBeLessThan(.000001);
    }
    expect(friendDeckDistance(1, -.37, count)).toBeCloseTo(friendDeckDistance(1, count * 100 - .37, count));
  });

  it('零张和单张保持有限静态值，两张不会在切换中同时消失', () => {
    expect(friendDeckOpacity(friendDeckDistance(0, 200.5, 0), 0)).toBe(0);
    expect(friendDeckOpacity(friendDeckDistance(0, 200.5, 1), 1)).toBe(1);
    for (let phase = -2; phase <= 2; phase += .05) {
      const opacity = [0, 1].map((index) => friendDeckOpacity(friendDeckDistance(index, phase, 2), 2));
      expect(Math.max(...opacity)).toBeGreaterThan(.7);
    }
  });

  it('惯性衰减不依赖帧切分', () => {
    const once = advanceFriendInertia(2.3, 1.8, 6, 1);
    let partitioned = { phase: 2.3, velocity: 1.8 };
    for (let index = 0; index < 60; index++) partitioned = advanceFriendInertia(partitioned.phase, partitioned.velocity, 6, 1 / 60);
    expect(partitioned.phase).toBeCloseTo(once.phase, 10);
    expect(partitioned.velocity).toBeCloseTo(once.velocity, 10);
    expect(once.velocity).toBeLessThan(1.8);
  });

  it('惯性转归位保留瞬时速度，归位不随帧切分突停', () => {
    const coast = advanceFriendInertia(2.1, 1.8, 3.5, 1.6);
    const destination = Math.round(coast.phase);
    const start = settleFriendMotion(coast.phase, coast.velocity, destination, 7, 0);
    expect(start.phase).toBe(coast.phase);
    expect(start.velocity).toBe(coast.velocity);
    const first = settleFriendMotion(coast.phase, coast.velocity, destination, 7, .000001);
    expect((first.phase - coast.phase) / .000001).toBeCloseTo(coast.velocity, 4);
    const once = settleFriendMotion(coast.phase, coast.velocity, destination, 7, 1);
    let partitioned = coast;
    for (let index = 0; index < 60; index++) partitioned = settleFriendMotion(partitioned.phase, partitioned.velocity, destination, 7, 1 / 60);
    expect(partitioned.phase).toBeCloseTo(once.phase, 10);
    expect(partitioned.velocity).toBeCloseTo(once.velocity, 10);
    expect(Math.abs(once.phase - destination)).toBeLessThan(Math.abs(coast.phase - destination));
  });

  it('水平滚动更快跟随，结束高速归位时不越过目标再回拉', () => {
    let slow = { phase: 0, velocity: 0 };
    let responsive = { phase: 0, velocity: 0 };
    for (let index = 1; index <= 12; index++) {
      slow = settleFriendMotion(slow.phase, slow.velocity, index / 20, 7, 1 / 60);
      responsive = settleFriendMotion(responsive.phase, responsive.velocity, index / 20, 18, 1 / 60);
    }
    expect(responsive.phase).toBeGreaterThan(slow.phase);
    expect(responsive.phase).toBeLessThanOrEqual(.6);
    for (const direction of [-1, 1]) {
      let position = { phase: 1 - direction * .2, velocity: direction * 2 };
      expect(settleFriendMotion(position.phase, position.velocity, 1, 7, 0).velocity).toBe(position.velocity);
      for (let index = 0; index < 60; index++) {
        const next = settleFriendMotion(position.phase, position.velocity, 1, 7, 1 / 60);
        expect((next.phase - position.phase) * direction).toBeGreaterThanOrEqual(0);
        expect((1 - next.phase) * direction).toBeGreaterThanOrEqual(0);
        position = next;
      }
    }
  });

  it('定时自动切换只前进一张，起止缓和且无超调', () => {
    expect(interpolateFriendPhase(4, 5, -1)).toBe(4);
    expect(interpolateFriendPhase(4, 5, 2)).toBe(5);
    expect(interpolateFriendPhase(4, 5, .1)).toBeLessThan(4.1);
    expect(interpolateFriendPhase(4, 5, .9)).toBeGreaterThan(4.9);
    expect(interpolateFriendPhase(4, 5, .25)).toBeLessThan(4.08);
    expect(interpolateFriendPhase(4, 5, .75)).toBeGreaterThan(4.92);
    let previous = 4;
    for (let index = 0; index <= 100; index++) {
      const phase = interpolateFriendPhase(4, 5, index / 100);
      expect(phase).toBeGreaterThanOrEqual(previous);
      expect(phase).toBeLessThanOrEqual(5);
      previous = phase;
    }
  });

  it('刷新排序保留前景友链和未完成的小数进度', () => {
    expect(preserveFriendPhase(['a', 'b', 'c'], ['c', 'a', 'b', 'd'], 4.25)).toBe(2.25);
    expect(preserveFriendPhase(['a', 'b', 'c'], ['c', 'b', 'a'], -.2)).toBeCloseTo(1.8);
    expect(preserveFriendPhase(['a', 'b'], ['a'], 1.4)).toBe(0);
    expect(preserveFriendPhase(['a'], [], 0)).toBe(0);
    expect(preserveFriendPhase(['a', 'b', 'c'], ['a', 'b'], 2.2)).toBeCloseTo(1.2);
  });
});

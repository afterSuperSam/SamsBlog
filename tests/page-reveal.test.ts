import { describe, expect, it } from 'vitest';
import { isInitiallyVisible, preparePageReveal } from '../src/lib/page-reveal';

function target(top: number, bottom: number) {
  const classes = new Set<string>();
  return { classes, getBoundingClientRect: () => ({ top, bottom }) as DOMRect,
    classList: { toggle(name: string, active: boolean) { if (active) classes.add(name); else classes.delete(name); return active; } } as DOMTokenList };
}

describe('first viewport reveal stability', () => {
  it('never hides already visible content when a module initializes after the first paint', () => {
    const element = target(100, 400);
    expect(preparePageReveal(element, 800)).toBe(false);
    expect(element.classes.has('reveal-pending')).toBe(false);
    element.classes.add('reveal-pending');
    expect(preparePageReveal(element, 800)).toBe(false);
    expect(element.classes.has('reveal-pending')).toBe(false);
  });
  it('leaves partially visible headings intact instead of splitting and hiding their text', () => {
    expect(isInitiallyVisible(target(790, 900), 800)).toBe(true);
    expect(isInitiallyVisible(target(-100, 5), 800)).toBe(true);
  });
  it('keeps below-fold content eligible for its existing scroll reveal', () => {
    const element = target(850, 1100);
    expect(preparePageReveal(element, 800)).toBe(true);
    expect(element.classes.has('reveal-pending')).toBe(true);
  });
});

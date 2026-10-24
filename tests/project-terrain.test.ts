import { describe, expect, it } from 'vitest';
import { createTerrainCells, terrainPresenceTarget } from '../src/lib/project-terrain';

describe('decorative project terrain', () => {
  it('keeps the same terrain after revisiting with independent stagger and varied heights', () => {
    const cells = createTerrainCells(24, 10);
    expect(cells).toEqual(createTerrainCells(24, 10));
    expect(cells.every(({ level, delay, tint }) => level >= 0 && level <= 1 && delay >= 0 && delay < 1 && tint >= 0 && tint <= 1)).toBe(true);
    expect(new Set(cells.map(({ delay }) => delay)).size).toBe(cells.length);
    expect(cells.some(({ level }) => level === 0)).toBe(true);
    expect(new Set(cells.map(({ level }) => level)).size).toBeGreaterThan(3);
  });

  it('keeps the full plateau at 10% of the scroll journey with symmetric entry and exit', () => {
    const at = (top: number) => terrainPresenceTarget(top, 1200, 900);
    expect(at(1000)).toBe(0);
    expect(at(900)).toBe(0);
    expect(at(690)).toBeGreaterThan(0);
    expect(at(690)).toBeLessThan(0.4);
    expect(at(375)).toBeGreaterThan(at(690));
    expect(at(60)).toBeLessThan(1);
    expect(at(-44)).toBeLessThan(1);
    expect(at(-45)).toBeCloseTo(1);
    expect(at(-150)).toBe(1);
    expect(at(-255)).toBeCloseTo(1);
    expect(at(-256)).toBeLessThan(1);
    expect(at(-360)).toBeLessThan(1);
    expect(at(-675)).toBeCloseTo(at(375));
    expect(at(-990)).toBeCloseTo(at(690));
    expect(at(-1200)).toBe(0);
    expect(at(-1400)).toBe(0);
    expect(terrainPresenceTarget(0, 700, 0)).toBe(0);
    expect(terrainPresenceTarget(0, 0, 900)).toBe(0);
  });

  it('leaves the center hidden while the outer columns are already settled', () => {
    const cells = createTerrainCells(24, 6);
    const edges = cells.filter(({ column }) => column === 0 || column === 23);
    const center = cells.filter(({ column }) => column === 11 || column === 12);
    expect(edges.every(({ delay, transitionSpan }) => delay + transitionSpan < 0.75)).toBe(true);
    expect(center.every(({ delay, transitionSpan }) => delay > 0.85 && transitionSpan < 0.08)).toBe(true);
    expect(cells.every(({ delay, transitionSpan }) => delay + transitionSpan <= 1)).toBe(true);
  });
});

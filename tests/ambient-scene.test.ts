import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const component = readFileSync(new URL('../src/components/AmbientScene.astro', import.meta.url), 'utf8');
const script = component.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Ambient scene script not found');
const browserScript = transpile(script);

function createAmbientScene(options: { hidden?: boolean; paused?: boolean; reduced?: boolean } = {}) {
  const classes = new Set<string>();
  const windowEvents = new Map<string, (event: { persisted?: boolean }) => void>();
  const documentEvents = new Map<string, () => void>();
  const buttonEvents = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  const label = { textContent: '' };
  const button = { disabled: false, setAttribute: (name: string, value: string) => attributes.set(name, value),
    querySelector: () => label, addEventListener: (name: string, action: () => void) => buttonEvents.set(name, action) };
  let stored = options.paused ? 'paused' : 'running';
  const storage = { getItem: () => stored, setItem: vi.fn((_key: string, value: string) => { stored = value; }) };
  const media = { matches: options.reduced ?? false, change: () => {}, addEventListener(_name: string, action: () => void) { this.change = action; } };
  const document = { hidden: options.hidden ?? false, querySelector: () => button,
    documentElement: { classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); } } },
    addEventListener: (name: string, action: () => void) => documentEvents.set(name, action) };
  const schedule = vi.fn();
  runInNewContext(browserScript, { document, localStorage: storage, matchMedia: () => media, console,
    window: { addEventListener: (name: string, action: (event: { persisted?: boolean }) => void) => windowEvents.set(name, action), setTimeout: schedule },
    requestAnimationFrame: schedule, setTimeout: schedule });
  return { classes, windowEvents, documentEvents, buttonEvents, attributes, button, label, media, document, storage, schedule };
}

describe('shared ambient motion preferences', () => {
  it('keeps the shared pause control and persists its accessible state', () => {
    const scene = createAmbientScene();
    expect(scene.classes.has('motion-paused')).toBe(false);
    scene.buttonEvents.get('click')!();
    expect(scene.classes.has('motion-paused')).toBe(true);
    expect(scene.attributes.get('aria-pressed')).toBe('true');
    expect(scene.label.textContent).toBe('开启动效');
    expect(scene.storage.setItem).toHaveBeenLastCalledWith('samsblog-motion', 'paused');
    scene.buttonEvents.get('click')!();
    expect(scene.classes.has('motion-paused')).toBe(false);
    expect(scene.schedule).not.toHaveBeenCalled();
  });
  it('honors system reduction changes without overwriting the saved preference', () => {
    const scene = createAmbientScene({ reduced: true });
    expect(scene.classes.has('motion-paused')).toBe(true);
    expect(scene.button.disabled).toBe(true);
    expect(scene.attributes.get('aria-label')).toBe('已按系统设置减少动效');
    scene.media.matches = false; scene.media.change();
    expect(scene.classes.has('motion-paused')).toBe(false);
    expect(scene.button.disabled).toBe(false);
    expect(scene.storage.setItem).not.toHaveBeenCalled();
  });
  it('restores visibility and the stored pause choice after back-forward cache return', () => {
    const scene = createAmbientScene({ hidden: true });
    expect(scene.classes.has('page-hidden')).toBe(true);
    scene.document.hidden = false; scene.documentEvents.get('visibilitychange')!();
    expect(scene.classes.has('page-hidden')).toBe(false);
    scene.storage.setItem('samsblog-motion', 'paused');
    scene.windowEvents.get('pageshow')!({ persisted: true });
    expect(scene.classes.has('motion-paused')).toBe(true);
    expect(scene.documentEvents.has('click')).toBe(false);
    expect(scene.windowEvents.has('scroll')).toBe(false);
    expect(scene.schedule).not.toHaveBeenCalled();
  });
});

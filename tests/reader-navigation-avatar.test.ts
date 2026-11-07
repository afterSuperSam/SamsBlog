import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile, ScriptTarget } from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/components/Header.astro', import.meta.url), 'utf8');
const start = source.indexOf('  const revealReaderAvatar =');
const end = source.indexOf('  document.querySelectorAll<HTMLImageElement>', start);
const reveal = runInNewContext(transpile(source.slice(start, end), { target: ScriptTarget.ES2022 }) + '\nrevealReaderAvatar;') as (image: unknown) => Promise<void>;
function avatar(decode: () => Promise<void> = async () => {}) {
  const classes = new Set<string>();
  const image = { source: '/fixture-avatar.webp', hidden: true, complete: true, naturalWidth: 24, decode,
    getAttribute: () => image.source, classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } };
  return { image, classes };
}
describe('navigation reader avatar reveal', () => {
  it('reveals a cached image only after its pixels decode', async () => {
    let complete!: () => void;
    const { image, classes } = avatar(() => new Promise<void>((resolve) => { complete = resolve; }));
    const pending = reveal(image);
    expect(classes.has('is-ready')).toBe(false);
    complete(); await pending;
    expect(classes.has('is-ready')).toBe(true); expect(image.hidden).toBe(false);
  });
  it('shows no placeholder for a failed image or decoding error', async () => {
    const failed = avatar(); failed.image.naturalWidth = 0;
    await reveal(failed.image); expect(failed.image.hidden).toBe(true);
    const rejected = avatar(async () => { throw new Error('decode failed'); });
    await reveal(rejected.image); expect(rejected.image.hidden).toBe(true); expect(rejected.classes.size).toBe(0);
  });
  it('does not reveal stale pixels when the avatar source changes during decoding', async () => {
    let complete!: () => void;
    const { image, classes } = avatar(() => new Promise<void>((resolve) => { complete = resolve; }));
    const pending = reveal(image); image.source = '/new-avatar.webp'; complete(); await pending;
    expect(classes.has('is-ready')).toBe(false);
  });
});

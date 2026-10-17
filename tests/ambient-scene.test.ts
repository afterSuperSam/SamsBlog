import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it } from 'vitest';

const component = readFileSync(new URL('../src/components/AmbientScene.astro', import.meta.url), 'utf8');
const script = component.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Ambient scene script not found');

describe('ambient particle positioning under strict CSP', () => {
  it('initializes particle positions through individual CSS properties', () => {
    const particles = [[7, 9], [44, 32], [81, 55]].map(([left, top]) => ({
      dataset: { moteLeft: String(left), moteTop: String(top) },
      properties: new Map<string, string>(),
      get style() {
        return { setProperty: (name: string, value: string) => this.properties.set(name, value) };
      },
    }));
    runInNewContext(transpile(script), {
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => selector === '.ambient-mote' ? particles : [],
        documentElement: { classList: { toggle() {} } },
        addEventListener() {},
        hidden: false,
      },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      localStorage: { getItem: () => null },
      console,
    });
    expect(particles.map(({ properties }) => Object.fromEntries(properties))).toEqual([
      { '--mote-left': '7%', '--mote-top': '9%', '--mote-delay': '-0s', '--mote-duration': '15s' },
      { '--mote-left': '44%', '--mote-top': '32%', '--mote-delay': '-1s', '--mote-duration': '16s' },
      { '--mote-left': '81%', '--mote-top': '55%', '--mote-delay': '-2s', '--mote-duration': '17s' },
    ]);
  });

  it('does not put particle coordinates in CSP-blocked inline attributes', () => {
    const particleMarkup = component.match(/return <i[\s\S]*?\/>/)?.[0];
    expect(particleMarkup).toBeDefined();
    expect(particleMarkup).not.toMatch(/\sstyle=/);
    expect(particleMarkup).toContain('data-mote-left={left}');
    expect(particleMarkup).toContain('data-mote-top={top}');
  });
});

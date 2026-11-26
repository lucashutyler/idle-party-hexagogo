import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles/codex.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

describe('codex.css', () => {
  it('runs nothing forever and blurs nothing', () => {
    expect(css).not.toMatch(/\binfinite\b/);
    expect(css).not.toContain('backdrop-filter');
  });

  it('sets no text below the smallest font token', () => {
    expect([...css.matchAll(/font-size:\s*([\d.]+)px/g)].map(([, size]) => Number(size)).filter(size => size < 11)).toEqual([]);
    expect(css).not.toMatch(/font-size:\s*[\d.]+(em|rem|%)/);
  });

  it('loads with the main stylesheet, after social.css and before the shared modal shells', () => {
    const order = [...main.matchAll(/import '\.\/styles\/([\w-]+)\.css';/g)].map(([, name]) => name);
    expect(order.indexOf('codex')).toBe(order.indexOf('social') + 1);
    expect(order.indexOf('codex')).toBeLessThan(order.indexOf('popups'));
  });

  it('wraps a long unbroken search query instead of scrolling the window sideways', () => {
    expect(css).toMatch(/\.codex-status,\s*\.codex-empty,\s*\.codex-footnote\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('gives the Bestiary row\'s small link a 44 px hit area', () => {
    const rule = css.match(/button\.bestiary-codex::before\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/width:\s*44px/);
    expect(rule).toMatch(/height:\s*44px/);
  });

  it('keeps hidden rows hidden although .ui-row is a flex box', () => {
    expect(css).toMatch(/\.settings-row\[hidden\][^{]*\{\s*display:\s*none/);
  });
});

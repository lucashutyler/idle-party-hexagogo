import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexLinkHtml, codexTargetAttr, codexTargetKey, installCodexDelegate, parseCodexTarget } from '../src/ui/codexLinks';
import type { CodexTarget } from '../src/ui/codexLinks';

describe('Codex targets', () => {
  it.each<[CodexTarget, string]>([
    [{ kind: 'home' }, 'home'],
    [{ kind: 'list', list: 'room' }, 'list:room'],
    [{ kind: 'monster', id: 'goblin' }, 'monster:goblin'],
    [{ kind: 'room', id: 'a:b:c' }, 'room:a:b:c'],
  ])('round-trips %j', (target, key) => {
    expect(codexTargetKey(target)).toBe(key);
    expect(parseCodexTarget(key)).toEqual(target);
  });

  it('rejects unknown kinds and lists, empty ids and missing values', () => {
    for (const value of ['', null, undefined, 'npc:x', 'list:npc', 'monster:', 'home:x', 'goblin']) {
      expect(parseCodexTarget(value)).toBeNull();
    }
  });

  it('escapes the attribute value and the label', () => {
    expect(codexTargetAttr({ kind: 'item', id: 'a"<b>' })).toBe('item:a&quot;&lt;b&gt;');
    const html = codexLinkHtml({ kind: 'item', id: 'a"b' }, '<Rope & Hook>', 'extra');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const button = holder.querySelector('button')!;
    expect(button.className).toBe('codex-link extra');
    expect(button.getAttribute('data-codex')).toBe('item:a"b');
    expect(button.textContent).toBe('<Rope & Hook>');
    expect(button.type).toBe('button');
  });
});

describe('installCodexDelegate', () => {
  let remove: (() => void) | undefined;

  afterEach(() => {
    remove?.();
    remove = undefined;
    document.body.innerHTML = '';
  });

  it('opens the target of any clicked [data-codex], even under a panel that stops clicks', () => {
    const open = vi.fn();
    remove = installCodexDelegate(open);
    document.body.innerHTML = '<div class="panel"><button data-codex="monster:wolf"><span class="inner">Wolf</span></button></div>';
    document.querySelector('.panel')!.addEventListener('click', e => e.stopPropagation());
    document.querySelector<HTMLElement>('.inner')!.click();
    expect(open).toHaveBeenCalledWith({ kind: 'monster', id: 'wolf' });
  });

  it('ignores clicks elsewhere and malformed values, and stops once removed', () => {
    const open = vi.fn();
    remove = installCodexDelegate(open);
    document.body.innerHTML = '<button class="plain">x</button><button class="bad" data-codex="npc:x">y</button><button class="good" data-codex="home">z</button>';
    document.querySelector<HTMLElement>('.plain')!.click();
    document.querySelector<HTMLElement>('.bad')!.click();
    expect(open).not.toHaveBeenCalled();
    remove();
    remove = undefined;
    document.querySelector<HTMLElement>('.good')!.click();
    expect(open).not.toHaveBeenCalled();
  });
});

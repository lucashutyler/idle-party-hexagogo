import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombatLogEntry, MasteryEntry } from '@idle-party-rpg/shared';
import type { GameClient } from '../src/network/GameClient';
import { CombatLogBuffer } from '../src/combat/CombatLogBuffer';
import { CombatLogFormatter } from '../src/combat/CombatLogFormatter';
import { CombatLogView } from '../src/combat/CombatLogView';
import { BestiaryModal, renderBestiaryRow } from '../src/ui/BestiaryModal';
import { renderItemPopupContent } from '../src/ui/ItemPopup';
import { bringToFront, release } from '../src/ui/ModalStack';

function render(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('item popup', () => {
  const rope = { id: 'rope"x', name: 'Rope', rarity: 'common' as const };

  it('links to the Codex under the stats only when asked', () => {
    const linked = render(renderItemPopupContent(rope, { codexLink: true }));
    const link = linked.querySelector('.item-popup-codex')!;
    expect(link.getAttribute('data-codex')).toBe('item:rope"x');
    expect(link.textContent).toBe('Open in Codex ›');
    expect(link.previousElementSibling!.classList.contains('item-popup-stats')).toBe(true);
    expect(render(renderItemPopupContent(rope)).querySelector('[data-codex]')).toBeNull();
  });
});

describe('bestiary', () => {
  const goblin: MasteryEntry = { monsterId: 'goblin', name: 'Goblin', kills: 3, rank: 0, maxRank: 5, nextAt: 25, prevAt: 0, bonusPct: 0 };

  it('gives each row a link to the monster\'s Codex entry, named for screen readers', () => {
    const row = render(renderBestiaryRow(goblin, 3));
    const link = row.querySelector('.bestiary-title .bestiary-codex')!;
    expect(link.getAttribute('data-codex')).toBe('monster:goblin');
    expect(link.getAttribute('aria-label')).toBe('Open Goblin in the Codex');
    expect(row.querySelector('.bestiary-name')!.textContent).toBe('Goblin');
  });

  it('leaves Escape to a window opened over it', () => {
    const client = {
      lastState: { character: { level: 3, mastery: { discovered: 1, mastered: 0, version: 1, recent: [] } } },
      lastBestiary: { type: 'bestiary', version: 1, entries: [goblin] },
      requestBestiary: vi.fn(),
      onBestiary: () => () => {},
      subscribe: () => () => {},
    };
    const modal = new BestiaryModal(client as unknown as GameClient);
    modal.open();
    const above = document.createElement('div');
    document.body.appendChild(above);
    bringToFront(above, () => {});

    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(modal.isOpen).toBe(true);

    release(above);
    above.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(modal.isOpen).toBe(false);
  });
});

describe('journal lines', () => {
  const entries: CombatLogEntry[] = [
    { id: 1, text: 'New in your Codex: Wolf.', type: 'codex', codex: { kind: 'monster', id: 'wolf' } },
    { id: 2, text: 'Victory!', type: 'victory' },
    { id: 3, text: 'Bad ref', type: 'codex', codex: { kind: 'npc', id: 'x' } as unknown as CombatLogEntry['codex'] },
  ];

  it('keep a valid Codex ref from the journal and drop a bad one', () => {
    const buffer = new CombatLogBuffer();
    buffer.ingestJournal(entries);
    expect(buffer.entries.map(line => line.codex)).toEqual([{ kind: 'monster', id: 'wolf' }, undefined, undefined]);
  });

  it('open the entry from the full log, but not from the ticker', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const buffer = new CombatLogBuffer();
    const view = new CombatLogView(wrapper, buffer, new CombatLogFormatter());
    view.setActive(true);
    buffer.ingestJournal(entries);
    vi.advanceTimersByTime(1000);
    expect(wrapper.querySelector('.combat-log-ticker [data-codex]')).toBeNull();
    expect(wrapper.querySelector('.combat-log-ticker .log-entry.codex')).not.toBeNull();

    view.setOpen(true);
    const link = wrapper.querySelector('.combat-log .log-entry.codex [data-codex]')!;
    expect(link.getAttribute('data-codex')).toBe('monster:wolf');
    expect(link.textContent).toBe('New in your Codex: Wolf.');
    expect(wrapper.querySelectorAll('.combat-log [data-codex]')).toHaveLength(1);
    view.setOpen(false);
    vi.useRealTimers();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

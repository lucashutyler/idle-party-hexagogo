import { describe, expect, it } from 'vitest';
import type { QuestObjective } from '@idle-party-rpg/shared';
import { objectiveHtml, objectiveText } from '../src/ui/QuestText';
import type { QuestResolutions } from '../src/ui/QuestText';

const resolutions: QuestResolutions = {
  monsters: { goblin: 'Goblin <Chief>' },
  items: { pelt: 'Wolf Pelt' },
  tiles: { dock: { name: 'Dock', zoneName: 'Shore' } },
};

function render(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('objectiveHtml', () => {
  it('links kill and collect targets to their Codex entries, escaping names', () => {
    const kill = render(objectiveHtml({ kind: 'kill', monsterId: 'goblin', count: 5 }, 2, resolutions, new Set()));
    expect(kill.textContent).toBe('Kill Goblin <Chief> (2/5)');
    expect(kill.querySelector('[data-codex]')!.getAttribute('data-codex')).toBe('monster:goblin');
    expect(kill.querySelector('[data-codex]')!.textContent).toBe('Goblin <Chief>');

    const collect = render(objectiveHtml({ kind: 'collect', itemId: 'pelt', count: 3 }, 9, resolutions, new Set()));
    expect(collect.textContent).toBe('Collect Wolf Pelt (3/3)');
    expect(collect.querySelector('[data-codex]')!.getAttribute('data-codex')).toBe('item:pelt');
  });

  it('links a room only once it is found', () => {
    const visit: QuestObjective = { kind: 'visit', tileId: 'dock' };
    const hidden = render(objectiveHtml(visit, 0, resolutions, new Set()));
    expect(hidden.textContent).toBe('Visit Dock, Shore');
    expect(hidden.querySelector('[data-codex]')).toBeNull();
    const found = render(objectiveHtml(visit, 1, resolutions, new Set(['dock'])));
    expect(found.textContent).toBe('Visit Dock, Shore — done');
    expect(found.querySelector('[data-codex]')!.getAttribute('data-codex')).toBe('room:dock');
  });

  it('leaves unknown names plain', () => {
    const el = render(objectiveHtml({ kind: 'kill', monsterId: 'ghost', count: 1 }, 0, resolutions, new Set()));
    expect(el.textContent).toBe('Kill unknown monster (0/1)');
    expect(el.querySelector('[data-codex]')).toBeNull();
  });

  it('matches objectiveText word for word, which stays plain', () => {
    const objectives: QuestObjective[] = [
      { kind: 'kill', monsterId: 'goblin', count: 5 },
      { kind: 'collect', itemId: 'pelt', count: 3 },
      { kind: 'visit', tileId: 'dock' },
    ];
    for (const obj of objectives) {
      const plain = render(objectiveText(obj, 1, resolutions));
      expect(plain.querySelector('[data-codex]')).toBeNull();
      expect(render(objectiveHtml(obj, 1, resolutions, new Set(['dock']))).textContent).toBe(plain.textContent);
    }
  });
});

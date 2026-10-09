import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompletedQuestEntry,
  NpcDefinition,
  QuestDefinition,
  QuestProgressEntry,
  ServerStateMessage,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { QuestLog } from '../src/ui/QuestLog';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

const DAY_MS = 24 * 60 * 60 * 1000;

function quest(id: string, overrides: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id,
    name: `Quest ${id}`,
    description: `About ${id}`,
    scope: 'solo',
    objectives: [{ kind: 'kill', monsterId: 'm-goblin', count: 3 }],
    rewards: [{ kind: 'gold', amount: 10 }],
    ...overrides,
  };
}

function active(questId: string, status: QuestProgressEntry['status'], progress: number[], acceptedAt = '2026-01-01T00:00:00.000Z'): QuestProgressEntry {
  return { questId, status, progress, acceptedAt };
}

interface StateParts {
  activeQuests?: QuestProgressEntry[];
  completedQuests?: CompletedQuestEntry[];
  weeklyCompletions?: Record<string, string>;
  questDefinitions?: Record<string, QuestDefinition>;
  offeredQuestIds?: string[];
  unlocked?: string[];
  availableQuestIds?: string[];
  tiles?: Record<string, { name: string; zoneName: string }>;
}

function makeState(parts: StateParts): ServerStateMessage {
  return {
    activeQuests: parts.activeQuests ?? [],
    completedQuests: parts.completedQuests ?? [],
    weeklyCompletions: parts.weeklyCompletions ?? {},
    questDefinitions: parts.questDefinitions ?? {},
    offeredQuestIds: parts.offeredQuestIds ?? [],
    questResolutions: { monsters: { 'm-goblin': 'Goblin' }, items: {}, tiles: parts.tiles ?? {} },
    unlocked: parts.unlocked ?? [],
    availableQuestIds: parts.availableQuestIds ?? [],
  } as unknown as ServerStateMessage;
}

function setup(npcs: NpcDefinition[] = [], rooms: Record<string, WorldTileDefinition[]> = {}) {
  document.body.innerHTML = '<div id="settings"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  } as unknown as GameClient;

  const worldCache = {
    getAllNpcs: () => npcs,
    getRoomsWithNpc: (id: string) => rooms[id] ?? [],
  } as unknown as WorldCache;

  const push = (parts: StateParts) => {
    lastState = makeState(parts);
    for (const l of listeners) l(lastState);
  };

  const cardIds = () => [...document.querySelectorAll<HTMLElement>('.quest-log-body .quest-card')].map(el => el.dataset.questId);
  const body = () => document.querySelector('.quest-log-body') as HTMLElement | null;
  const toggle = () => document.querySelector('.quest-log-completed-toggle') as HTMLButtonElement | null;
  const completedRows = () => document.querySelectorAll('.quest-log-completed-row');

  return { gameClient, worldCache, push, cardIds, body, toggle, completedRows, listenerCount: () => listeners.size };
}

describe('QuestLog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists active quests with ready-to-turn-in quests first', () => {
    const t = setup();
    t.push({
      activeQuests: [
        active('q-accepted', 'accepted', [0], '2026-01-01T00:00:00.000Z'),
        active('q-progress', 'in_progress', [1], '2026-01-02T00:00:00.000Z'),
        active('q-ready', 'ready', [3], '2026-01-03T00:00:00.000Z'),
      ],
      questDefinitions: { 'q-accepted': quest('q-accepted'), 'q-progress': quest('q-progress'), 'q-ready': quest('q-ready') },
    });
    const log = new QuestLog(t.gameClient, t.worldCache);
    log.open();

    expect(t.cardIds()).toEqual(['q-ready', 'q-progress', 'q-accepted']);
    const ready = document.querySelector('[data-quest-id="q-ready"]')!;
    expect(ready.classList.contains('quest-card-ready')).toBe(true);
    expect(ready.textContent).toContain('Ready to turn in');
    expect(ready.textContent).toContain('Kill Goblin (3/3)');
    expect(ready.textContent).toContain('10 Gold');
    expect(document.querySelector('[data-quest-id="q-progress"]')!.textContent).toContain('Kill Goblin (1/3)');
  });

  it('shows an empty state when there are no active quests', () => {
    const t = setup();
    t.push({});
    new QuestLog(t.gameClient, t.worldCache).open();
    expect(document.querySelector('.quest-log-empty')?.textContent).toContain('No active quests');
    expect(t.toggle()).toBeNull();
  });

  it('hides completed quests until the toggle is clicked, and again on reopen', () => {
    const t = setup();
    const now = Date.now();
    t.push({
      completedQuests: [
        { questId: 'q-weekly', completedAt: new Date(now - 10 * DAY_MS).toISOString() },
        { questId: 'q-once', completedAt: new Date(now - 5 * DAY_MS).toISOString() },
        { questId: 'q-weekly', completedAt: new Date(now - DAY_MS).toISOString() },
      ],
      weeklyCompletions: { 'q-weekly': new Date(now - DAY_MS).toISOString() },
      questDefinitions: {
        'q-weekly': quest('q-weekly', { repeat: 'weekly', name: 'Weekly Hunt' }),
        'q-once': quest('q-once', { name: 'Old Errand' }),
      },
    });
    const log = new QuestLog(t.gameClient, t.worldCache);
    log.open();

    expect(t.completedRows()).toHaveLength(0);
    expect(t.toggle()!.textContent).toContain('Completed (2)');
    expect(t.toggle()!.getAttribute('aria-expanded')).toBe('false');

    t.toggle()!.click();
    const rows = [...t.completedRows()];
    expect(rows.map(r => (r as HTMLElement).dataset.questId)).toEqual(['q-weekly', 'q-once']);
    expect(rows[0].textContent).toContain('Weekly Hunt');
    expect(rows[0].textContent).toContain('×2');
    expect(rows[0].textContent).toContain('Available again');
    expect(rows[1].textContent).not.toContain('×');
    expect(rows[1].textContent).not.toContain('Available again');

    log.close();
    log.open();
    expect(t.completedRows()).toHaveLength(0);
  });

  it('falls back to "Unknown quest" for quests no longer in the content, never the raw id', () => {
    const t = setup();
    t.push({
      activeQuests: [active('3f2b9c1e-guid', 'in_progress', [1])],
      completedQuests: [{ questId: '9a8b7c6d-guid', completedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const log = new QuestLog(t.gameClient, t.worldCache);
    log.open();
    t.toggle()!.click();

    const text = t.body()!.textContent ?? '';
    expect(text).toContain('Unknown quest');
    expect(text).not.toContain('3f2b9c1e-guid');
    expect(text).not.toContain('9a8b7c6d-guid');
  });

  it('skips re-rendering when a state push changes nothing it shows, and keeps the toggle open across updates', () => {
    const t = setup();
    const parts: StateParts = {
      activeQuests: [active('q1', 'in_progress', [1])],
      completedQuests: [{ questId: 'q0', completedAt: '2026-01-01T00:00:00.000Z' }],
      questDefinitions: { q1: quest('q1'), q0: quest('q0') },
    };
    t.push(parts);
    const log = new QuestLog(t.gameClient, t.worldCache);
    log.open();
    t.toggle()!.click();

    const card = document.querySelector('[data-quest-id="q1"]');
    t.push({ ...parts });
    expect(document.querySelector('[data-quest-id="q1"]')).toBe(card);

    t.push({ ...parts, activeQuests: [active('q1', 'in_progress', [2])] });
    const updated = document.querySelector('[data-quest-id="q1"]');
    expect(updated).not.toBe(card);
    expect(updated!.textContent).toContain('Kill Goblin (2/3)');
    expect(t.completedRows()).toHaveLength(1);
  });

  it('names where to turn in, revealing only explored rooms', () => {
    const npcs: NpcDefinition[] = [
      { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Hi', questIds: ['q1'] },
      { id: 'hermit', name: 'Hermit', emoji: '🧔', greeting: 'Hm', questIds: ['q1'] },
    ];
    const room = (id: string, name: string, zoneName: string) => ({ id, name, zoneName } as WorldTileDefinition);
    const t = setup(npcs, {
      mara: [room('r-square', 'Town Square', 'Hatchetmill')],
      hermit: [room('r-hut', 'Hermit Hut', 'Far Peaks')],
    });
    t.push({
      activeQuests: [active('q1', 'ready', [3])],
      questDefinitions: { q1: quest('q1') },
      unlocked: ['r-square'],
    });
    new QuestLog(t.gameClient, t.worldCache).open();

    const turnIn = document.querySelector('.quest-log-turnin')!;
    expect(turnIn.classList.contains('quest-log-turnin-ready')).toBe(true);
    expect(turnIn.textContent).toContain('Mara — Town Square, Hatchetmill');
    expect(turnIn.textContent).toContain('Hermit');
    expect(turnIn.textContent).not.toContain('Hermit Hut');
  });

  it('lists who has new quests above the active quests, naming explored rooms only', () => {
    const npcs: NpcDefinition[] = [
      { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Hi', questIds: ['q-new'] },
      { id: 'hermit', name: 'Hermit', emoji: '🧔', greeting: 'Hm', questIds: ['q-new'] },
      { id: 'smith', name: 'Smith', emoji: '🔨', greeting: 'Yo', questIds: ['q-other'] },
    ];
    const room = (id: string, name: string, zoneName: string) => ({ id, name, zoneName } as WorldTileDefinition);
    const t = setup(npcs, {
      mara: [room('r-square', 'Town Square', 'Hatchetmill')],
      hermit: [room('r-hut', 'Hermit Hut', 'Far Peaks')],
      smith: [room('r-forge', 'Forge', 'Hatchetmill')],
    });
    t.push({
      activeQuests: [active('q1', 'accepted', [0])],
      questDefinitions: { q1: quest('q1') },
      availableQuestIds: ['q-new'],
      unlocked: ['r-square', 'r-forge'],
    });
    new QuestLog(t.gameClient, t.worldCache).open();

    const section = t.body()!.firstElementChild!;
    expect(section.classList.contains('quest-log-givers')).toBe(true);
    expect(section.querySelector('.quest-log-givers-title')!.textContent).toBe('Quests available from');
    expect([...section.querySelectorAll('.quest-log-giver')].map(li => li.textContent)).toEqual([
      '🧙 Mara — Town Square, Hatchetmill',
    ]);

    t.push({ activeQuests: [active('q1', 'accepted', [0])], questDefinitions: { q1: quest('q1') }, unlocked: ['r-square'] });
    expect(document.querySelector('.quest-log-givers')).toBeNull();
  });

  it('names visit targets by room and area, never by coordinates', () => {
    const t = setup();
    t.push({
      activeQuests: [active('q1', 'in_progress', [1, 0, 0])],
      questDefinitions: {
        q1: quest('q1', {
          objectives: [
            { kind: 'visit', tileId: 'g-mill' },
            { kind: 'visit', tileId: 'g-nameless' },
            { kind: 'visit', tileId: 'g-unknown' },
          ],
        }),
      },
      tiles: {
        'g-mill': { name: 'Old Mill', zoneName: 'Greenvale' },
        'g-nameless': { name: '', zoneName: 'Greenvale' },
      },
    });
    new QuestLog(t.gameClient, t.worldCache).open();

    const objectives = [...document.querySelectorAll('.quest-objective')].map(el => el.textContent?.trim());
    expect(objectives).toEqual([
      '✓ Visit Old Mill, Greenvale — done',
      '• Visit a room in Greenvale',
      '• Visit a specific room',
    ]);
  });

  it('holds a state repaint while the completed toggle is pressed', () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const parts: StateParts = {
        activeQuests: [active('q1', 'in_progress', [1])],
        completedQuests: [{ questId: 'q0', completedAt: '2026-01-01T00:00:00.000Z' }],
        questDefinitions: { q1: quest('q1'), q0: quest('q0') },
      };
      t.push(parts);
      new QuestLog(t.gameClient, t.worldCache).open();
      const pressed = t.toggle()!;

      pressed.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      t.push({ ...parts, activeQuests: [active('q1', 'in_progress', [2])] });
      expect(t.toggle()).toBe(pressed);

      pressed.click();
      vi.advanceTimersByTime(0);
      expect(t.completedRows()).toHaveLength(1);
      expect(document.querySelector('[data-quest-id="q1"]')!.textContent).toContain('Kill Goblin (2/3)');
    } finally {
      document.dispatchEvent(new PointerEvent('pointercancel'));
      vi.useRealTimers();
    }
  });

  it('escapes author-supplied text', () => {
    const t = setup();
    t.push({
      activeQuests: [active('q1', 'accepted', [0])],
      questDefinitions: { q1: quest('q1', { name: '<img src=x onerror=alert(1)>' }) },
    });
    new QuestLog(t.gameClient, t.worldCache).open();
    expect(document.querySelector('.quest-log-body img')).toBeNull();
    expect(document.querySelector('.quest-card-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('unsubscribes and removes itself on close', () => {
    const t = setup();
    t.push({});
    const log = new QuestLog(t.gameClient, t.worldCache);
    log.open();
    log.open();
    expect(t.listenerCount()).toBe(1);
    expect(document.querySelectorAll('.quest-log-modal')).toHaveLength(1);

    (document.querySelector('.player-options-close') as HTMLButtonElement).click();
    expect(t.listenerCount()).toBe(0);
    expect(document.querySelector('.quest-log-modal')).toBeNull();
  });
});

describe('SettingsScreen quest log', () => {
  it('opens from the Quest Log button and closes when the screen is left', () => {
    const t = setup();
    t.push({});
    const screen = new SettingsScreen('settings', t.gameClient, t.worldCache);

    expect(document.querySelector('#btn-player-options')).toBeNull();
    (document.querySelector('#btn-quest-log') as HTMLButtonElement).click();
    expect(document.querySelector('.quest-log-modal')).not.toBeNull();

    screen.onDeactivate();
    expect(document.querySelector('.quest-log-modal')).toBeNull();
    expect(t.listenerCount()).toBe(0);
  });
});

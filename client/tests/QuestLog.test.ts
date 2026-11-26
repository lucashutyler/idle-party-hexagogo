import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompletedQuestEntry,
  MainStoryStep,
  NpcDefinition,
  QuestDefinition,
  QuestGuide,
  QuestProgressEntry,
  ServerStateMessage,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { QuestLog } from '../src/ui/QuestLog';
import { dismissTop } from '../src/ui/ModalStack';
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
  currentMapId?: string;
  questGuide?: QuestGuide;
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
    currentMapId: parts.currentMapId,
    questGuide: parts.questGuide,
  } as unknown as ServerStateMessage;
}

function setup(npcs: NpcDefinition[] = [], rooms: Record<string, WorldTileDefinition[]> = {}, viewableMaps: string[] = []) {
  document.body.innerHTML = '';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  } as unknown as GameClient;

  const worldCache = {
    getAllNpcs: () => npcs,
    getRoomsWithNpc: (id: string) => rooms[id] ?? [],
    viewableMapIds: () => new Set(viewableMaps),
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

describe('Quest log room links', () => {
  const room = (id: string, mapId: string, name: string) => ({ id, mapId, name, zoneName: 'Hatchetmill' } as WorldTileDefinition);
  const mara: NpcDefinition = { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Hi', questIds: ['q1', 'q-new'] };
  const hermit: NpcDefinition = { id: 'hermit', name: 'Hermit', emoji: '🧔', greeting: 'Hm', questIds: ['q1'] };
  const rooms = { mara: [room('r-square', 'overworld', 'Town Square')], hermit: [room('r-cave', 'cellar', 'Deep Cave')] };
  const parts: StateParts = {
    activeQuests: [active('q1', 'ready', [3])],
    questDefinitions: { q1: quest('q1') },
    availableQuestIds: ['q-new'],
    unlocked: ['r-square', 'r-cave'],
    currentMapId: 'overworld',
  };

  it('closes the log and goes to the room when a turn-in row is tapped', () => {
    const t = setup([mara, hermit], rooms);
    t.push(parts);
    const onGoToRoom = vi.fn();
    new QuestLog(t.gameClient, t.worldCache, onGoToRoom).open();

    document.querySelector<HTMLButtonElement>('.quest-log-turnin .quest-log-go')!.click();
    expect(onGoToRoom).toHaveBeenCalledWith('r-square');
    expect(document.querySelector('.quest-log-modal')).toBeNull();
  });

  it('goes to the room from a quest giver row, keeping the row text', () => {
    const t = setup([mara], rooms);
    t.push(parts);
    const onGoToRoom = vi.fn();
    new QuestLog(t.gameClient, t.worldCache, onGoToRoom).open();

    const go = document.querySelector<HTMLButtonElement>('.quest-log-giver .quest-log-go')!;
    expect(go.textContent).toBe('🧙 Mara — Town Square, Hatchetmill');
    go.click();
    expect(onGoToRoom).toHaveBeenCalledWith('r-square');
  });

  it('leaves rooms on another map as plain text', () => {
    const t = setup([mara, hermit], rooms);
    t.push(parts);
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();

    const ids = [...document.querySelectorAll<HTMLElement>('.quest-log-turnin .quest-log-go')].map(el => el.dataset.roomId);
    expect(ids).toEqual(['r-square']);
    expect(document.querySelector('.quest-log-turnin')!.textContent).toContain('Hermit — Deep Cave, Hatchetmill');
  });

  it('links rooms on another map the player has visited, which opens that map', () => {
    const t = setup([mara, hermit], rooms, ['overworld', 'cellar']);
    t.push(parts);
    const onGoToRoom = vi.fn();
    new QuestLog(t.gameClient, t.worldCache, onGoToRoom).open();

    const ids = [...document.querySelectorAll<HTMLElement>('.quest-log-turnin .quest-log-go')].map(el => el.dataset.roomId);
    expect(ids).toEqual(['r-square', 'r-cave']);
    document.querySelector<HTMLButtonElement>('.quest-log-go[data-room-id="r-cave"]')!.click();
    expect(onGoToRoom).toHaveBeenCalledWith('r-cave');
  });

  it('has no links without someone to take the player there', () => {
    const t = setup([mara], rooms);
    t.push(parts);
    new QuestLog(t.gameClient, t.worldCache).open();
    expect(document.querySelector('.quest-log-go')).toBeNull();
  });

  it('draws a progress bar for counted objectives only', () => {
    const t = setup();
    t.push({
      activeQuests: [active('q1', 'in_progress', [1, 0])],
      questDefinitions: {
        q1: quest('q1', { objectives: [{ kind: 'kill', monsterId: 'm-goblin', count: 4 }, { kind: 'visit', tileId: 'g-mill' }] }),
      },
    });
    new QuestLog(t.gameClient, t.worldCache).open();
    const fills = document.querySelectorAll<HTMLElement>('.quest-progress-fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].style.transform).toBe('scaleX(0.250)');
  });
});

describe('Quest log ownership', () => {
  it('closes through the modal stack, and keeps the room callback for its owner', () => {
    const t = setup();
    t.push({});
    const onGoToRoom = vi.fn();
    const log = new QuestLog(t.gameClient, t.worldCache, onGoToRoom);
    expect(log.onGoToRoom).toBe(onGoToRoom);

    log.open();
    expect(document.querySelector('.quest-log-modal')).not.toBeNull();

    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.quest-log-modal')).toBeNull();
    expect(t.listenerCount()).toBe(0);
  });
});

describe('Quest log main story', () => {
  const room = (id: string, mapId: string, name: string, zoneName = 'Vale') => ({ id, mapId, name, zoneName } as WorldTileDefinition);
  const guideNpc: NpcDefinition = { id: 'guide-npc', name: 'Orla', emoji: '🧭', greeting: 'Hi', questIds: ['m-next', 'm-locked', 'side-new'] };
  const farNpc: NpcDefinition = { id: 'far-npc', name: 'Bram', emoji: '🪓', greeting: 'Hm', questIds: ['m-far', 'side-far'] };
  const sideNpc: NpcDefinition = { id: 'side-npc', name: 'Tess', emoji: '🧺', greeting: 'Yo', questIds: ['side-here'] };
  const rooms = {
    'guide-npc': [room('r-camp', 'overworld', 'Camp')],
    'far-npc': [room('r-cave', 'cellar', 'Cave', 'Deep')],
    'side-npc': [room('r-stall', 'overworld', 'Stall')],
  };
  const main = (id: string, over: Partial<QuestDefinition> = {}) => quest(id, { name: `Progress: Title ${id}`, ...over });
  const step = (questId: string, over: Partial<MainStoryStep> = {}): MainStoryStep =>
    ({ questId, name: `Progress: Title ${questId}`, status: 'available', ...over });

  function storyParts(over: Partial<StateParts> = {}): StateParts {
    return {
      activeQuests: [active('m-now', 'in_progress', [1]), active('side-now', 'accepted', [0])],
      questDefinitions: { 'm-now': main('m-now'), 'side-now': quest('side-now'), 'm-old': main('m-old') },
      completedQuests: [{ questId: 'm-old', completedAt: '2026-01-01T00:00:00.000Z' }],
      availableQuestIds: ['m-next', 'side-here'],
      unlocked: ['r-camp', 'r-stall', 'r-cave'],
      currentMapId: 'overworld',
      questGuide: {
        steps: [step('m-now', { status: 'active' }), step('m-next', { giverNpcIds: ['guide-npc'] })],
        mainQuestIds: ['m-now', 'm-next'],
      },
      ...over,
    };
  }

  it('pins the main story in gold above the other quests, then who has quests, then the history', () => {
    const t = setup([guideNpc, farNpc, sideNpc], rooms);
    t.push(storyParts());
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();

    const sections = [...t.body()!.children].map(el => el.className);
    expect(sections).toEqual(['quest-log-main', 'quest-card', 'quest-log-givers', 'quest-log-completed-toggle']);
    const gold = document.querySelector('.quest-log-main')!;
    expect(gold.querySelector('.quest-log-main-title')!.textContent).toBe('Main Story');
    expect(gold.querySelector('.quest-card')!.classList.contains('quest-card-main')).toBe(true);
    expect(t.cardIds()).toEqual(['m-now', 'side-now']);
  });

  it('strips the main prefix in the gold section only', () => {
    const t = setup([guideNpc], rooms);
    t.push(storyParts({ questGuide: { steps: [step('m-now', { status: 'active' })], mainQuestIds: ['m-now'] } }));
    new QuestLog(t.gameClient, t.worldCache).open();
    t.toggle()!.click();

    expect(document.querySelector('.quest-log-main .quest-card-name')!.textContent).toBe('Title m-now');
    expect(document.querySelector('.quest-log-completed-name')!.textContent).toContain('Progress: Title m-old');
  });

  it('shows the next step as a link to the giver on this map', () => {
    const t = setup([guideNpc], rooms);
    t.push(storyParts());
    const onGoToRoom = vi.fn();
    new QuestLog(t.gameClient, t.worldCache, onGoToRoom).open();

    const next = document.querySelector<HTMLButtonElement>('.quest-log-main .quest-log-step')!;
    expect(next.tagName).toBe('BUTTON');
    expect(next.textContent).toBe('Next: Title m-next: talk to Orla, Camp, Vale');
    next.click();
    expect(onGoToRoom).toHaveBeenCalledWith('r-camp');
  });

  it('names an unexplored giver room for the next step', () => {
    const t = setup([guideNpc], rooms);
    t.push(storyParts({ unlocked: [] }));
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();
    expect(document.querySelector('.quest-log-step')!.textContent).toBe('Next: Title m-next: talk to Orla, Camp, Vale');
  });

  it('says what level a locked step needs, and what a side step leads to', () => {
    const t = setup([guideNpc, farNpc], rooms);
    t.push(storyParts({ questGuide: { steps: [step('m-locked', { status: 'needs_level', requiredLevel: 9, giverNpcIds: ['guide-npc'] })], mainQuestIds: [] } }));
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();
    expect(document.querySelector('.quest-log-step')!.textContent).toBe('Reach level 9 to continue: Title m-locked');
    expect(document.querySelector('.quest-log-step')!.tagName).toBe('DIV');

    t.push(storyParts({
      questGuide: {
        steps: [{ questId: 'side-far', name: 'Gather Kindling', status: 'available', leadsTo: 'Progress: Title m-far', giverNpcIds: ['far-npc'] }],
        mainQuestIds: [],
      },
    }));
    const lead = document.querySelector('.quest-log-step')!;
    expect(lead.textContent).toBe('Needed for the main story (Title m-far): Gather Kindling: talk to Bram, Cave, Deep');
    expect(lead.tagName).toBe('DIV');
  });

  it('marks an active quest the main story needs', () => {
    const t = setup();
    t.push(storyParts({
      activeQuests: [active('side-now', 'accepted', [0])],
      questGuide: { steps: [{ questId: 'side-now', name: 'Quest side-now', status: 'active', leadsTo: 'Progress: Title m-far' }], mainQuestIds: [] },
    }));
    new QuestLog(t.gameClient, t.worldCache).open();
    const card = document.querySelector('.quest-log-main .quest-card-main')!;
    expect(card.querySelector('.quest-card-leads')!.textContent).toBe('Needed for the main story (Title m-far)');
    expect(card.querySelector('.quest-card-name')!.textContent).toBe('Quest side-now');
  });

  it('shows one upcoming step at most, one on another map only when none is on this one', () => {
    const t = setup([guideNpc, farNpc], rooms);
    const awayFirst = [step('m-far', { giverNpcIds: ['far-npc'] }), step('m-next', { status: 'needs_level', requiredLevel: 4, giverNpcIds: ['guide-npc'] })];
    t.push(storyParts({ questGuide: { steps: awayFirst, mainQuestIds: [] } }));
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();
    expect([...document.querySelectorAll('.quest-log-step')].map(el => el.textContent)).toEqual(['Reach level 4 to continue: Title m-next']);

    t.push(storyParts({ questGuide: { steps: [step('m-far', { giverNpcIds: ['far-npc'] }), step('m-far2', { giverNpcIds: ['far-npc'] })], mainQuestIds: [] } }));
    const steps = [...document.querySelectorAll('.quest-log-step')];
    expect(steps.map(el => el.textContent)).toEqual(['Next: Title m-far: talk to Bram, Cave, Deep']);
    expect(steps[0].tagName).toBe('DIV');
  });

  it('leaves the gold section out when the story has nothing to show', () => {
    const t = setup();
    t.push(storyParts({ activeQuests: [active('side-now', 'accepted', [0])], questGuide: { steps: [], mainQuestIds: [] } }));
    new QuestLog(t.gameClient, t.worldCache).open();
    expect(document.querySelector('.quest-log-main')).toBeNull();
    expect(t.body()!.firstElementChild!.classList.contains('quest-card')).toBe(true);
  });

  it('tags main givers, lists them first and folds givers on other maps behind a toggle that survives updates', () => {
    const t = setup([sideNpc, guideNpc, farNpc], rooms);
    const parts = storyParts({ availableQuestIds: ['side-here', 'm-next', 'side-far'] });
    t.push(parts);
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();

    const givers = () => [...document.querySelectorAll('.quest-log-giver')].map(li => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(givers()).toEqual(['Main 🧭 Orla — Camp, Vale', '🧺 Tess — Stall, Vale']);
    expect(document.querySelector('.quest-log-giver .quest-pill-main')!.textContent).toBe('Main');
    const more = () => document.querySelector<HTMLButtonElement>('.quest-log-givers-more')!;
    expect(more().textContent).toContain('1 more on other maps');
    expect(more().getAttribute('aria-expanded')).toBe('false');

    more().click();
    expect(givers()).toEqual(['Main 🧭 Orla — Camp, Vale', '🧺 Tess — Stall, Vale', '🪓 Bram — Cave, Deep']);
    t.push({ ...parts, activeQuests: [active('m-now', 'in_progress', [2]), active('side-now', 'accepted', [0])] });
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(givers()).toHaveLength(3);
  });

  it("keeps today's layout when the server sends no guide", () => {
    const t = setup([guideNpc], rooms);
    t.push(storyParts({ questGuide: undefined }));
    new QuestLog(t.gameClient, t.worldCache, vi.fn()).open();

    expect(document.querySelector('.quest-log-main')).toBeNull();
    expect(document.querySelector('.quest-pill-main')).toBeNull();
    expect(document.querySelector('.quest-log-givers-more')).toBeNull();
    expect(t.body()!.firstElementChild!.classList.contains('quest-log-givers')).toBe(true);
    expect(document.querySelector('[data-quest-id="m-now"] .quest-card-name')!.textContent).toBe('Progress: Title m-now');
  });
});

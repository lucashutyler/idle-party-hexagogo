import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpcDefinition, QuestDefinition, QuestGuide, QuestProgressEntry, ServerStateMessage, WorldMapMeta } from '@idle-party-rpg/shared';
import { QuestTracker, type QuestTrackerLookups } from '../src/ui/QuestTracker';
import type { GameClient } from '../src/network/GameClient';
import type { NpcRoom } from '../src/ui/QuestLogModel';

type StateListener = (state: ServerStateMessage) => void;

const MAPS: WorldMapMeta[] = [{ id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } }];
const ORLA: NpcDefinition = { id: 'orla', name: 'Orla', emoji: '🧭', greeting: '', questIds: ['m-next', 'side'] };
const ROOMS: Record<string, NpcRoom[]> = {
  orla: [
    { id: 'r-camp', mapId: 'overworld', name: 'Camp', zoneName: 'Vale' },
    { id: 'r-hut', mapId: 'overworld', name: 'Hut', zoneName: 'Vale' },
  ],
};
const TILES: Record<string, NpcRoom> = { 'r-mill': { id: 'r-mill', mapId: 'overworld', name: 'Mill', zoneName: 'Vale' } };

function quest(id: string, over: Partial<QuestDefinition> = {}): QuestDefinition {
  return { id, name: `Progress: Title ${id}`, description: '', scope: 'party_shared', objectives: [{ kind: 'kill', monsterId: 'm-rat', count: 5 }], rewards: [], ...over };
}

function active(questId: string, progress: number[]): QuestProgressEntry {
  return { questId, status: 'in_progress', progress, acceptedAt: '2026-01-01T00:00:00.000Z' };
}

function makeState(parts: Partial<ServerStateMessage>): ServerStateMessage {
  return {
    currentMapId: 'overworld',
    party: { col: 4, row: 2, state: 'idle', path: [] },
    unlocked: [],
    questResolutions: { monsters: { 'm-rat': 'Rat' }, items: {}, tiles: { 'r-mill': { name: 'Mill', zoneName: 'Vale' } } },
    ...parts,
  } as unknown as ServerStateMessage;
}

const mainGuide = (questId: string): QuestGuide => ({ steps: [{ questId, name: `Progress: Title ${questId}`, status: 'active' }], mainQuestIds: [questId] });

function setup(initial: Partial<ServerStateMessage> | null) {
  document.body.innerHTML = '<div class="combat-quest-tracker"></div>';
  const root = document.querySelector<HTMLElement>('.combat-quest-tracker')!;
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = initial ? makeState(initial) : null;
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener, opts?: { replay?: boolean }) => {
      listeners.add(l);
      if (opts?.replay && lastState) l(lastState);
      return () => { listeners.delete(l); };
    },
  } as unknown as GameClient;
  const lookups: QuestTrackerLookups = {
    getAllNpcs: () => [ORLA],
    getNpc: (id) => (id === ORLA.id ? ORLA : undefined),
    getRoomsWithNpc: (id) => ROOMS[id] ?? [],
    getTileByGuid: (id) => TILES[id],
    getMaps: () => MAPS,
    getTileOn: (mapId, col, row) => (mapId === 'overworld' && col === 4 && row === 2 ? { id: 'r-hut', npcId: 'orla' } : undefined),
  };
  const tracker = new QuestTracker(root, gameClient, lookups);
  const actions = { openQuestLog: vi.fn(), showRoom: vi.fn() };
  tracker.setActions(actions);
  const push = (parts: Partial<ServerStateMessage>) => {
    lastState = makeState(parts);
    for (const l of listeners) l(lastState);
  };
  const button = () => root.querySelector<HTMLButtonElement>('.quest-tracker');
  return { root, push, actions, button };
}

describe('QuestTracker', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays hidden with nothing to say, and appears with the replayed state', () => {
    expect(setup(null).root.hidden).toBe(true);

    const empty = setup({});
    expect(empty.root.hidden).toBe(true);
    expect(empty.button()).toBeNull();

    const t = setup({ activeQuests: [active('m1', [2])], questDefinitions: { m1: quest('m1') }, questGuide: mainGuide('m1') });
    expect(t.root.hidden).toBe(false);
    expect(t.button()!.textContent).toBe('MainTitle m1Rat 2/5');
    expect(t.button()!.getAttribute('aria-label')).toBe('Main story: Title m1: Rat 2/5');
    expect(t.button()!.dataset.kind).toBe('main');
  });

  it('opens the Quest Log for a goal without a room', () => {
    const t = setup({ activeQuests: [active('m1', [2])], questDefinitions: { m1: quest('m1') }, questGuide: mainGuide('m1') });
    t.button()!.click();
    expect(t.actions.openQuestLog).toHaveBeenCalledTimes(1);
    expect(t.actions.showRoom).not.toHaveBeenCalled();
  });

  it('shows the room of a visit goal on this map', () => {
    const t = setup({
      activeQuests: [active('m1', [0])],
      questDefinitions: { m1: quest('m1', { objectives: [{ kind: 'visit', tileId: 'r-mill' }] }) },
      questGuide: mainGuide('m1'),
      unlocked: ['r-mill'],
    });
    t.button()!.click();
    expect(t.actions.showRoom).toHaveBeenCalledWith('r-mill');
  });

  it("shows the party's own room when the NPC to talk to stands there", () => {
    const t = setup({ offeredQuestIds: ['side'], availableQuestIds: ['side'], questGiverNpcId: 'orla' });
    expect(t.button()!.textContent).toBe('Orla has work for you');
    expect(t.button()!.dataset.kind).toBe('here');
    t.button()!.click();
    expect(t.actions.showRoom).toHaveBeenCalledWith('r-hut');
  });

  it('hides again when the goal is gone', () => {
    const t = setup({ offeredQuestIds: ['side'], availableQuestIds: ['side'], questGiverNpcId: 'orla' });
    t.push({});
    expect(t.root.hidden).toBe(true);
    expect(t.button()).toBeNull();
  });

  describe('while pressed', () => {
    afterEach(() => {
      document.dispatchEvent(new PointerEvent('pointercancel'));
      vi.useRealTimers();
    });

    it('holds a repaint until the press ends', () => {
      vi.useFakeTimers();
      const t = setup({ activeQuests: [active('m1', [2])], questDefinitions: { m1: quest('m1') }, questGuide: mainGuide('m1') });
      const pressed = t.button()!;

      pressed.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      t.push({ activeQuests: [active('m1', [3])], questDefinitions: { m1: quest('m1') }, questGuide: mainGuide('m1') });
      expect(t.button()).toBe(pressed);
      expect(pressed.textContent).toContain('Rat 2/5');

      pressed.click();
      expect(t.actions.openQuestLog).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(0);
      expect(t.button()!.textContent).toContain('Rat 3/5');
    });
  });
});

describe('quest line hit areas', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/combat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const px = (body: string, prop: string) => {
    const match = new RegExp(`(?:^|;|\\s)${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
    return match ? Number(match[1]) : undefined;
  };
  const insetBottom = (body: string) => {
    const parts = /inset:\s*([^;]+);/.exec(body)?.[1].trim().split(/\s+/).map(v => Number.parseFloat(v));
    if (!parts) return px(body, 'bottom');
    return parts.length === 1 ? parts[0] : parts[2] ?? parts[0];
  };

  it('keeps the header buttons from taking taps meant for a shown quest line', () => {
    const slop = rules.find(r => r.selector.includes('.combat-run-btn::after') && !r.selector.includes('quest-tracker'));
    expect(slop && insetBottom(slop.body)).toBeLessThan(-4);

    for (const button of ['.combat-run-btn', '.combat-dungeon-leave', '.combat-forecast']) {
      const trimmed = rules.find(r => r.selector.includes('.combat-quest-tracker:not([hidden])') && r.selector.includes(button) && r.selector.includes('::after'));
      expect(trimmed, button).toBeDefined();
      expect(px(trimmed!.body, 'bottom')).toBeGreaterThanOrEqual(-4);
    }
  });

  it('gives the 24px line hit-slop into the stage', () => {
    const slop = rules.find(r => r.selector === '.quest-tracker::before');
    expect(slop).toBeDefined();
    expect(insetBottom(slop!.body)).toBeLessThanOrEqual(-10);
  });
});

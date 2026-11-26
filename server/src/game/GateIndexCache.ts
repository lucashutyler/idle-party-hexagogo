import { collectGates, gateMinLevel, gateQuestIds } from '@idle-party-rpg/shared';
import type { GateRef } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

type GateContent = Pick<ContentStore, 'contentEpoch' | 'getWorld' | 'getAllTileTypes'>;

export interface GateIndex {
  /** Gates that name the quest among their required quests. */
  byQuest: ReadonlyMap<string, readonly GateRef[]>;
  /** Gates with a level requirement, lowest first. */
  byLevel: readonly { minLevel: number; gate: GateRef }[];
}

const indexes = new WeakMap<GateContent, { epoch: number; index: GateIndex }>();

/** Every room and door gate, looked up by the quest or level that opens it. Rebuilt once per content change. */
export function gateIndex(content: GateContent): GateIndex {
  const known = indexes.get(content);
  if (known && known.epoch === content.contentEpoch) return known.index;
  const index = buildGateIndex(collectGates(content.getWorld().tiles, content.getAllTileTypes()));
  indexes.set(content, { epoch: content.contentEpoch, index });
  return index;
}

/** Gates whose minimum level is above `fromLevel` and at most `toLevel`. */
export function gatesOpenedByLevel(index: GateIndex, fromLevel: number, toLevel: number): GateRef[] {
  const opened: GateRef[] = [];
  for (const { minLevel, gate } of index.byLevel) {
    if (minLevel > toLevel) break;
    if (minLevel > fromLevel) opened.push(gate);
  }
  return opened;
}

function buildGateIndex(gates: readonly GateRef[]): GateIndex {
  const byQuest = new Map<string, GateRef[]>();
  const byLevel: { minLevel: number; gate: GateRef }[] = [];
  for (const gate of gates) {
    for (const questId of gateQuestIds(gate)) {
      const list = byQuest.get(questId) ?? [];
      list.push(gate);
      byQuest.set(questId, list);
    }
    const minLevel = gateMinLevel(gate);
    if (minLevel !== undefined) byLevel.push({ minLevel, gate });
  }
  byLevel.sort((a, b) => a.minLevel - b.minLevel);
  return { byQuest, byLevel };
}

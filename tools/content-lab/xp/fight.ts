import type { Combatant } from '../engines.js';
import type { Rng } from '../engines.js';
import { LONG_FIGHT_CAP_REAL_MS, RESULT_DEFEAT, RESULT_STALEMATE, RESULT_TIMEOUT, RESULT_VICTORY } from './types.js';
import type { XpSnapshot, XpTable } from './types.js';

export interface FightOutcome {
  result: number;
  realMs: number;
  deaths: number;
  damage: number;
  minHp: number;
  pastHorizon: boolean;
  groups: number[];
}

export interface FightKit {
  mod: any;
  content: XpSnapshot;
  monsterIndex: Map<string, number>;
}

function withSeededMathRandom<T>(rng: Rng, run: () => T): T {
  const original = Math.random;
  Math.random = rng;
  try {
    return run();
  } finally {
    Math.random = original;
  }
}

function resultCode(state: any): number {
  if (!state.finished) return RESULT_TIMEOUT;
  if (state.result === 'victory') return RESULT_VICTORY;
  return state.players.some((p: any) => p.currentHp > 0) ? RESULT_STALEMATE : RESULT_DEFEAT;
}

function monsterGroups(state: any, monsterIndex: Map<string, number>): number[] {
  const byMonster = new Map<number, [number, number]>();
  for (const m of state.monsters) {
    const index = monsterIndex.get(m.id);
    if (index === undefined) throw new Error(`monster ${m.id} is missing from the atlas dictionary`);
    const tally = byMonster.get(index) ?? [0, 0];
    tally[m.currentHp > 0 ? 1 : 0]++;
    byMonster.set(index, tally);
  }
  const groups: number[] = [];
  for (const [index, [killed, standing]] of byMonster) groups.push(index, killed, standing);
  return groups;
}

function oneFight(kit: FightKit, players: Combatant[], table: XpTable, encounterId: string | null, rng: Rng): FightOutcome {
  const { mod, content } = kit;
  const { monsters, zones, encounters } = content;
  const entries = encounterId ? [{ encounterId, weight: 1 }] : [];
  const instances = mod.createEncounter(table.zoneId, monsters, zones, encounters, entries, rng);
  const state = mod.createPartyCombatState(players, instances, { pace: mod.COMBAT_PACE });
  const horizon = mod.defaultHorizonMs(state);
  const cap = Math.max(horizon, mod.paceEngineMs(mod.COMBAT_PACE, LONG_FIGHT_CAP_REAL_MS / 1000));
  const step = mod.COMBAT_STEP_MS;
  let damage = 0;
  let deaths = 0;
  let pastHorizon = false;
  while (!state.finished && state.elapsedMs < cap) {
    if (state.elapsedMs >= horizon) pastHorizon = true;
    const tick = mod.processCombatStep(state, step, rng);
    for (const event of tick.events) {
      if (event.kind === 'damage' && event.dst?.side === 'monster') damage += event.amount ?? 0;
      else if (event.kind === 'death' && event.dst?.side === 'player') deaths++;
    }
  }
  return {
    result: resultCode(state),
    realMs: mod.paceRealMs(mod.COMBAT_PACE, state.elapsedMs),
    deaths,
    damage,
    minHp: state.minPartyHpFrac,
    pastHorizon,
    groups: monsterGroups(state, kit.monsterIndex),
  };
}

export function runFight(kit: FightKit, players: Combatant[], table: XpTable, encounterId: string | null, rng: Rng): FightOutcome {
  return withSeededMathRandom(rng, () => oneFight(kit, players, table, encounterId, rng));
}

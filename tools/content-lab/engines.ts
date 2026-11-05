import { pathToFileURL } from 'node:url';
import type { ContentSnapshot, EncounterEntry, FightEnd, FightResult, HireSpec, PartyMemberSpec } from './types.js';

export type Rng = () => number;
export type Combatant = Record<string, any>;
export type MonsterInstance = Record<string, any>;

export interface HumanBuild extends PartyMemberSpec {
  level: number;
  equipment: Record<string, string | null>;
  skillIds: (string | null)[];
}

export interface FightInput {
  players: Combatant[];
  table: EncounterEntry[];
  zoneId?: string;
  content: ContentSnapshot;
  xpMultiplier: number;
  humanCount: number;
  hireCount: number;
  memberLevel: number;
  rng: Rng;
}

export interface EngineAdapter {
  name: 'old' | 'new';
  /** Dead time around each fight on this engine's battle timer, for rate metrics. */
  pauseMs: number;
  module: any;
  buildHuman(spec: HumanBuild, content: ContentSnapshot): Combatant;
  buildHire(hire: HireSpec, def: any, content: ContentSnapshot, displayName: string): Combatant;
  fight(input: FightInput): FightEnd;
}

/** The old timer waits one tick after the killing blow before its result pause. */
const OLD_KILL_DELAY_MS = 1000;
const OLD_TICK_MS = 1000;
/** Neither engine has a time limit of its own, so a slow fight that keeps progressing must not be cut short here. */
const FIGHT_HORIZON_MS = 2 * 60 * 60 * 1000;
export const OLD_HORIZON_TICKS = FIGHT_HORIZON_MS / OLD_TICK_MS;
/** The old engine has no stalemate rule; this only saves simulating a fight that would run forever. */
const OLD_NO_PROGRESS_TICKS = 600;

/** Mirrors PlayerSession.getCombatInfo on both versions (identical apart from per-battle fields). */
function buildHumanCommon(mod: any, spec: HumanBuild, content: ContentSnapshot): Combatant {
  const baseMaxHp = mod.calculateMaxHp(spec.level, spec.className);
  const baseDamage = mod.calculateBaseDamage(spec.level, spec.className);
  const rawEquip = mod.computeEquipmentBonuses(spec.equipment, content.items, spec.level);
  const setResult = mod.computeActiveSetBonuses(spec.equipment, content.sets, spec.className);
  const equipBonuses = mod.mergeSetBonusesIntoEquip(rawEquip, setResult.bonuses);
  const flatHp = setResult.bonuses.flatHp ?? 0;
  const percentHp = setResult.bonuses.percentHp ?? 0;
  const maxHp = Math.max(1, Math.floor((baseMaxHp + flatHp) * (1 + percentHp / 100)));
  return {
    username: spec.username,
    maxHp,
    baseDamage,
    playerDamageType: mod.CLASS_DEFINITIONS[spec.className].damageType,
    equipBonuses,
    setBonuses: setResult.bonuses,
    gridPosition: spec.gridPosition,
    className: spec.className,
    level: spec.level,
    equippedSkills: spec.skillIds.map(id => (id ? content.skills[id] ?? null : null)),
  };
}

function monsterHpTotal(state: any): number {
  return state.monsters.reduce((sum: number, m: MonsterInstance) => sum + Math.max(0, m.currentHp), 0);
}

function buildHireCommon(mod: any, hire: HireSpec, def: any, content: ContentSnapshot, displayName: string): Combatant {
  const hired = { instanceId: displayName, henchmanId: hire.henchmanId, gridPosition: hire.gridPosition, mapId: '' };
  return mod.buildHenchmanCombatant(def, hired, (id: string) => content.skills[id], displayName);
}

function rollGold(monsters: MonsterInstance[], content: ContentSnapshot, rng: Rng): number {
  let total = 0;
  for (const m of monsters) {
    const def = content.monsters[m.id];
    if (def) total += def.goldMin + Math.floor(rng() * (def.goldMax - def.goldMin + 1));
  }
  return total;
}

function partyHpLost(players: Combatant[]): { hpLostFrac: number; dead: number } {
  let hp = 0;
  let max = 0;
  let dead = 0;
  for (const p of players) {
    hp += Math.max(0, p.currentHp);
    max += p.maxHp;
    if (p.currentHp <= 0) dead++;
  }
  return { hpLostFrac: max > 0 ? 1 - hp / max : 0, dead };
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

/** The reward split of PartyBattleManager on both versions; standing walls pay too. */
function settle(result: FightResult, ms: number, state: any, input: FightInput, baseXp: number): FightEnd {
  const shares = input.humanCount + input.hireCount;
  const won = result === 'victory';
  return {
    result,
    ms,
    ...partyHpLost(state.players),
    xpPerMember: won ? Math.ceil((baseXp * input.xpMultiplier) / shares) : 0,
    goldPerMember: won ? Math.ceil(rollGold(state.monsters, input.content, input.rng) / shares) : 0,
  };
}

export async function loadNewEngine(): Promise<EngineAdapter> {
  const mod: any = await import('../../shared/src/index.js');
  return {
    name: 'new',
    pauseMs: mod.KILL_BEAT_MS + mod.RESULT_PAUSE + mod.MOVE_DURATION,
    module: mod,
    buildHuman: (spec, content) => buildHumanCommon(mod, spec, content),
    buildHire: (hire, def, content, displayName) => buildHireCommon(mod, hire, def, content, displayName),
    fight(input) {
      return withSeededMathRandom(input.rng, () => {
        const { monsters, zones, encounters } = input.content;
        const instances = mod.createEncounter(input.zoneId, monsters, zones, encounters, input.table, input.rng);
        const state = mod.createPartyCombatState(input.players, instances);
        const outcome = mod.simulateToEnd(state, input.rng, Math.max(FIGHT_HORIZON_MS, mod.defaultHorizonMs(state)));
        const result: FightResult = outcome.result === 'victory' ? 'victory' : outcome.result === 'defeat' ? 'defeat' : 'stalemate';
        let baseXp = 0;
        for (const m of state.monsters) {
          if (!Number.isFinite(m.xp)) continue;
          const authored = m.levelSource === 'authored' && Number.isFinite(m.level);
          baseXp += authored ? m.xp * mod.xpConFactor(m.level, 'authored', input.memberLevel) : m.xp;
        }
        return settle(result, outcome.elapsedMs, state, input, baseXp);
      });
    },
  };
}

export async function loadOldEngine(bundlePath: string): Promise<EngineAdapter> {
  const mod: any = await import(pathToFileURL(bundlePath).href);
  return {
    name: 'old',
    pauseMs: OLD_KILL_DELAY_MS + mod.RESULT_PAUSE + mod.MOVE_DURATION,
    module: mod,
    buildHuman: (spec, content) => {
      const info = buildHumanCommon(mod, spec, content);
      return {
        ...info,
        currentHp: info.maxHp,
        attackCount: 0,
        stunTurns: 0,
        dots: [],
        hots: [],
        damageShield: 0,
        debuffs: [],
        consecutiveHits: 0,
        lastTargetId: '',
        hasResurrected: false,
        martyrBonus: 0,
        braceActive: false,
        braceDamageTaken: 0,
        interceptActive: false,
        activeSkillCount: 0,
      };
    },
    buildHire: (hire, def, content, displayName) => buildHireCommon(mod, hire, def, content, displayName),
    fight(input) {
      return withSeededMathRandom(input.rng, () => {
        const { monsters, zones, encounters } = input.content;
        const instances = mod.createEncounter(input.zoneId, monsters, zones, encounters, input.table);
        const state = mod.createPartyCombatState(input.players, instances);
        let lowWater = monsterHpTotal(state);
        let lastProgressTick = 0;
        while (!state.finished && state.tickCount < OLD_HORIZON_TICKS && state.tickCount - lastProgressTick < OLD_NO_PROGRESS_TICKS) {
          mod.processPartyTick(state);
          const hp = monsterHpTotal(state);
          if (hp < lowWater) {
            lowWater = hp;
            lastProgressTick = state.tickCount;
          }
        }
        const result: FightResult = !state.finished ? 'stalemate' : state.result === 'victory' ? 'victory' : 'defeat';
        const baseXp = state.monsters.reduce((sum: number, m: MonsterInstance) => sum + m.xp, 0);
        return settle(result, state.tickCount * OLD_TICK_MS, state, input, baseXp);
      });
    },
  };
}

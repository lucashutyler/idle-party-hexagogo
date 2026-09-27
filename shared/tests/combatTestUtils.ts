import { vi } from 'vitest';
import { processCombatStep } from '../src/systems/CombatEngine';
import type { PartyCombatantInit, PartyCombatState, PartyCombatant, CombatMonster } from '../src/systems/CombatEngine';
import type { CombatEvent, CombatEventKind } from '../src/systems/CombatEvents';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import type { MonsterDefinition, MonsterInstance } from '../src/systems/MonsterTypes';
import type { ClassName, DamageType } from '../src/systems/CharacterStats';
import { CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';

export interface PlayerOptions {
  hp?: number;
  className?: ClassName;
  level?: number;
  baseDamage?: number;
  damageType?: DamageType;
  skills?: (SkillDefinition | null)[];
  isHenchman?: boolean;
  equipBonuses?: PartyCombatantInit['equipBonuses'];
  setBonuses?: PartyCombatantInit['setBonuses'];
}

export function makePlayer(username: string, pos: PartyGridPosition, opts: PlayerOptions = {}): PartyCombatantInit {
  const className = opts.className ?? 'Archer';
  const player: PartyCombatantInit = {
    username,
    maxHp: opts.hp ?? 1000,
    baseDamage: opts.baseDamage ?? 10,
    playerDamageType: opts.damageType ?? CLASS_DEFINITIONS[className].damageType,
    gridPosition: pos,
    className,
    level: opts.level ?? 1,
    equippedSkills: opts.skills ?? [null, null, null, null, null],
  };
  if (opts.isHenchman) player.isHenchman = true;
  if (opts.equipBonuses) player.equipBonuses = opts.equipBonuses;
  if (opts.setBonuses) player.setBonuses = opts.setBonuses;
  return player;
}

export function monsterDef(overrides: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return {
    id: 'dummy',
    name: 'Dummy',
    hp: 10000,
    damage: 0,
    damageType: 'physical',
    xp: 0,
    goldMin: 0,
    goldMax: 0,
    ...overrides,
  };
}

export function makeMonster(pos: PartyGridPosition, overrides: Partial<MonsterDefinition> = {}): MonsterInstance {
  return createMonsterInstance(monsterDef(overrides), pos);
}

export function activeSkill(overrides: Partial<SkillDefinition> & Pick<SkillDefinition, 'id'>): SkillDefinition {
  return {
    name: overrides.id,
    description: 'test',
    className: 'Knight',
    type: 'active',
    unlockLevel: 1,
    sortOrder: 1,
    cooldown: 1,
    activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }],
    ...overrides,
  };
}

export function passiveSkill(overrides: Partial<SkillDefinition> & Pick<SkillDefinition, 'id'>): SkillDefinition {
  return {
    name: overrides.id,
    description: 'test',
    className: 'Knight',
    type: 'passive',
    unlockLevel: 1,
    sortOrder: 0,
    ...overrides,
  };
}

export interface RunLog {
  events: CombatEvent[];
  log: string[];
}

/** Step until `elapsedMs >= t` (or the fight ends). */
export function runTo(state: PartyCombatState, t: number, into: RunLog = { events: [], log: [] }): RunLog {
  while (!state.finished && state.elapsedMs < t) {
    const r = processCombatStep(state);
    into.events.push(...r.events);
    into.log.push(...r.logEntries);
  }
  return into;
}

/** Step until an event matches (inclusive of the matching step) or `maxMs` of combat time passes. */
export function runUntilEvent(
  state: PartyCombatState,
  pred: (e: CombatEvent) => boolean,
  maxMs = 60000,
  into: RunLog = { events: [], log: [] },
): RunLog & { hit?: CombatEvent } {
  const limit = state.elapsedMs + maxMs;
  while (!state.finished && state.elapsedMs < limit) {
    const r = processCombatStep(state);
    into.events.push(...r.events);
    into.log.push(...r.logEntries);
    const hit = r.events.find(pred);
    if (hit) return { ...into, hit };
  }
  return into;
}

export function ofKind(events: CombatEvent[], kind: CombatEventKind): CombatEvent[] {
  return events.filter(e => e.kind === kind);
}

export function player(state: PartyCombatState, username: string): PartyCombatant {
  const p = state.players.find(x => x.username === username);
  if (!p) throw new Error(`no player ${username}`);
  return p;
}

export function monsterAt(state: PartyCombatState, pos: PartyGridPosition): CombatMonster {
  const m = state.monsters.find(x => x.gridPosition === pos);
  if (!m) throw new Error(`no monster at ${pos}`);
  return m;
}

/** Pin Math.random; 0.4 gives zero damage variance (floor(0.4 × 5) − 2 = 0). */
export function pinRandom(value = 0.4): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

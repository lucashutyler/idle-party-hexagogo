import type { DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { SkillCardType, SkillTrigger } from './SkillTypes.js';

export type CombatSide = 'player' | 'monster';

export interface CombatRef {
  side: CombatSide;
  pos: PartyGridPosition;
}

export type CombatEventKind =
  | 'battle_start' | 'battle_end'
  | 'attack'
  | 'damage'
  | 'heal'
  | 'dodge' | 'absorb' | 'shield'
  | 'stun' | 'resist'
  | 'cast_start' | 'cast_end' | 'interrupt'
  | 'reaction'
  | 'redirect'
  | 'status'
  | 'cleanse' | 'death' | 'revive' | 'buff' | 'fizzle';

/** One timestamped combat happening. See docs/architecture/combat.md for per-kind fields. */
export interface CombatEvent {
  id: number;
  t: number;
  kind: CombatEventKind;
  src?: CombatRef;
  dst?: CombatRef;
  amount?: number;
  dmgType?: DamageType;
  crit?: boolean;
  overTime?: boolean;
  skill?: string;
  skillId?: string;
  cardType?: SkillCardType;
  durationMs?: number;
  name?: string;
  result?: 'victory' | 'defeat';
}

export interface ClientCombatStatus {
  kind: 'dot' | 'hot' | 'debuff' | 'buff' | 'mark' | 'chaos' | 'scorch';
  name: string;
  stacks?: number;
  remainingMs?: number;
}

export interface ClientCombatSkill {
  id: string;
  remainingMs: number;
  cooldownMs: number;
  state: 'cooldown' | 'ready' | 'held' | 'armed' | 'casting';
  name?: string;
  cardType?: SkillCardType;
  trigger?: SkillTrigger;
  castTimeMs?: number;
}

export interface ClientCombatCast {
  skill: string;
  skillId: string;
  totalMs: number;
  remainingMs: number;
  target?: CombatRef;
  paused?: boolean;
}

export interface ClientCombatUnit {
  side: CombatSide;
  pos: PartyGridPosition;
  hp: number;
  maxHp?: number;
  shield?: number;
  stunMs?: number;
  stunTotalMs?: number;
  /** Milliseconds remaining until the next action. */
  actionMs: number;
  /** Length of the current wait. */
  actionTotalMs: number;
  /** Static: the unit's normal action interval (full snapshots only). */
  actionIntervalMs?: number;
  cast?: ClientCombatCast;
  statuses?: ClientCombatStatus[];
  /** Real players only (not henchmen): equipped actives in slot order. */
  skills?: ClientCombatSkill[];
  name?: string;
  /** Monsters only: definition id (artwork key). */
  id?: string;
  /** Real players only. */
  className?: string;
  henchman?: boolean;
  passive?: boolean;
  description?: string;
  /** Real players only: equipped passive skill ids this battle was built with. */
  passives?: string[];
}

/** Static unit fields (name, id, className, …, skill names/types) are present only when `full`. */
export interface ClientCombatSnapshot {
  battleId: number;
  elapsedMs: number;
  full: boolean;
  finished: boolean;
  result: 'victory' | 'defeat' | null;
  units: ClientCombatUnit[];
}

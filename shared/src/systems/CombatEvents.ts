import type { DamageType } from './CharacterStats.js';
import type { MonsterLevelSource, MonsterTier } from './MonsterTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { SkillCardType, SkillTrigger } from './SkillTypes.js';

export type CombatSide = 'player' | 'monster';

/** How a fight ended; the engine only produces victory/defeat, the server timer can end one as a retreat. */
export type CombatResult = 'victory' | 'defeat' | 'retreat';

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
  | 'cleanse' | 'death' | 'revive' | 'buff' | 'fizzle'
  | 'phase' | 'enrage';

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
  /** interrupt only: an instant countered the spell, rather than a stun cancelling it. */
  countered?: boolean;
  durationMs?: number;
  /** The real wait until this unit's next action, as it stands: on a player's actions with an Attack skill, and on cast_start with a pace whose casts add time. */
  nextActionMs?: number;
  /** A use of a skill with charge and recovery on its owner's turn: the real recovery it starts now. On a cast, its cast_end carries this. A reaction never does. */
  recoveryMs?: number;
  name?: string;
  result?: CombatResult;
}

export interface ClientCombatStatus {
  kind: 'dot' | 'hot' | 'debuff' | 'buff' | 'mark' | 'chaos' | 'scorch' | 'enrage';
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
  /** The cooldown a use starts, before and after cooldown reduction. Full snapshots only. */
  baseCooldownMs?: number;
  useCooldownMs?: number;
  /** Real times of a skill with charge and recovery. Full snapshots only. */
  chargeMs?: number;
  recoveryMs?: number;
}

export interface ClientCombatCast {
  skill: string;
  skillId: string;
  totalMs: number;
  remainingMs: number;
  target?: CombatRef;
  paused?: boolean;
}

/** A monster's enrage clock in battle time: first stack at `atMs`, one more every `stepMs`. */
export interface ClientCombatEnrage {
  atMs: number;
  stacks: number;
  stepMs: number;
  stepPercent: number;
  maxStacks: number;
}

/** Boss checkpoint progress. `thresholds` (descending HP fractions) is static: full snapshots only. */
export interface ClientCombatBossPhases {
  bossPos: PartyGridPosition[];
  thresholds?: number[];
  phase: number;
  resumedFromPhase?: number;
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
  /** While recovering: nothing can be used, reactions included. `actionMs` runs alongside it for the ring. */
  recoveryMs?: number;
  recoveryTotalMs?: number;
  /** Real players only (not henchmen): equipped actives in slot order, then the attack skill if any. */
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
  level?: number;
  /** Monsters only. */
  levelSource?: MonsterLevelSource;
  /** Monsters only. */
  tier?: MonsterTier;
  /** Monsters with an enrage clock; present in every snapshot. */
  enrage?: ClientCombatEnrage;
}

/** Static unit fields (name, id, className, …, skill names/types) are present only when `full`. */
export interface ClientCombatSnapshot {
  battleId: number;
  elapsedMs: number;
  full: boolean;
  finished: boolean;
  result: CombatResult | null;
  units: ClientCombatUnit[];
  /** Present when the fight has a boss; `phase` is in every snapshot. */
  bossPhases?: ClientCombatBossPhases;
}

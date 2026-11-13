import type { ClassName, ContentSnapshot, EncounterEntry } from '../types.js';

export interface XpSnapshot extends ContentSnapshot {
  quests?: Record<string, any>;
  npcs?: Record<string, any>;
  tileTypes?: Record<string, any>;
}

export const XP_GRID_LEVELS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 23, 26, 30, 35, 40, 45, 50, 55, 60];
export const DEFAULT_FIGHTS_PER_CELL = 24;
export const MIN_FIGHTS_PER_STRATUM = 3;
/** Real time a simulated fight may run. The game has no limit: this only bounds the simulation. */
export const LONG_FIGHT_CAP_REAL_MS = 4 * 3_600_000;
export const WIN_OK_PCT = 90;
export const ON_LEVEL_BAND = 3;

export type CompFamily = 'core' | 'extended' | 'carry' | 'stall' | 'seating' | 'hired';
export type MemberRole = 'member' | 'carrier' | 'friend';
/** `fill`: the party takes this many of the strongest hires the map offers, which any player can do for free at any level. */
export type HirePolicy = 'none' | 'usual' | { className: ClassName } | { fill: number };

export interface CompMember {
  className: ClassName;
  levelOffset: number;
  role: MemberRole;
}

export interface XpComp {
  id: string;
  family: CompFamily;
  members: CompMember[];
  hires: HirePolicy;
  gear: 'level' | 'ungeared';
  skills: 'default' | 'attackOnly';
  /** These two classes trade seats after the normal seating: a deliberately worse formation. */
  swapSeats?: [ClassName, ClassName];
  /** 'default': seats as the game hands them out when nobody moves anyone (leader centre, then first free). */
  seating?: 'placed' | 'default';
  /** Every member who can equips an xp_bonus passive in their last passive slot. */
  xpBonus?: boolean;
  /** The composition this variant is compared against: the same party played normally, or a mixed party of its size. */
  reference?: string;
  /** Party level minus room level, inclusive. */
  band: [number, number];
}

export interface Stratum {
  /** Null: the engine's fallback pack, for an empty table. */
  encounterId: string | null;
  share: number;
  /** Non-passive boss or raid tier monster in this entry. */
  boss: boolean;
}

export interface XpTable {
  index: number;
  key: string;
  kind: 'room' | 'floor';
  label: string;
  zoneId: string;
  zoneName: string;
  regionId: string;
  regionName: string;
  regionIndex: number;
  zoneLevelRange: [number, number];
  roomLevel: number;
  roomLevelSource: 'authored' | 'zone';
  entries: EncounterEntry[];
  strata: Stratum[];
  tileCount: number;
  npcTiles: number;
  shopTiles: number;
  dungeonTiles: number;
  tileTypes: Record<string, number>;
  zeroXp: boolean;
  /** A room of a starter zone. Never a dungeon floor, wherever its entrance stands. */
  starterZone: boolean;
  boss: boolean;
  bossShare: number;
  override: boolean;
  fallback: boolean;
  /** Lowest member level that can stand here, by room, transition and quest gates. Null: nobody can. Absent: not computed. */
  reachLevel?: number | null;
  /** Paying rooms bordering a zero-XP room, which auto-retreat can pick as its target. */
  zeroNeighbourTiles?: number;
  dungeonId?: string;
  dungeonName?: string;
  floorIndex?: number;
  floorCount?: number;
  /** The floor's own `xpFactor` and `coinFactor`, as written; the rules read an absent or invalid one as 1. */
  floorXpFactor?: number;
  floorCoinFactor?: number;
  entryRequirements?: Record<string, unknown>;
}

export interface XpCell {
  id: number;
  table: number;
  comp: number;
  level: number;
  hires: string[];
  xpMult: number;
  ineligible?: string;
}

export interface FightRow {
  cell: number;
  encounter: number;
  result: number;
  deaths: number;
  realMs: number;
  damage: number;
  minHp: number;
  /** Still going at defaultHorizonMs, so the real forecast scores it as not won whatever `result` says. */
  pastHorizon: boolean;
  /** Flat triples: monster index, killed, standing. Reused between rows by the reader. */
  groups: number[];
}

export const RESULT_NAMES = ['victory', 'defeat', 'stalemate', 'timeout'] as const;
export type ResultName = typeof RESULT_NAMES[number];
export const RESULT_VICTORY = 0;
export const RESULT_DEFEAT = 1;
export const RESULT_STALEMATE = 2;
export const RESULT_TIMEOUT = 3;
export const FALLBACK_ENCOUNTER = 0xffff;

export const ATLAS_VERSION = 3;

export interface AtlasMeta {
  version: typeof ATLAS_VERSION;
  createdAt: string;
  snapshotSha1: string;
  engineRef: string;
  seed: number;
  fightsPerCell: number;
  families: CompFamily[];
  grid: readonly number[];
  limitTables?: number;
  pauseMs: number;
  retreatMs: number;
  autoRetreatBelowPct: number;
  rewardMultiplier: number;
  clock: number;
  longFightCapMs: number;
  monsters: string[];
  encounters: string[];
  tables: XpTable[];
  comps: XpComp[];
  log: string[];
  cellCount: number;
  eligibleCellCount: number;
  expectedFights: number;
  run?: AtlasRunInfo;
  refine?: RefineInfo;
}

/** The near-line pass: cells whose first sample reads near the win line, sampled again from scratch. */
export interface RefineInfo {
  fights: number;
  /** Win %, low inclusive, high exclusive. */
  band: [number, number];
  cells: number[];
  simulatedFights: number;
  wallSeconds: number;
}

export interface AtlasRunInfo {
  jobs: number;
  wallSeconds: number;
  fights: number;
  rowBytes: number;
  byFamily: Record<string, { cells: number; fights: number; cpuMs: number }>;
  timeouts: number;
}

/** What a cell read in the atlas before a fresh sample replaced it. */
export interface FirstSample {
  n: number;
  win: number;
  ms: number;
  kph: number;
  xp: number[];
}

export interface CellRate {
  /** Cell id. evaluate.ts sorts on this being the first key. */
  c: number;
  /** Fights simulated. */
  n: number;
  /** Share-weighted percentages. `to`: still going at the long-fight cap. */
  win: number;
  loss: number;
  stale: number;
  to: number;
  /** Percent of fights past the forecast horizon. */
  hz: number;
  /** Win % as the forecast sees it: a win past the horizon doesn't count. What `skip` and `reloc` read. */
  fwin: number;
  /** Mean real ms per fight, without the pause. */
  ms: number;
  /** Mean real ms per won fight. */
  winMs: number | null;
  hp: number;
  deaths: number;
  /** Non-passive monsters killed per fight. */
  kills: number;
  /** Party damage per fight. */
  dmg: number;
  /** Kills per hour with the pause included. */
  kph: number;
  /** Share of fights the default auto-retreat skips. */
  skip: number;
  /** The whole room is below the auto-retreat line. */
  reloc: number;
  /** XP/hr per human member with the default auto-retreat. */
  xp: number[];
  /** XP/hr per human member with every fight fought out. */
  raw: number[];
  /** Mean XP per fight per human member. */
  xpf: number[];
  /** Per entry: encounter index, share, fights, win %, mean ms. */
  st: [number, number, number, number, number][];
  /** Boss rooms only: the boss entries and the rest of the table, for a plan's bossPolicy. */
  bs?: BossSplit;
  /** Present when these figures come from a fresh sample. */
  first?: FirstSample;
  /** What the cell pays in gold. On disk it lives in gold.jsonl, so rates.jsonl only ever moves with the XP figures. Absent: a run from before gold was read. */
  g?: CellGold;
}

/** A pure function of a cell's fight rows and the plan's content. Coin is the same for every human in a party; drops aren't, since class-locked items go by class. */
export interface CellGold {
  /** Mean coin per fight per human: a won fight's coin as payVictory splits it, after a floor's coin factor. */
  cf: number;
  /** Coin/hr per human with the default auto-retreat, read as `xp` is. */
  ch: number;
  /** Coin/hr per human with every fight fought out, read as `raw` is. */
  cr: number;
  /** Mean sale value per fight of the monster drops reaching each human. */
  df: number[];
  /** The same per hour, read as `ch` is. */
  dh: number[];
  /** Boss rooms only: mean coin per boss fight, and per fight of the rest of the table. */
  bs?: { coin: number; rest: number };
  /** A plan that retuned content only: the same fights as the atlas's own content pays them, so a plan can't move a line it is judged against. */
  atlas?: Pick<CellGold, 'ch' | 'df' | 'bs'>;
}

export interface BossSplit {
  /** Share of fights that roll a boss entry. */
  share: number;
  /** Mean real ms per boss fight, without the pause. */
  ms: number;
  /** Win share, 0 to 1, of boss fights. */
  win: number;
  /** Mean XP per boss fight per human member. */
  xpf: number[];
  restMs: number;
  restXpf: number[];
}

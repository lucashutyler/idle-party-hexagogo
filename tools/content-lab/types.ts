export type ClassName = 'Knight' | 'Archer' | 'Priest' | 'Mage' | 'Bard';
export const CLASS_NAMES: readonly ClassName[] = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

export interface EncounterEntry {
  encounterId: string;
  weight: number;
}

export interface ContentSnapshot {
  monsters: Record<string, any>;
  items: Record<string, any>;
  zones: Record<string, { id: string; displayName: string; levelRange: [number, number]; encounterTable?: EncounterEntry[] }>;
  encounters: Record<string, any>;
  sets: Record<string, any>;
  shops: Record<string, { id: string; name: string; inventory?: { itemId: string; price: number }[]; henchmanIds?: string[] }>;
  henchmen: Record<string, any>;
  dungeons: Record<string, any>;
  skills: Record<string, any>;
  skillSlotSchedules: Record<string, { type: 'passive' | 'active'; unlocksAtLevel: number }[]>;
  world: {
    defaultMapId: string;
    maps: { id: string; name: string }[];
    tiles: { id: string; mapId: string; zone: string; name?: string; encounterTable?: EncounterEntry[]; shopId?: string; dungeonId?: string }[];
  };
}

export type GearVariant = 'shop' | 'ungeared';
export type LevelVariant = 'mid' | 'low' | 'high';
export type FightResult = 'victory' | 'defeat' | 'stalemate';
export type CellKind = 'zone' | 'room' | 'floor';

export interface PartyMemberSpec {
  className: ClassName;
  gridPosition: number;
  username: string;
}

export interface HireSpec {
  henchmanId: string;
  gridPosition: number;
}

export interface CompositionSpec {
  id: string;
  humans: ClassName[];
  /** Solo-plus-hires compositions; dungeons leave hires at the entrance, so they are ineligible there. */
  hires: boolean;
  /** Fixed seats instead of the class seat preferences. */
  seats?: number[];
}

export interface Cell {
  id: string;
  kind: CellKind;
  regionId: string;
  regionName: string;
  regionIndex: number;
  zoneId: string;
  zoneName: string;
  level: number;
  levelVariant: LevelVariant;
  gear: GearVariant;
  comp: string;
  table: EncounterEntry[];
  sims: number;
  /** Rooms sharing this override table. */
  tileIds?: string[];
  dungeonId?: string;
  dungeonName?: string;
  floorIndex?: number;
  floorCount?: number;
  isBoss?: boolean;
  /** Every monster in the table pays no XP (safe-town filler); left out of region means. */
  noReward?: boolean;
  /** Set when the party cannot lawfully fight here; the cell is reported, not simulated. */
  ineligible?: string;
}

export interface FightEnd {
  result: FightResult;
  ms: number;
  hpLostFrac: number;
  dead: number;
  xpPerMember: number;
  goldPerMember: number;
}

export interface StratumResult {
  encounterId: string;
  sharePct: number;
  sims: number;
  winPct: number;
  medianSec: number | null;
}

export interface CellMetrics {
  sims: number;
  winPct: number;
  lossPct: number;
  stalematePct: number;
  medianSec: number | null;
  p90Sec: number | null;
  /** Winning fights only. */
  hpLostPct: number | null;
  /** Mean party members down at the end of a fight, all fights. */
  deaths: number;
  xpPerHour: number;
  goldPerHour: number;
}

export interface CellResult extends Omit<Cell, 'table' | 'sims'>, Partial<CellMetrics> {
  strata?: StratumResult[];
  hires?: string[];
}

export interface DungeonForecast {
  sims: number;
  winPct: number;
  medianMs: number | null;
  floors: { floor: number; winPct: number; medianMs?: number | null }[];
}

export interface DungeonRunResult {
  dungeonId: string;
  dungeonName: string;
  regionId: string;
  regionName: string;
  regionIndex: number;
  level: number;
  comp: string;
  ineligible?: string;
  runs?: number;
  clearPct?: number;
  medianRunSec?: number | null;
  xpPerHour?: number;
  goldPerHour?: number;
  meanDeaths?: number;
  /** New engine only: runForecast. */
  forecast?: DungeonForecast;
}

export interface BaselineMeta {
  engine: string;
  engineRef: string;
  snapshotSha1: string;
  n: number;
  variantN: number;
  seed: number;
  pauseMs: number;
  policies: Record<string, unknown>;
  gear: Record<string, unknown>;
  loadouts: Record<string, unknown>;
  log: string[];
  elapsedSec: number;
}

export interface Baseline {
  meta: BaselineMeta;
  cells: CellResult[];
  dungeons: DungeonRunResult[];
}

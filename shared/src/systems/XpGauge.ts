import { MOVE_DURATION, RESULT_PAUSE, WIPE_WAIT_MS } from './BattleTypes.js';
import { KILL_BEAT_MS, RUN_AVAILABLE_MS } from './CombatTiming.js';
import { createRng } from './combat/CombatRng.js';
import { createEncounter } from './EncounterTypes.js';
import type { EncounterDefinition } from './EncounterTypes.js';
import { seedFromKey, tableShares } from './Forecast.js';
import type { MonsterDefinition, MonsterInstance } from './MonsterTypes.js';
import { fightXp, packRawXp } from './XpRules.js';
import type { FightXpInput, XpMonster } from './XpRules.js';
import type { EncounterTableEntry } from './ZoneTypes.js';

/** The room forecast counts as this many fights when blended with the fights seen. */
export const GAUGE_FORECAST_FIGHTS = 5;
const GAUGE_STEADY_FIGHTS = 10;
/** Fights before a room won less often than GAUGE_STEADY_WIN_CHANCE reads steady. */
const GAUGE_STEADY_FIGHTS_HARD = 100;
const GAUGE_STEADY_WIN_CHANCE = 0.9;
export const GAUGE_LOSING_WIN_CHANCE = 0.5;
export const GAUGE_LONG_FIGHT_FACTOR = 3;
/** A random entry with more pool rolls than this is sampled instead of listed. */
export const GAUGE_MAX_PACK_ROLLS = 256;

export interface GaugeTiming {
  winPauseMs: number;
  lossPauseMs: number;
  /** A pack auto-retreat skips, from the fight's start to the next one. */
  skipMs: number;
}

/** The battle loop's own gaps, as `ServerBattleTimer` and the wipe wait run them. */
export const GAUGE_TIMING: Readonly<GaugeTiming> = {
  winPauseMs: KILL_BEAT_MS + RESULT_PAUSE + MOVE_DURATION,
  lossPauseMs: KILL_BEAT_MS + WIPE_WAIT_MS,
  skipMs: RUN_AVAILABLE_MS + RESULT_PAUSE + MOVE_DURATION,
};

/** Only what the pay rule reads, so a cached room stays small. */
export type GaugeMonster = XpMonster & Pick<MonsterInstance, 'id'>;

export interface GaugePack {
  monsters: GaugeMonster[];
  chance: number;
}

export interface GaugeStratum {
  entryId: string;
  share: number;
  packs: GaugePack[];
}

export type GaugePayInput = Omit<FightXpInput, 'monsters'>;

/** A room's table split as the room forecast splits it, with every pack each entry can roll. */
export function gaugeStrata(
  table: readonly EncounterTableEntry[],
  monsters: Record<string, MonsterDefinition>,
  encounters: Record<string, EncounterDefinition>,
): GaugeStratum[] {
  return tableShares(table).map(({ entryId, share, table: one }) => ({ entryId, share, packs: entryPacks(one, monsters, encounters) }));
}

/** One member's mean pay for winning this entry, through the pay rule itself. */
export function meanWinPay(stratum: GaugeStratum, input: GaugePayInput): number {
  let xp = 0;
  for (const pack of stratum.packs) xp += pack.chance * fightXp({ ...input, monsters: pack.monsters });
  return xp;
}

export function meanPackXp(stratum: GaugeStratum): number {
  let xp = 0;
  for (const pack of stratum.packs) xp += pack.chance * packRawXp(pack.monsters);
  return xp;
}

/** Whether any pack a table can roll pays anyone XP, remembering each entry across the tables it checks. */
export function createPaysXpCheck(
  monsters: Record<string, MonsterDefinition>,
  encounters: Record<string, EncounterDefinition>,
): (table: readonly EncounterTableEntry[]) => boolean {
  const byEntry = new Map<string, boolean>();
  return table => tableShares(table).some(({ entryId, table: one }) => {
    let pays = byEntry.get(entryId);
    if (pays === undefined) {
      pays = entryPacks(one, monsters, encounters).some(pack => packRawXp(pack.monsters) > 0);
      byEntry.set(entryId, pays);
    }
    return pays;
  });
}

/** Every pack `createEncounter` can roll from a one-entry table, by replaying its pool rolls. */
function entryPacks(
  table: EncounterTableEntry[],
  monsters: Record<string, MonsterDefinition>,
  encounters: Record<string, EncounterDefinition>,
): GaugePack[] {
  const roll = (rng: () => number) => createEncounter(undefined, monsters, {}, encounters, table, rng);
  const encounter = table.length > 0 ? encounters[table[0].encounterId] : undefined;
  // resolveRandom draws once per pool entry whose monster exists, in pool order, after the table pick.
  const pool = encounter && encounter.type !== 'explicit' ? (encounter.monsterPool ?? []).filter(p => monsters[p.monsterId]) : [];
  const spans = pool.map(p => {
    const span = Math.floor(p.max - p.min + 1);
    return Number.isFinite(span) && span >= 1 ? span : 1;
  });
  const rolls = spans.reduce((n, span) => n * span, 1);
  const packs = new Map<string, GaugePack>();
  const add = (rolled: MonsterInstance[], chance: number): void => {
    const key = rolled.map(m => m.id).sort().join('|');
    const known = packs.get(key);
    if (known) known.chance += chance;
    else packs.set(key, { monsters: rolled.map(xpOnly), chance });
  };
  if (rolls > GAUGE_MAX_PACK_ROLLS) {
    const rng = createRng(seedFromKey(table[0].encounterId));
    for (let i = 0; i < GAUGE_MAX_PACK_ROLLS; i++) add(roll(rng), 1 / GAUGE_MAX_PACK_ROLLS);
  } else {
    for (let index = 0; index < rolls; index++) {
      let rest = index;
      const draws = spans.map(span => {
        const pick = rest % span;
        rest = Math.floor(rest / span);
        return (pick + 0.5) / span;
      });
      add(roll(scriptedRng([0, ...draws])), 1 / rolls);
    }
  }
  return [...packs.values()];
}

function xpOnly({ id, xp, level, levelSource, maxHp, damage, passive, skills }: MonsterInstance): GaugeMonster {
  return { id, xp, level, levelSource, maxHp, damage, passive, skills };
}

function scriptedRng(draws: readonly number[]): () => number {
  let next = 0;
  return () => (next < draws.length ? draws[next++] : 0);
}

interface EntryTally {
  fights: number;
  wins: number;
  ms: number;
  winPackXp: number;
}

/** The fights one party has seen in one room. */
export class RoomTally {
  fights = 0;
  wins = 0;
  ms = 0;
  private readonly byEntry = new Map<string, EntryTally>();

  record(entryId: string, won: boolean, realMs: number, packXp: number): void {
    const ms = Number.isFinite(realMs) && realMs > 0 ? realMs : 0;
    const tally = this.byEntry.get(entryId) ?? { fights: 0, wins: 0, ms: 0, winPackXp: 0 };
    tally.fights++;
    tally.ms += ms;
    this.fights++;
    this.ms += ms;
    if (won) {
      tally.wins++;
      tally.winPackXp += packXp;
      this.wins++;
    }
    this.byEntry.set(entryId, tally);
  }

  entry(entryId: string): Readonly<EntryTally> | undefined {
    return this.byEntry.get(entryId);
  }
}

export interface GaugeForecast {
  /** 0 to 1. */
  win: number;
  meanMs: number;
  packFactor: number;
  /** Auto-retreat skips this entry. */
  skip: boolean;
}

export interface GaugeEntry {
  entryId: string;
  share: number;
  /** This member's mean pay for a win, before the pack factor. */
  winPay: number;
  /** Mean raw XP of the entry's packs. */
  packXp: number;
  forecast?: GaugeForecast;
}

export type GaugeBasis = 'estimate' | 'settling' | 'steady';

export interface GaugeReading {
  /** Null with neither a forecast nor a won fight to go on. */
  perHour: number | null;
  basis: GaugeBasis;
  /** Over the entries the party fights. */
  winChance: number;
}

interface Blend {
  win: number;
  ms: number;
  packFactor: number;
}

function blend(entry: GaugeEntry, tally: RoomTally): Blend | null {
  const seen = tally.entry(entry.entryId);
  const forecast = entry.forecast;
  const prior = forecast ? GAUGE_FORECAST_FIGHTS : 0;
  const fights = seen?.fights ?? 0;
  const wins = seen?.wins ?? 0;
  let win: number;
  let ms: number;
  if (prior + fights > 0) {
    win = (prior * (forecast?.win ?? 0) + wins) / (prior + fights);
    ms = (prior * (forecast?.meanMs ?? 0) + (seen?.ms ?? 0)) / (prior + fights);
  } else if (tally.fights > 0) {
    win = tally.wins / tally.fights;
    ms = tally.ms / tally.fights;
  } else {
    return null;
  }
  const priorWins = forecast ? GAUGE_FORECAST_FIGHTS : 1;
  const seenFactor = entry.packXp > 0 ? (seen?.winPackXp ?? 0) / entry.packXp : wins;
  const packFactor = (priorWins * (forecast?.packFactor ?? 1) + seenFactor) / (priorWins + wins);
  return { win, ms, packFactor };
}

/** XP per hour for one member in one room. See docs/architecture/combat.md → XP gauge. */
export function readRoomGauge(entries: readonly GaugeEntry[], tally: RoomTally, timing: GaugeTiming = GAUGE_TIMING): GaugeReading {
  let pay = 0;
  let time = 0;
  let win = 0;
  let fought = 0;
  for (const entry of entries) {
    if (!(entry.share > 0)) continue;
    if (entry.forecast?.skip) {
      time += entry.share * timing.skipMs;
      continue;
    }
    const b = blend(entry, tally);
    if (!b) continue;
    pay += entry.share * b.win * entry.winPay * b.packFactor;
    time += entry.share * (b.ms + b.win * timing.winPauseMs + (1 - b.win) * timing.lossPauseMs);
    win += entry.share * b.win;
    fought += entry.share;
  }
  const winChance = fought > 0 ? win / fought : 0;
  const steady = tally.fights >= GAUGE_STEADY_FIGHTS_HARD || (tally.fights >= GAUGE_STEADY_FIGHTS && winChance >= GAUGE_STEADY_WIN_CHANCE);
  const known = tally.wins > 0 || entries.some(entry => entry.forecast);
  return {
    perHour: known && time > 0 ? (pay / time) * 3_600_000 : null,
    basis: tally.fights === 0 ? 'estimate' : steady ? 'steady' : 'settling',
    winChance,
  };
}

/** The blended length of this entry's fights, which a fight under way is measured against. */
export function usualFightMs(entries: readonly GaugeEntry[], tally: RoomTally, entryId: string): number | null {
  const entry = entries.find(e => e.entryId === entryId);
  if (!entry || entry.forecast?.skip) return null;
  return blend(entry, tally)?.ms ?? null;
}

/** Two significant figures, so a small drift never changes what the screen shows. */
export function roundToTwoFigures(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value < 10) return Math.round(value);
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / step) * step;
}

/** A shown figure moves only once a reading leaves this band around it. */
export const GAUGE_HOLD_FRACTION = 0.05;
/** Once shown, the losing note stays until the win chance passes GAUGE_LOSING_WIN_CHANCE by this much; once clear, it returns only this far under. */
export const GAUGE_LOSING_BAND = 0.05;

export interface ShownGauge {
  perHour: number;
  losing: boolean;
}

/** What one member sees next, holding the last figure and note through small moves. */
export function holdShownGauge(shown: ShownGauge | undefined, perHour: number, winChance: number): ShownGauge {
  if (!shown) return { perHour: roundToTwoFigures(perHour), losing: winChance < GAUGE_LOSING_WIN_CHANCE };
  const held = Math.abs(perHour - shown.perHour) <= GAUGE_HOLD_FRACTION * shown.perHour;
  const losingUnder = GAUGE_LOSING_WIN_CHANCE + (shown.losing ? GAUGE_LOSING_BAND : -GAUGE_LOSING_BAND);
  return { perHour: held ? shown.perHour : roundToTwoFigures(perHour), losing: winChance < losingUnder };
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRegions } from '../policy.js';
import type { Region } from '../policy.js';
import { REACH_REFUSAL, SNAPSHOT_FILE, readCells, readMeta, readSnapshot } from './atlas.js';
import { ARCHER_HIRED_KNIGHT, DEFAULT_SEAT_PREFIX, DUO_FILL_HIRES, FULL_PARTY, MAGE_BARD_PARTIES, SOLO_FILL_HIRES, SOLO_ID_BY_CLASS, TYPICAL_PARTY, XP_BONUS_PREFIX } from './comps.js';
import { PLAN_FILE, RATES_FILE, SECOND_LOOK_DIR, evaluateSampled, readRates, withFirstSample, writeRates } from './evaluate.js';
import { memberReaches } from './gates.js';
import type { FloorGoldRead, RunGold } from './gold.js';
import { applyGoldFactors, floorRewardValue, goldFactors, goldStops, loopRunGold } from './gold.js';
import type { SpreadRow, SpreadShares } from './layouts.js';
import { compareLayouts, coverOfStops, effectiveNumber, layoutSpread } from './layouts.js';
import type { MaterialInfo } from './materials.js';
import { buildMaterials, encounterDropTables, meanQuantity } from './materials.js';
import type { BossPolicy, DungeonWeeklyRule, FightView, MemberView, MonsterInfo, PayoutContext, XpPlan } from './plan.js';
import { MAX_WEEKLY_FULL_CLEARS, assertWeeklyRule, loadPlan, planBossPolicy, planTitle, readPlanState, xpRulesOf } from './plan.js';
import { buildQuestLedger, questsWithinRegion, regionEntryLevel, repeatableXpPerHour, repeatablesWithinRegion } from './quests.js';
import type { QuestLedger, QuestLump } from './quests.js';
import { ensureSampled } from './refine.js';
import { ON_LEVEL_BAND, WIN_OK_PCT } from './types.js';
import type { AtlasMeta, BossSplit, CellGold, CellRate, XpCell, XpComp, XpSnapshot, XpTable } from './types.js';

const SOLO_IDS = ['K', 'A', 'P', 'M', 'B'];
const HIRE_IDS = SOLO_IDS.map(id => `${id}+hires`);
const FILL_IDS = SOLO_IDS.map(id => `${id}+h${SOLO_FILL_HIRES}`);
const NOISE_TOLERANCE = 0.05;
const DAY_HOURS = 24;
const HOUR_MS = 3_600_000;
const TOP_OFFENDERS = 10;
const TARGET_LEVELS = [5, 10, 20, 30, 40, 50, 60];
const MAX_LEVEL = 60;
const JOURNEYER_MIN_LEVEL = 10;
const BACKWARDS_GAP = 5;
const FIT_TOLERANCE = 0.25;
const FIT_PASS_SHARE = 0.8;
const MONOTONE_PASS_RHO = 0.9;
const INVERSION_KEEP = 0.8;
const INVERSION_MIN_GAP = 3;
const EFFICIENCY_MAX_BAD_SHARE = 0.001;
/** A party is hire-carried when a hire is this many levels above its lowest human. */
const HIRE_CARRY_GAP = 5;
/** Threshold for "no big farming incentive". */
const FARM_PASS_RATIO = 1.25;
/** Percentage points of win rate a variant must give up to count as losing on purpose. */
const LOSE_FAST_WIN_GAP = 5;
/** A pair within this factor of its line can flip on a fresh sample, so it gets one before it counts. */
const RESAMPLE_MARGIN = 1.25;
/** I4's version: a room paying under this share of one below it. */
const RESAMPLE_INVERSION_KEEP = 0.9;
/** A first read of a fully won room can sit this far under what a fresh sample finds, so a rival within it can really be the best room. */
const UNDER_READ = 1.25;
const RESAMPLE_ROUNDS = 4;
const RESAMPLE_CELL_LIMIT = 12000;
const UNPAID_WARNING_SHARE = 0.5;
/** Always n/a: they report and don't judge. */
const UNSCORED_METRICS = ['I13', 'Gold', 'Progression', 'Retreat', 'Not simulated'];
const FIVE_BARDS = 'Bx5';
const HOURS_PER_WEEK = 7 * DAY_HOURS;
/** Reach: a room level counts as reached when the party wins this share of the ordinary paying rooms within REACH_WINDOW levels of it, and the walk up from the world's lowest room stops at the first level that fails, so one soft room far above doesn't count. */
const REACH_WINDOW = 2;
const REACH_ROOM_SHARE = 0.6;
/** The first third of the world's regions are early: they may lean towards balanced parties, so they are only reported. */
const EARLY_REGION_SHARE = 1 / 3;
/** XP/hr within this of the best counts as close: wide against a cell's noise between seeds. */
const CLOSE_TO_BEST = 0.1;
/** I14 fails if one layout leads over this share of rooms from the mid game on. */
const NEARLY_EVERYWHERE = 0.75;
/** I14 fails if one layout is close to a class's best at over this share of the class's stops from the mid game on. */
const ONE_SENSIBLE_PARTY = 0.8;
/** I14 fails if a party has fewer distinct rooms than this, from the mid game on, where it is best or close among parties of its size. */
const MIN_PURPOSE_ROOMS = 3;
/** Same head count: dominated when another layout earns CLOSE_TO_BEST more in this share of the rooms both win, with at most DOMINATED_EXTRA_ROOMS of its rooms won only by it, over at least DOMINATED_MIN_SHARED rooms. */
const DOMINATED_ROOM_SHARE = 0.9;
const DOMINATED_EXTRA_ROOMS = 0.05;
const DOMINATED_MIN_SHARED = 10;
/** A layout earning this much over its usual in a room, once room and level are out, is reported as favoured there. */
const FAVOURED_ROOM = 1.25;
/** The working band for a material room's XP hit, and what counts as no hit or as a far bigger hit. */
const MATERIAL_BAND_LOW = 0.1;
const MATERIAL_BAND_HIGH = 0.3;
const MATERIAL_NO_HIT = 0.05;
const MATERIAL_FAR_HIT = 0.5;
/** A boss token or dungeon-only material is a short visit, so it fails on hours of best-room XP given up per craft, not on the hit while there. */
const SHORT_VISIT_GIVEN_UP_HOURS = 2;
/** A source slower than this per craft isn't a real choice unless it's the only one. */
const USEFUL_CRAFT_HOURS = 72;
/** Material levels a recipe stays on-level for, above its required level. */
const MATERIAL_ON_LEVEL_SPAN = 3;
const MATERIAL_REFERENCE_PARTIES = ['K', 'A', 'P', 'M', 'B', 'K+P', ARCHER_HIRED_KNIGHT, TYPICAL_PARTY, FULL_PARTY, FIVE_BARDS, 'Kx5'];
const MATERIAL_GOING_BACK = [10, 20, 30];
const REPORTED_LEVEL_STEPS = [10, 20, 30, 40, 50, 60];
/** I5: a room the party wins must pay at least this share of its zone's median. */
const ROOM_FLOOR_SHARE = 0.1;
/** I5, reported: rooms this far below the party, against its best room. */
const AFK_GAP_BANDS: readonly [number, number][] = [[5, 10], [11, 20], [21, 60]];
/** I12: a class alone must earn at least this share of what it earns in the median layout it could join, best room against best room. */
const SOLO_PLAYABLE_SHARE = 0.1;
/** I8b: a room won under this % is one the party loses. */
const LOSING_WIN_PCT = 50;
/** I8, reported: rooms this far above the party. */
const SOFT_ROOM_BANDS: readonly [number, number][] = [[6, 10], [11, 15], [16, 20]];
/** I6: fights a side before a flagged variant counts. 400 can't place a ratio against a 5 % line. */
const CONFIRM_FIGHTS = 6000;
/** Past this a flagged variant is clear of the line on 400 fights, and needs no bigger sample. */
const CONFIRM_MARGIN = 1.25;
const CONFIRM_CELL_LIMIT = 200;
const SECOND_LOOK_ROUNDS = 2;
/** I9, flagged: a carrier earning under this share of an on-level party's rate. */
const CARRIER_FLAG_SHARE = 0.25;
/** I15: a far bigger hit fails only if the visit also gives up this many hours of best-room XP per craft. */
const FAR_HIT_VISIT_GIVEN_UP_HOURS = 0.25;
/** A warning, not a verdict: within a room, level and party size, kill rate should mostly order XP/hr. */
const FLAT_PAY_CORRELATION = 0.5;
const LOST_FIGHT_PROBE_GAPS = [0, 5, 11, 20, 40];
/** I16, reported: how far under the class's richest room a repeat loop would have to fall to pass a harder line. */
const GOLD_REPORT_LINES = [0.5, 0.25];
/** I16, reported: the same verdict at these re-entry waits, in seconds, since nothing in the game sets one. */
const REENTRY_PROBES = [5, 30];
/** I16, reported: an alternative line, the richer of the room they'd stand in for XP and this share of the richest room. */
const STRICT_LINE_SHARE = 0.25;
/** A plan raising gold past this share of what the atlas's own content pays gets a warning, and in a lone loop's monster drops fails I16. The same fights on both sides, so this isn't noise. */
const GOLD_RAISED_LINE = 1.25;
/** A warning: the median on-level room's coin outside this band of what the atlas's own content pays. */
const ROOM_COIN_BAND: readonly [number, number] = [0.5, 2];
/** I15: a material taking longer than this per craft isn't obtainable. Long enough that one full clear a week can supply one. */
const STRANDED_CRAFT_HOURS = 4 * HOURS_PER_WEEK;
const STARTER_REGION = 0;

export const NOT_SIMULATED: readonly { family: string; why: string }[] = [
  { family: 'Leaving or joining before the kill', why: 'Settlement pays whoever is in the party when the fight ends, so someone can join for the last blow or leave before it. The atlas fights one fixed party per cell.' },
  { family: 'Padding with the weakest hires', why: 'Hires are free and have no lower level bound, and the atlas only fields the usual ones or the strongest within the hire level limit. A rule paying more for a bigger party can be farmed by filling seats with hires who do nothing.' },
  { family: 'Lockouts across rooms', why: 'A bossPolicy applies to one room at a time, so hopping between rooms with the same boss, or the same lockout under another name, reads as no gain here.' },
  { family: 'Dungeon runs that stop early, for XP', why: 'XP loops are full runs that clear. Leaving after the first floors, or wiping on purpose, pays per floor and is not read for XP. I16 does read it for a lone player\'s gold.' },
  { family: 'A lone player left behind a party door', why: 'A dungeon\'s door is checked at entry only, and a run goes on when members leave, so friends can open a party-only door for one player who stays and takes every floor\'s coin and rewards. The atlas holds no lone cells behind such a door, so I16 reads nothing there, and a plan with its own atlas that sets a door to two or more removes that dungeon from I16.' },
  { family: 'Skills granted by items', why: 'Plans assume no item grants another class\'s skill. Any grant the snapshot still holds is named in the coverage note, and default loadouts don\'t slot it, so what a build using one reaches and earns is not on this card.' },
];

export const MODEL_ASSUMPTIONS: readonly string[] = [
  'Fight time is the engine\'s elapsed time at COMBAT_PACE through paceRealMs. The server steps with setInterval, so real time can drift a little longer; this is ignored.',
  'Between fights: ServerBattleTimer waits KILL_BEAT_MS, then RESULT_PAUSE + MOVE_DURATION, the same after a victory, a defeat and a stalemate, with or without a queued move. There is no wait after a loss and no other defeat penalty: the next fight starts at full HP.',
  'Auto-retreat is a range, not a rate. With any pack under the line, three skips in ten fights make a party leave the room (at once if the whole room is under it). It goes to its previous room if that is safe, else the neighbour it wins most, and holds there until a player moves it; that target can pay nothing. So a cell with skip above 0 earns between 0 and the shown rate, depending on where the party walked in from, and scorecards print it as a range. The shown rate charges each skipped fight RUN_AVAILABLE_MS, rounded up to a step, plus RESULT_PAUSE + MOVE_DURATION while the skip share is under 10 %, and fights everything out from 10 %, which is also what a player gets with auto-retreat switched off. The walk is not modelled.',
  'A party sits in one room and never moves. Journey time between rooms is not modelled; a move costs the same pause, and rooms along the way are fought like any other.',
  'A stalemate is a defeat, as in the engine. A fight past defaultHorizonMs is fought to its end, as the game does. 4 real hours bounds the simulation: a fight still going there (a timeout) pays nothing for its full length. Each row keeps a flag for passing the horizon, because the real forecast scores those fights as not won whatever happens later, and the auto-retreat figures (skip, reloc, fwin) read that.',
  'Rates are share-weighted means over max(3, round(N x share)) fights per table entry with seeded RNG, N about 24, so one cell\'s first read is noisy. Three things keep that out of the verdicts. Near-line cells, reading 70 to 100 % won, are replaced by a fresh sample of 400 fights in every plan. Before a verdict counts, the rooms it picked for any pair within 1.25x of its line get the same fresh sample, with any room within 1.25x of the pick that a low first read could be hiding, and the picks are redone until they stop moving. And the 90 % win line becomes a band on a fresh sample: a party\'s room counts as won if the sample\'s 95 % interval reaches 90 %, and the room it is compared against only if the whole interval clears 90 %, so a good plan can\'t fail on a room that sits on the line. That widens the line by about 3 points each way at 400 fights.',
  'Gear: per member, best shop items of the last region whose median zone midpoint is at or below that member\'s level (first region below every midpoint), prices ignored, sets not chased; "ungeared" is empty slots.',
  'Loadouts come from chooseLoadout at each member\'s level; no party-specific swaps, no action-order lists. An xp_bonus passive never makes that loadout on this kind of content, so only I: compositions carry an XP multiplier: every member who can swaps their last unlocked passive for it, and fights with the swap.',
  'Seats: every composition is placed by class as a player would arrange it, except D: compositions, which sit where the game hands out seats when nobody moves anyone: the leader in the centre, everyone else in the first free seat, hires included.',
  'Hires: chooseHires (up to two, tank/healer/damage) from shops on the room\'s world map; A+hK takes the best-fitting Knight hire on the map, and the cell is ineligible where the map offers none; +h compositions fill the party with the strongest hires on the map, a tank and a healer first. A hire has no cost at all, only a shop on the party\'s current map and the hire level limit: one more than HIRE_LEVEL_LIMIT levels above the party\'s highest human can\'t be hired, so no composition takes one. The journey to that map is not modelled. A party is hire-carried at a cell when a hire is at least 5 levels above its lowest human; I1 scores those separately.',
  'Room gates: tile and transition entry requirements apply to every member, and a quest gate needs the quest\'s level per player. A cell whose lowest member is below the table\'s reach level is ineligible. Reach is a lower bound: fights along the way are assumed won and collect objectives doable. A table\'s reach is that of its easiest room.',
  'Mastery bonuses are zero: long-term farmers of one monster deal up to a little more than shown.',
  'Quest XP: non-repeatable quests pay as one-off lumps the moment a player reaches the highest of the quest\'s level, its prerequisites\' levels and its region\'s entry level. Time spent doing them is not charged, and every quest is assumed finishable by every persona (class gates, dungeon needs and fetch items ignored), so "with quests" is optimistic.',
  'Weekly quests count in their own rows as a steady XP/hr, every one done on time from its available level. Weeklies are allowed, boss-kill weeklies included, so I10 reports them and first clears as days of idle XP and no verdict counts them.',
  'Quests belong to the lowest region among the NPCs listing them. A starter-sitter only gets quests whose NPCs, visit rooms, single-region kill targets and whole prerequisite chain stay in the starter region.',
  'Dungeon loops: floor fights are independent and a loss on any floor ends the run, as the game keeps no progress and has no retries. Re-entry is a manual action charged a flat delay that earns nothing, so where the entrance room pays, a real loop earns a little more than shown. Keys and first-clear gold are out of scope. First-clear XP counts as a lump only for the boss farmer with quests. A plan\'s dungeonWeekly rule is a weekly lump plus a repeat rate per dungeon: the repeat rate is the loop, and the lump is reported like a weekly quest.',
  'Bosses in overworld rooms loop forever, with no spawn rule, as the game does today. A plan\'s bossPolicy is modelled per table entry. Metrics that compare rooms read what the room itself pays: paid boss kills, plus its other entries for the rest of the time. I10 and the boss farmer read a day built around the boss, a bonus on top of idle: while an all-boss table has no fight, the party earns its best non-boss room.',
  'Room level: weighted median authored level of non-passive monsters, else the zone midpoint. "On-level" is within 3 of the party\'s level. Region 0 (lowest median midpoint) is the starter region.',
  'Mixed-level carry parties use fixed class mixes: 1+1 Knight or Mage carrying a Priest, 4+1 K, A, M, B carrying a Priest, 1+4 Knight carrying A, P, M, B. Carrier level is limited to room level -5 to +20.',
  'Worse seat: the Knight and Priest swap seats (the Archer and hired Knight in A+hK). P-only and P+B parties aren\'t the same party as the mixed party they name, so they are compared with a mixed party of their size under I7, for information, not under I6.',
  'I6 counts a same-party variant (ungeared, Attack only, worse seat) only if it earns over 5 % more with longer fights or fewer kills an hour, or by giving up wins for shorter fights, and only if a fresh sample agrees. Earning more with shorter fights and more kills is a faster party, which I7 says should pay. xp_bonus, stacked or not, is a designed perk: its cells are reported and never count.',
  'A balanced party is not a yardstick or a goal. The reference parties are examples for measuring income, and "the layouts best suited to each room" are measured from the rooms. Early regions may favour balance, so I14 only reports them and tests from the mid game on.',
  'A layout is a party shape. Where the atlas holds a Bard party both with and without xp_bonus, I14 counts them as one layout taking the better of the two, because the passive is a choice, not a party. Layouts are the normally played compositions: no ungeared, Attack-only, worse-seat, default-seat or carry variants.',
  'Rooms in I13, I14, I15, I12\'s share tables, I1b\'s xp_bonus additions and I10\'s parties beyond the reference ones are read as sampled: a first read of about 24 fights, or the fresh sample where a near-line pass or another verdict took one. These lines add no cells to the re-sampling, so they never change another metric\'s figures, and their bands are wide against a cell\'s noise between seeds.',
  'A second look reads a few cells again without touching rates.jsonl, so it moves no other metric: I6\'s flagged variants at 6000 fights a side, its faster parties at 400, and I8b\'s picks at 400. I16 takes its own such read at 400 for cases near its line, and only I16 and the Gold section use it. Its samples live in the run\'s own folder, not the atlas.',
  'Materials: an ingredient no recipe makes, read from the plan\'s own snapshot, with what one gear craft takes of it counted down through any parts. Drops per won fight follow payVictory: each monster present rolls its paced chance, and each item goes to one share of the party, hires included, a hire\'s item being lost. Floor rewards roll once per human and aren\'t split. On-level means the recipes\' levels up to 3 above. For each party and level the source taken is the one giving up the least best-room XP per craft that can finish a craft in 72 hours, else the fastest; a dungeon source is a full loop clearing at least 90 %, at its repeat rate. A material reaching gear only through parts a shop also sells just saves gold, so it is reported and doesn\'t count; one reaching gear through a part no shop sells counts. Walking and mastery aren\'t charged.',
  'Gold: coin is read off every fight as payVictory pays it, the mean of ceil(total rolled x rewardMultiplier / shares), each monster present rolling a whole number from goldMin to goldMax, standing walls too, on a win only, with no level factor, times the floor\'s coinFactor on a dungeon floor; shares are humans plus fighting hires. A floor reward rolls once per human on a win at its authored chance, unpaced and unsplit, with class restrictions as written, and sells at value, or 1 where an item has none; first-clear rewards don\'t count. Monster drops are read the same way, by payVictory\'s shares, and reported apart: I16 counts coin and floor rewards only. Loops use the XP loop\'s model and fight times. Selling needs no walk and stacks are assumed sold before they cap. A weekly rule\'s repeatCoinFactor and repeatRewardFactor stay at 1 if left out, whatever repeatFactor says, and cut every repeat run, including one that stops early, so an engine rule that only touched full clears would pay more than this reads. A plan that retunes content also gets each cell read as the atlas\'s own content pays it, which holds I16\'s yardstick at or under the atlas\'s and spots gold a plan moved elsewhere. Crafted income, trading and gear prices aren\'t modelled.',
  'Verdict thresholds, all adjustable: I1, I1b, I2, I3 and I12 pass with no pair off by over 5 %; I4 needs rank correlation at least 0.9 and no room under 80 % of a room 3+ levels below; I5 needs every room a party wins to pay at least 10 % of its zone\'s median; I6 counts a variant only if it holds at 6000 fights a side, unless 400 fights already read it over 1.25x; I7 tolerates 0.1 % inverted pairs, not counting pairs where the slower party holds xp_bonus; I8 needs every +1..+5 median above on-level and rising, within 5 %; I8b reads a room won under 50 % as one the party loses; I9 needs a carried friend faster than both an on-level solo and an on-level party, and flags a carrier under 25 % of an on-level party\'s rate; I10 needs boss rooms and dungeon loops within 1.25x of the best non-boss room, a p90 active premium without any weekly within 1.25x, no solo dungeon loop over the class\'s best solo room by over 5 %, no floor whose content pays cut to nothing, and a weekly dungeon rule of at most 3 full clears with a repeat rate above 0; I16 needs no lone run, stopping after any floor, whatever its clear rate, to pay over 5 % more coin and floor rewards an hour than the class\'s richest ordinary room won at least 90 %, that room read no higher than the atlas\'s own content pays, and no lone loop\'s monster drops raised over 1.25x what the atlas\'s own content pays; I11 needs 80 % of levels within 25 % of XP_INCOME_MODEL; I12 needs a class alone to win some paying room and earn at least 10 % of the median layout it could join; I14 and I15 print their own numeric lines.',
  'I3 compares a sitter with the same party journeying. The best sitter of any party against other parties\' journeyers is printed and judges nothing, since a five-player sitter and a lone journeyer differ by more than where they stand. I1, I1b and I12 read "must pay more" as not under by over 5 %, for the noise of a 400-fight sample.',
];

interface Row {
  cell: XpCell;
  rate: CellRate;
  table: XpTable;
  comp: XpComp;
  members: { className: string; level: number; role: string }[];
  /** Mean XP/hr across human members, default auto-retreat. */
  xp: number;
}

export interface Metric {
  id: string;
  title: string;
  pass: boolean | null;
  magnitude: string;
  lines: string[];
  /** A few words for a leaderboard cell. */
  short?: string;
  /** What this metric measured, for comparing plans. */
  values?: Record<string, number>;
}

function hasBossRule(policy: BossPolicy | undefined): policy is BossPolicy {
  return !!policy && (policy.respawnMs !== undefined || policy.bounty !== undefined);
}

/**
 * XP one member earns over `hours` hours sitting in a boss room under a policy: paid kills as a bonus,
 * the room's other entries for the rest of the time, or `idleXp` per hour if the whole table is a boss.
 */
export function bossHoursXp(split: BossSplit, member: number, policy: BossPolicy, pauseMs: number, hours: number, idleXp: number): number {
  const bossCycle = split.ms + pauseMs;
  const restCycle = split.restMs + pauseMs;
  const meanCycle = split.share * bossCycle + (1 - split.share) * restCycle;
  const unlimited = (split.share * hours * HOUR_MS) / meanCycle;
  const limit = policy.respawnMs ? (hours * HOUR_MS) / Math.max(policy.respawnMs, bossCycle) : Infinity;
  const fights = Math.min(unlimited, limit);
  const kills = fights * split.win;
  const xpPerKill = split.win > 0 ? split.xpf[member] / split.win : 0;
  let paid = 0;
  if (policy.bounty) {
    const whole = Math.floor(kills);
    for (let i = 0; i < whole; i++) paid += policy.bounty(i) * xpPerKill;
    paid += (kills - whole) * policy.bounty(whole) * xpPerKill;
  } else {
    paid = kills * xpPerKill;
  }
  const restRate = split.share < 1 ? (split.restXpf[member] / restCycle) * HOUR_MS : idleXp;
  const restHours = Math.max(0, hours - (fights * bossCycle) / HOUR_MS);
  return paid + restHours * restRate;
}

/** What a second look read: never written to rates.jsonl. */
export interface SecondLookLog {
  reread: number;
  rereadFights: number;
  confirmed: number;
  confirmFights: number;
  simulatedCells: number;
  /** Flagged cells over the limit, which count on what they read before. */
  leftOver: number;
}

export interface ResampleLog {
  /** Fights per fresh sample; 0: verdicts rest on the atlas and the near-line pass alone. */
  fights: number;
  /** Cells per round. */
  rounds: number[];
  /** Of those, cells with no cached sample yet. */
  simulatedCells: number;
  /** Cells a verdict still leaned on when the rounds or the cell limit ran out. */
  leftOver: number;
}

export class Data {
  readonly rows: Row[] = [];
  private readonly byKey = new Map<string, Row>();
  private readonly byCell = new Map<number, Row>();
  private readonly raw = new Map<number, CellRate>();
  private readonly byCompLevel = new Map<string, Row[]>();
  private readonly tableRows = new Map<number, Row[]>();
  private readonly idleMemo = new Map<string, Row | undefined>();
  readonly zero = new Set<number>();
  readonly compIds: Set<string>;
  readonly policy: BossPolicy | undefined;
  /** Bigger samples read by a few lines only. Never written to rates.jsonl. */
  readonly second = new Map<number, CellRate>();
  /** Fresh reads for I16 and the Gold section alone, kept apart from `second` so they can't move I6 or I8b. Never written to rates.jsonl. */
  readonly goldSecond = new Map<number, CellRate>();
  goldLook: { cells: number; fights: number; simulatedCells: number } = { cells: 0, fights: 0, simulatedCells: 0 };
  private readonly secondFights = new Map<number, number>();
  resample: ResampleLog = { fights: 0, rounds: [], simulatedCells: 0, leftOver: 0 };
  secondLook: SecondLookLog = { reread: 0, rereadFights: 0, confirmed: 0, confirmFights: 0, simulatedCells: 0, leftOver: 0 };
  /** The atlas's own content, when the plan retuned it. */
  baseContent?: XpSnapshot;

  constructor(
    readonly meta: AtlasMeta,
    readonly cells: readonly XpCell[],
    rates: readonly CellRate[],
    readonly content: XpSnapshot,
    readonly regions: readonly Region[],
    readonly ledger: QuestLedger,
    readonly mod: any,
    readonly plan: XpPlan | undefined,
    readonly activeHours: number,
    readonly reentryMs: number,
    readonly baselineCurve: Record<string, Record<string, number>> | null,
    readonly planState?: unknown,
  ) {
    this.compIds = new Set(meta.comps.map(c => c.id));
    this.policy = planBossPolicy(plan);
    for (const rate of rates) {
      if (![...rate.xp, ...rate.raw, ...rate.xpf].every(Number.isFinite)) throw new Error(`rates for cell ${rate.c} hold a value that isn't a finite number: evaluate the plan again`);
      this.raw.set(rate.c, rate);
      const cell = cells[rate.c];
      const comp = meta.comps[cell.comp];
      const row: Row = {
        cell,
        rate,
        table: meta.tables[cell.table],
        comp,
        members: comp.members.map(m => ({ className: m.className, level: cell.level + m.levelOffset, role: m.role })),
        xp: mean(rate.xp),
      };
      this.rows.push(row);
      this.byKey.set(`${cell.table}|${comp.id}|${cell.level}`, row);
      this.byCell.set(rate.c, row);
      push(this.byCompLevel, `${comp.id}|${cell.level}`, row);
      push(this.tableRows, cell.table, row);
    }
    this.refreshZero();
    this.applyBossPolicy();
  }

  private refreshZero(): void {
    this.zero.clear();
    for (const table of this.meta.tables) {
      const rows = this.tableRows.get(table.index) ?? [];
      const decided = rows.filter(r => r.rate.win > 0);
      const zero = decided.length ? decided.every(r => r.rate.xpf.every(x => x === 0)) : table.zeroXp;
      if (zero) this.zero.add(table.index);
    }
  }

  /** Keeps the bigger of what it holds and these. */
  absorbSecond(fresh: ReadonlyMap<number, CellRate>, fights: number): void {
    for (const [id, rate] of fresh) {
      const row = this.byCell.get(id);
      if (!row || (this.secondFights.get(id) ?? 0) > fights) continue;
      this.second.set(id, this.withBossPolicy(row, rate));
      this.secondFights.set(id, fights);
    }
  }

  /** The best read of this cell, second look included. */
  latest(r: Row): CellRate {
    return this.second.get(r.cell.id) ?? r.rate;
  }

  /** Fights behind that read beyond the first one; 0: only the first read. */
  sampleSize(r: Row): number {
    return this.secondFights.get(r.cell.id) ?? (r.rate.first ? r.rate.n : 0);
  }

  /** Replaces these cells' figures with fresh samples. */
  absorb(fresh: ReadonlyMap<number, CellRate>): void {
    for (const [id, rate] of fresh) {
      const row = this.byCell.get(id);
      if (!row) continue;
      const merged = withFirstSample(rate, this.raw.get(id)!);
      this.raw.set(id, merged);
      row.rate = this.withBossPolicy(row, merged);
      row.xp = mean(row.rate.xp);
    }
    this.idleMemo.clear();
    this.refreshZero();
  }

  /** Every cell's figures before any bossPolicy, in cell order: what rates.jsonl holds. */
  rawRates(): CellRate[] {
    return [...this.raw.values()].sort((a, b) => a.c - b.c);
  }

  /** The win %, as far as a sample can place it: a first read as it stands, a fresh sample as its interval. */
  private winBand(rate: CellRate, fresh = !!rate.first): [number, number] {
    if (!fresh) return [rate.win, rate.win];
    const [low, high] = this.mod.wilsonInterval(rate.win / 100, rate.n);
    return [low * 100, high * 100];
  }

  /** Holds whatever a fresh sample's noise did: what a verdict may compare a party against. */
  clearlyWon(r: Row): boolean {
    return this.winBand(r.rate)[0] >= WIN_OK_PCT;
  }

  /** Might win at least the line: what a verdict lets a party claim. */
  plausiblyWon(r: Row): boolean {
    return this.winBand(r.rate)[1] >= WIN_OK_PCT;
  }

  /** What the gold lines read of this cell: its fresh read if they took one. */
  goldRate(r: Row): CellRate {
    return this.goldSecond.get(r.cell.id) ?? r.rate;
  }

  /** The win line as the gold lines read it, on the plan's side. */
  goldWon(r: Row): boolean {
    return this.winBand(this.goldRate(r), this.goldSecond.has(r.cell.id) || !!r.rate.first)[1] >= WIN_OK_PCT;
  }

  private applyBossPolicy(): void {
    if (!hasBossRule(this.policy)) return;
    for (const row of this.rows) {
      if (!row.rate.bs) continue;
      row.rate = this.withBossPolicy(row, row.rate);
      row.xp = mean(row.rate.xp);
    }
  }

  /** What the room itself pays under a plan's bossPolicy: paid kills and its other entries, nothing from rooms elsewhere. */
  withBossPolicy(row: Row, rate: CellRate): CellRate {
    const split = rate.bs;
    if (!split || !hasBossRule(this.policy)) return rate;
    return { ...rate, xp: row.members.map((_, m) => bossHoursXp(split, m, this.policy!, this.meta.pauseMs, DAY_HOURS, 0) / DAY_HOURS) };
  }

  /** Mean XP/hr of a whole day built around this boss room: an all-boss table has no fight during a respawn, so the party idles at its best room meanwhile. */
  bossDayRate(row: Row): number {
    const split = row.rate.bs;
    if (!split || !hasBossRule(this.policy)) return row.xp;
    const idle = this.idleRoom(row.comp.id, row.cell.level);
    return mean(row.members.map((_, m) => bossHoursXp(split, m, this.policy!, this.meta.pauseMs, DAY_HOURS, idle?.rate.xp[m] ?? 0) / DAY_HOURS));
  }

  /** Coin/hr one human earns in this room. A respawn rule limits boss fights; a bounty scales XP, not coin. */
  coinPerHour(r: Row): number {
    const rate = this.goldRate(r);
    return rate.g ? this.coinRead(rate, rate.g) : 0;
  }

  /** The same fights as the atlas's own content pays them, whatever the plan did to that coin. */
  atlasCoinPerHour(r: Row): number {
    const rate = this.goldRate(r);
    return rate.g ? this.coinRead(rate, rate.g.atlas ?? rate.g) : 0;
  }

  private coinRead(rate: CellRate, gold: Pick<CellGold, 'ch' | 'bs'>): number {
    const split = rate.bs;
    const respawnMs = this.policy?.respawnMs;
    if (!split || !gold.bs || !respawnMs) return gold.ch;
    return bossHoursXp({ ...split, xpf: [gold.bs.coin], restXpf: [gold.bs.rest] }, 0, { respawnMs }, this.meta.pauseMs, DAY_HOURS, 0) / DAY_HOURS;
  }

  /** The party's best paying non-boss room it wins, what it earns with nobody watching. */
  idleRoom(compId: string, level: number): Row | undefined {
    const key = `${compId}|${level}`;
    if (this.idleMemo.has(key)) return this.idleMemo.get(key);
    const best = maxBy(this.at(compId, level).filter(r => this.isFarmRoom(r.table) && this.plausiblyWon(r)), r => r.xp);
    this.idleMemo.set(key, best);
    return best;
  }

  hireCarried(r: Row): boolean {
    if (r.cell.hires.length === 0) return false;
    const top = Math.max(...r.cell.hires.map(id => this.content.henchmen[id]?.level ?? 0));
    return top >= Math.min(...r.members.map(m => m.level)) + HIRE_CARRY_GAP;
  }

  get(table: number, compId: string, level: number): Row | undefined {
    return this.byKey.get(`${table}|${compId}|${level}`);
  }

  at(compId: string, level: number): readonly Row[] {
    return this.byCompLevel.get(`${compId}|${level}`) ?? [];
  }

  ofTable(table: number): readonly Row[] {
    return this.tableRows.get(table) ?? [];
  }

  isFarmRoom(table: XpTable): boolean {
    return table.kind === 'room' && !table.boss && !this.zero.has(table.index);
  }

  onLevel(compId: string, level: number): Row[] {
    return this.at(compId, level).filter(r => this.isFarmRoom(r.table) && Math.abs(r.table.roomLevel - level) <= ON_LEVEL_BAND && r.rate.win >= WIN_OK_PCT);
  }

  comps(...families: string[]): XpComp[] {
    return this.meta.comps.filter(c => families.includes(c.family));
  }

  has(compId: string): boolean {
    return this.compIds.has(compId);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] === sorted[high] ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const result = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) result[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return result;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (abs >= 100) return `${Math.round(value)}`;
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function ratio(value: number): string {
  if (value === Infinity) return 'inf';
  return Number.isFinite(value) ? `${value.toFixed(2)}x` : '-';
}

/** x / y with nothing over nothing as 0, not NaN: NaN passes every `ratio < limit` test. */
export function safeRatio(x: number, y: number): number {
  if (y > 0) return x / y;
  return x > 0 ? Infinity : 0;
}

function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ];
}

function place(r: Row): string {
  return `${r.table.label} [R${r.table.regionIndex} L${r.table.roomLevel}]`;
}

/** A cell with auto-retreat skips can earn anything from nothing to its shown rate. */
function rangeOf(r: Row, value: number): string {
  return r.rate.skip > 0 ? `0..${fmt(value)}` : fmt(value);
}

function maxOf(values: readonly number[]): number {
  let top = NaN;
  for (const v of values) if (!(v <= top)) top = v;
  return top;
}

function minOf(values: readonly number[]): number {
  let low = NaN;
  for (const v of values) if (!(v >= low)) low = v;
  return low;
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

/** What this atlas can't see, printed beside what it reads about best rooms and who leads. */
export function coverageNotes(d: Data): string[] {
  const missing = MAGE_BARD_PARTIES.filter(id => !d.has(id));
  return [
    ...(missing.length ? [`This atlas doesn't hold the stacked Mage and Bard parties (${missing.join(', ')}). I1, I12, I13 and I14 can compare against too low a best room, and who leads, which parties have no purpose and who is dominated can all be wrong. A plan that passes only because they are missing has not passed: rebuild the atlas, which holds them from now on.`] : []),
    skillGrantNote(d.content),
  ];
}

export interface SkillGrant {
  source: string;
  kind: 'item' | 'set';
  skillClass: string | undefined;
  /** Classes that can use it. Empty: every class. */
  allowed: readonly string[];
  crossClass: boolean;
}

/** Every item and set in the snapshot that grants a skill, and whether it gives one class another's. */
export function skillGrants(content: XpSnapshot): SkillGrant[] {
  const skills = (content.skills ?? {}) as Record<string, { className?: string }>;
  const grant = (source: string, kind: SkillGrant['kind'], ids: readonly string[], allowed: readonly string[] | undefined): SkillGrant[] => ids.map(id => {
    const skillClass = skills[id]?.className;
    const classes = allowed ?? [];
    return { source, kind, skillClass, allowed: classes, crossClass: classes.length === 0 || classes.some(c => c !== skillClass) };
  });
  return [
    ...(Object.values(content.items ?? {}) as any[]).flatMap(item => grant(item.name ?? item.id, 'item', item.grantedSkillIds ?? [], item.classRestriction)),
    ...(Object.values(content.sets ?? {}) as any[]).flatMap(set => (set.breakpoints ?? []).flatMap((b: any) => grant(set.name ?? set.id, 'set', b.bonuses?.grantedSkillIds ?? [], set.classRestriction))),
  ];
}

/** Reads what the snapshot holds, so a card can't claim a grant is gone when it isn't. */
export function skillGrantNote(content: XpSnapshot): string {
  const grants = skillGrants(content);
  const cross = grants.filter(g => g.crossClass);
  const assumed = 'Plans assume no item grants another class\'s skill.';
  if (cross.length) return `${assumed} This snapshot still holds ${cross.length} that do (${cross.map(g => g.source).join(', ')}), so it predates that order. Default loadouts don't slot them, so what such builds reach and earn is not on this card.`;
  if (grants.length === 0) return `${assumed} This snapshot holds no grant at all, and default loadouts slot none.`;
  return `${assumed} Only ${grants.map(g => `the ${g.source} ${g.kind}`).join(' and ')} remains, ${grants.map(g => `a ${g.skillClass} skill for ${g.allowed.join(' and ')}s`).join(' and ')}, which default loadouts don't slot.`;
}

// --- I1 ---

export type WinGate = (d: Data, r: Row) => boolean;
const plainWin: WinGate = (_d, r) => r.rate.win >= WIN_OK_PCT;
const clearWin: WinGate = (d, r) => d.clearlyWon(r);
const plausibleWin: WinGate = (d, r) => d.plausiblyWon(r);

function wonRooms(d: Data, compId: string, level: number, keep?: (r: Row) => boolean, gate: WinGate = plainWin): Row[] {
  return d.at(compId, level).filter(r => r.table.kind === 'room' && gate(d, r) && !d.zero.has(r.table.index) && (!keep || keep(r)));
}

function hardestRoom(rooms: readonly Row[]): number {
  return Math.max(...rooms.map(r => r.table.roomLevel));
}

function partyGroup(comp: XpComp): string {
  if (comp.id === ARCHER_HIRED_KNIGHT) return ARCHER_HIRED_KNIGHT;
  if (typeof comp.hires === 'object' && 'fill' in comp.hires) return comp.members.length === 1 ? `solo + ${SOLO_FILL_HIRES} hires` : `2 humans + ${DUO_FILL_HIRES} hires`;
  if (comp.hires !== 'none') return 'solo + hires';
  return `${comp.members.length} humans`;
}

export interface BestPair {
  group: string;
  comp: XpComp;
  className: string;
  member: number;
  level: number;
  solo: Row;
  soloXp: number;
  /** Undefined: the party wins no paying room here. */
  party: Row | undefined;
  partyXp: number;
  ratio: number;
  /** Hardest room won minus solo's hardest. */
  reach: number;
  partyRooms: readonly Row[];
  soloRooms: readonly Row[];
}

export interface BestPairs {
  /** Each party at its best room against solo at solo's, hire-carried cells left out. */
  pairs: BestPair[];
  /** The same, using only the cells where a hire carries the party. */
  carried: BestPair[];
  noSoloRoom: number;
}

export function bestRoomPairs(d: Data, keep?: (r: Row) => boolean): BestPairs {
  const pairs: BestPair[] = [];
  const carried: BestPair[] = [];
  let noSoloRoom = 0;
  const parties = d.comps('core', 'extended', 'hired').filter(c => c.members.length >= 2 || c.hires !== 'none');
  for (const comp of parties) {
    for (const level of d.meta.grid) {
      const rooms = wonRooms(d, comp.id, level, keep, plausibleWin);
      const fair = rooms.filter(r => !d.hireCarried(r));
      const held = rooms.filter(r => d.hireCarried(r));
      const seen = new Set<string>();
      comp.members.forEach((m, member) => {
        if (seen.has(m.className)) return;
        seen.add(m.className);
        const soloRooms = wonRooms(d, SOLO_ID_BY_CLASS[m.className], level, keep, clearWin);
        const solo = maxBy(soloRooms, r => r.rate.xp[0]);
        if (!solo) {
          noSoloRoom++;
          return;
        }
        const pair = (list: readonly Row[]): BestPair => {
          const party = maxBy(list, r => r.rate.xp[member]);
          const partyXp = party?.rate.xp[member] ?? 0;
          return {
            group: partyGroup(comp), comp, className: m.className, member, level, solo, soloXp: solo.rate.xp[0], party, partyXp,
            ratio: safeRatio(partyXp, solo.rate.xp[0]),
            reach: list.length ? hardestRoom(list) - hardestRoom(soloRooms) : NaN,
            partyRooms: list,
            soloRooms,
          };
        };
        if (fair.length || held.length === 0) pairs.push(pair(fair));
        if (held.length) carried.push(pair(held));
      });
    }
  }
  return { pairs, carried, noSoloRoom };
}

function failsStrict(p: BestPair): boolean {
  return !(p.partyXp > p.soloXp);
}

function failsBeyondNoise(p: BestPair): boolean {
  return !(p.ratio >= 1 - NOISE_TOLERANCE);
}

function signedLevels(levels: number): string {
  const rounded = Math.round(levels);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function compactLevels(levels: readonly number[]): string {
  const sorted = [...new Set(levels)].sort((a, b) => a - b);
  if (sorted.length === 0) return '-';
  return sorted.length === 1 ? `L${sorted[0]}` : `L${sorted[0]}-${sorted[sorted.length - 1]} (${sorted.length} levels)`;
}

// --- The literal case ---

export interface LiteralCase {
  who: string;
  mobXp: number;
  soloXpHr: number;
  duoXpHr: number;
  ratio: number;
}

const LITERAL_LEVEL = 20;
const LITERAL_SOLO_MS = 5000;
const LITERAL_DUO_MS = 10000;
const LITERAL_MOB_XP = [8, 120, 2000];

function syntheticContext(plan: XpPlan, mod: any, level: number, humans: number, hires: number, rewardMultiplier: number, state: unknown, pauseMs = 0, tableExtras: Partial<XpTable> = {}): { member: MemberView; ctx: PayoutContext } {
  const classes = ['Archer', 'Knight', 'Priest', 'Mage', 'Bard'] as const;
  const members: MemberView[] = Array.from({ length: humans }, (_, index) => ({ index, className: classes[index], level, role: 'member' as const }));
  const table = { index: 0, key: 'synthetic', kind: 'room', label: 'synthetic', roomLevel: level, boss: false, bossShare: 0, strata: [], entries: [], regionIndex: 0, zeroXp: false, starterZone: false, ...tableExtras } as unknown as XpTable;
  const hireDetails = Array.from({ length: hires }, (_, i) => ({ id: `hire${i}`, className: 'Knight' as const, level }));
  return {
    member: members[0],
    ctx: {
      party: { compId: 'synthetic', family: 'core', members, hires: hireDetails.map(h => h.id), hireDetails, shareCount: humans + hires, xpMultiplier: 1 },
      table,
      rewardMultiplier,
      pauseMs,
      params: plan.params ?? {},
      state,
      rules: xpRulesOf(mod),
    },
  };
}

function syntheticMob(xp: number, level: number): MonsterInfo {
  return { id: 'mob', xp, hp: 1000, maxHp: 1000, damage: 100, level, levelSource: 'authored', authored: true, tier: 'trash', passive: false };
}

function syntheticFight(mobs: number, mobXp: number, level: number, realMs: number): FightView {
  return {
    result: 'victory', won: true, realMs, partyDamage: mobs * 1000, minHpFrac: 0.5, deaths: 0, pastHorizon: false, encounterId: null,
    monsters: [{ def: syntheticMob(mobXp, level), killed: mobs, standing: 0 }],
  };
}

function syntheticPay(plan: XpPlan, fight: FightView, member: MemberView, ctx: PayoutContext): number {
  const xp = plan.payout(fight, member, ctx);
  if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) throw new Error(`plan ${plan.id} paid ${String(xp)} on a synthetic fight, whose table it hasn't seen: payout must return a finite number, zero or more`);
  return xp;
}

/** What a member earns on the same fight holding this XP multiplier, over holding none. `xp_bonus` is a perk no plan may cap. NaN: the plan pays nothing on this fight either way. */
export function xpBonusProbe(plan: XpPlan, mod: any, rewardMultiplier: number, multiplier: number, state?: unknown): number {
  const { member, ctx } = syntheticContext(plan, mod, LITERAL_LEVEL, 1, 0, rewardMultiplier, state);
  const fight = syntheticFight(1, 100000, LITERAL_LEVEL, LITERAL_SOLO_MS);
  const plain = syntheticPay(plan, fight, member, ctx);
  const boosted = syntheticPay(plan, fight, member, { ...ctx, party: { ...ctx.party, xpMultiplier: multiplier } });
  return plain > 0 ? boosted / plain : NaN;
}

/** Whether a lost fight pays anything, at any room level above the member. */
export function paysLostFights(plan: XpPlan, mod: any, rewardMultiplier: number, state?: unknown): boolean {
  return LOST_FIGHT_PROBE_GAPS.some(gap => {
    const roomLevel = LITERAL_LEVEL + gap;
    const { member, ctx } = syntheticContext(plan, mod, LITERAL_LEVEL, 1, 0, rewardMultiplier, state, 0, { roomLevel });
    const fight: FightView = {
      result: 'defeat', won: false, realMs: LITERAL_DUO_MS, partyDamage: 1000, minHpFrac: 0, deaths: 1, pastHorizon: false, encounterId: null,
      monsters: [{ def: syntheticMob(100000, roomLevel), killed: 1, standing: 1 }],
    };
    return syntheticPay(plan, fight, member, ctx) > 0;
  });
}

/** An Archer kills one mob in 5 s alone; with a Knight, two in 10 s. Pack sizes don't scale in the game, so this is synthetic. */
export function literalCases(plan: XpPlan, mod: any, pauseMs: number, rewardMultiplier: number, state?: unknown): LiteralCase[] {
  const perHour = (xp: number, ms: number): number => (xp / (ms + pauseMs)) * HOUR_MS;
  const solo = syntheticContext(plan, mod, LITERAL_LEVEL, 1, 0, rewardMultiplier, state, pauseMs);
  const hired = syntheticContext(plan, mod, LITERAL_LEVEL, 1, 1, rewardMultiplier, state, pauseMs);
  const human = syntheticContext(plan, mod, LITERAL_LEVEL, 2, 0, rewardMultiplier, state, pauseMs);
  return LITERAL_MOB_XP.flatMap(mobXp => [{ who: 'hired Knight', duo: hired }, { who: 'human Knight', duo: human }].map(({ who, duo }) => {
    const soloXpHr = perHour(syntheticPay(plan, syntheticFight(1, mobXp, LITERAL_LEVEL, LITERAL_SOLO_MS), solo.member, solo.ctx), LITERAL_SOLO_MS);
    const duoXpHr = perHour(syntheticPay(plan, syntheticFight(2, mobXp, LITERAL_LEVEL, LITERAL_DUO_MS), duo.member, duo.ctx), LITERAL_DUO_MS);
    return { who, mobXp, soloXpHr, duoXpHr, ratio: duoXpHr / soloXpHr };
  }));
}

/** Each extra body's effect on one member's pay for a fixed fight, and the kill-speed multiple that pays it back in the same room. */
export function shareCurve(plan: XpPlan, mod: any, rewardMultiplier: number, state?: unknown): { bodies: number; humanShare: number; hireShare: number }[] {
  const mobXp = 100000;
  const pay = (humans: number, hires: number): number => {
    const { member, ctx } = syntheticContext(plan, mod, LITERAL_LEVEL, humans, hires, rewardMultiplier, state);
    return syntheticPay(plan, syntheticFight(1, mobXp, LITERAL_LEVEL, LITERAL_SOLO_MS), member, ctx);
  };
  const base = pay(1, 0);
  return [2, 3, 4, 5].map(bodies => ({ bodies, humanShare: pay(bodies, 0) / base, hireShare: pay(1, bodies - 1) / base }));
}

export interface LiteralFeasibility {
  /** Flat pay share for two bodies at which the pair just matches solo. */
  share: number;
  /** The same in (1 + b(n - 1)) / n. */
  bonus: number;
  /** The same in n^-beta. */
  beta: number;
}

/** Twice the mobs in twice the time earn the same kill rate, so a pair beats solo only through the shared pause between fights. */
export function literalFeasibility(pauseMs: number): LiteralFeasibility {
  const share = (LITERAL_DUO_MS + pauseMs) / (LITERAL_SOLO_MS + pauseMs) / 2;
  return { share, bonus: 2 * share - 1, beta: -Math.log2(share) };
}

export function metricLiteral(d: Data): Metric {
  if (!d.plan) return { id: 'I1c', title: 'Literal case', pass: null, magnitude: 'not run: the plan file is not known', lines: [] };
  const cases = literalCases(d.plan, d.mod, d.meta.pauseMs, d.meta.rewardMultiplier, d.planState);
  const curve = shareCurve(d.plan, d.mod, d.meta.rewardMultiplier, d.planState);
  const need = literalFeasibility(d.meta.pauseMs);
  const worst = minOf(cases.map(c => c.ratio));
  const atShare = (share: number): (string | number)[] => [share.toFixed(3), ratio(share / need.share), share < need.share ? ratio(need.share / share) : 'none'];
  return {
    id: 'I1c',
    title: 'Literal case',
    pass: cases.every(c => c.ratio > 1),
    short: `worst ${ratio(worst)}`,
    values: { worstRatio: worst, humanShare: curve[0].humanShare, hireShare: curve[0].hireShare, shareNeeded: need.share },
    magnitude: `Archer + Knight two mobs in ${LITERAL_DUO_MS / 1000} s against the Archer one mob in ${LITERAL_SOLO_MS / 1000} s pays ${ratio(worst)} at worst; flat pay needs a share over ${need.share.toFixed(3)} for two bodies (b over ${need.bonus.toFixed(3)}, beta under ${need.beta.toFixed(3)}), and this plan's is ${curve[0].humanShare.toFixed(3)} human, ${curve[0].hireShare.toFixed(3)} hire`,
    lines: [
      `On synthetic fights, because no room is the same mob twice: an Archer kills one mob in ${LITERAL_SOLO_MS / 1000} s alone, or two with a Knight in ${LITERAL_DUO_MS / 1000} s, with the ${d.meta.pauseMs} ms pause after each fight, at level ${LITERAL_LEVEL} against level ${LITERAL_LEVEL} mobs. The Archer must earn more with the Knight. Its own line in the verdicts, so a plan failing it keeps its other results readable.`,
      '',
      ...table(['Knight', 'XP per mob', 'solo XP/hr', 'with Knight XP/hr', 'ratio'], cases.map(c => [c.who, c.mobXp, fmt(c.soloXpHr), fmt(c.duoXpHr), ratio(c.ratio)])),
      '',
      `**What passing takes.** The pair has the same kill rate as solo and shares the pause over two mobs, so with no pause no split is exactly 1.00x, and the whole margin is the pause. Flat pay per body passes only above a share of (${LITERAL_DUO_MS} + ${d.meta.pauseMs}) / (${LITERAL_SOLO_MS} + ${d.meta.pauseMs}) / 2 = ${need.share.toFixed(3)} for two bodies, which is b over ${need.bonus.toFixed(3)} in (1 + b(n-1))/n, or beta under ${need.beta.toFixed(3)} in n^-beta. Rounding up each fight's pay, as the game does, moves that a little on mobs worth single digits. Below it, the two-mob pack itself must pay extra, as the last column says. A sweep of b around 0.2 fails this line by construction. Whether to pay near full per body, or reward fielding a bigger pack, is a design choice.`,
      '',
      ...table(['share for two bodies', 'literal ratio, flat pay', 'extra pay the two-mob pack needs'], [0.5, 0.6, 0.625, 0.75, need.share, 1].map(atShare)),
      '',
      'This plan: pay for one member for the same fight as bodies join, and the kill-speed multiple at which the party out-earns solo in the same room, ignoring the pause (1 / share):',
      '',
      ...table(['bodies', 'share, humans', 'kill-speed multiple', 'share, 1 human + hires', 'kill-speed multiple'], curve.map(c => [c.bodies, c.humanShare.toFixed(3), ratio(1 / c.humanShare), c.hireShare.toFixed(3), ratio(1 / c.hireShare)])),
    ],
  };
}

// --- I1 metric ---

function bandLimited(d: Data): { comp: XpComp; level: number; hardest: number; top: number }[] {
  const found: { comp: XpComp; level: number; hardest: number; top: number }[] = [];
  const paying = d.meta.tables.filter(t => t.kind === 'room' && !d.zero.has(t.index));
  for (const comp of d.comps('core', 'extended', 'hired')) {
    for (const level of d.meta.grid) {
      const rooms = wonRooms(d, comp.id, level);
      if (rooms.length === 0) continue;
      const top = level - comp.band[0];
      const hardest = hardestRoom(rooms);
      if (hardest < top - 1) continue;
      const lowest = Math.min(...comp.members.map(m => level + m.levelOffset));
      if (paying.some(t => t.roomLevel > top && memberReaches(t, lowest))) found.push({ comp, level, hardest, top });
    }
  }
  return found;
}

function sameRoomLines(d: Data): string[] {
  const pairs: { ratio: number; group: string }[] = [];
  for (const r of d.rows) {
    if (r.table.kind !== 'room' || !['core', 'extended', 'hired'].includes(r.comp.family) || r.members.length + r.cell.hires.length < 2) continue;
    r.members.forEach((m, i) => {
      const solo = d.get(r.table.index, SOLO_ID_BY_CLASS[m.className as keyof typeof SOLO_ID_BY_CLASS], m.level);
      if (!solo || solo.rate.win < WIN_OK_PCT || !(solo.rate.xp[0] > 0)) return;
      pairs.push({ ratio: r.rate.xp[i] / solo.rate.xp[0], group: partyGroup(r.comp) });
    });
  }
  const groups = [...new Set(pairs.map(p => p.group))].sort();
  return [
    `Same room, for information only: member XP/hr in a party against the same class and level solo, wherever solo wins at least ${WIN_OK_PCT} %. A party that doesn't kill faster may earn less per member here, and that is acceptable.`,
    '',
    ...table(['party', 'pairs', 'party not more', 'median ratio', 'p5', 'p95'], groups.map(g => {
      const list = pairs.filter(p => p.group === g).map(p => p.ratio);
      return [g, list.length, list.filter(x => !(x > 1)).length, ratio(median(list)), ratio(quantile(list, 0.05)), ratio(quantile(list, 0.95))];
    })),
  ];
}

function bestAt(rows: readonly Row[], member = 0): Row | undefined {
  return maxBy(rows, r => r.rate.xp[member]);
}

function archerHiredKnightLines(d: Data): string[] {
  if (!d.has(ARCHER_HIRED_KNIGHT)) return ['Archer + hired Knight: not in this atlas.'];
  const defaultId = `${DEFAULT_SEAT_PREFIX}${ARCHER_HIRED_KNIGHT}`;
  const rows = d.meta.grid.map(level => {
    const solos = wonRooms(d, 'A', level, undefined, clearWin);
    const hired = wonRooms(d, ARCHER_HIRED_KNIGHT, level, undefined, plausibleWin);
    const soloDefault = wonRooms(d, `${DEFAULT_SEAT_PREFIX}A`, level, undefined, clearWin);
    const hiredDefault = wonRooms(d, defaultId, level, undefined, plausibleWin);
    const unlocked = hired.filter(h => {
      const s = d.get(h.table.index, 'A', level);
      return !s || !d.clearlyWon(s);
    });
    return { level, solos, hired, soloDefault, hiredDefault, unlocked, bestSolo: bestAt(solos), bestHired: bestAt(hired), bestSoloDefault: bestAt(soloDefault), bestHiredDefault: bestAt(hiredDefault), bestUnlocked: bestAt(unlocked) };
  }).filter(x => x.bestSolo || x.bestHired);
  const under = (a: Row | undefined, b: Row | undefined): boolean => !!a && (!b || b.rate.xp[0] <= a.rate.xp[0]);
  const placedFails = rows.filter(x => under(x.bestSolo, x.bestHired)).length;
  const defaultFails = rows.filter(x => under(x.bestSoloDefault, x.bestHiredDefault)).length;
  const compIndex = d.meta.comps.findIndex(c => c.id === ARCHER_HIRED_KNIGHT);
  const noKnight = [...new Set(d.cells.filter(c => c.comp === compIndex && d.meta.tables[c.table].kind === 'room' && c.ineligible && !c.ineligible.startsWith(REACH_REFUSAL)).map(c => `R${d.meta.tables[c.table].regionIndex} ${d.meta.tables[c.table].regionName}`))];
  const pct = (x: number | undefined): string | number => x ?? '-';
  return [
    `**Archer + hired Knight, by name**, each at its own best room won at least ${WIN_OK_PCT} %, under both seatings. Placed: the player moves the Knight to the front and the Archer behind him. Default: nobody moves anyone, so the Archer stays in the centre and the Knight lands in a back corner. "Unlocked" rooms are the case under test: the Archer can't win them alone, the pair can. The pair earns no more than solo at ${placedFails} of ${rows.length} levels placed, and at ${defaultFails} left in default seats (each against the Archer in the same seating). Automatic hire seating by class would close that gap; that is a game change, not a plan.${noKnight.length ? ` No Knight hire is offered on: ${noKnight.join(', ')}; those rooms have no A+hK cells.` : ''}`,
    '',
    ...table(['level', 'best solo XP/hr', 'best A+hK XP/hr', 'ratio', 'reach over solo', 'A+hK win %', 'unlocked rooms', 'best unlocked XP/hr', 'unlocked vs solo', 'default seats: solo', 'A+hK', 'ratio', 'A+hK win %'], rows.map(x => [
      x.level,
      x.bestSolo ? rangeOf(x.bestSolo, x.bestSolo.rate.xp[0]) : '-',
      x.bestHired ? rangeOf(x.bestHired, x.bestHired.rate.xp[0]) : '-',
      x.bestSolo && x.bestHired ? ratio(x.bestHired.rate.xp[0] / x.bestSolo.rate.xp[0]) : '-',
      x.solos.length && x.hired.length ? signedLevels(hardestRoom(x.hired) - hardestRoom(x.solos)) : '-',
      pct(x.bestHired?.rate.win),
      x.unlocked.length,
      x.bestUnlocked ? fmt(x.bestUnlocked.rate.xp[0]) : '-',
      x.bestSolo && x.bestUnlocked ? ratio(x.bestUnlocked.rate.xp[0] / x.bestSolo.rate.xp[0]) : '-',
      x.bestSoloDefault ? fmt(x.bestSoloDefault.rate.xp[0]) : '-',
      x.bestHiredDefault ? fmt(x.bestHiredDefault.rate.xp[0]) : '-',
      x.bestSoloDefault && x.bestHiredDefault ? ratio(x.bestHiredDefault.rate.xp[0] / x.bestSoloDefault.rate.xp[0]) : '-',
      pct(x.bestHiredDefault?.rate.win),
    ])),
  ];
}

function seatingLines(d: Data): string[] {
  const comps = d.comps('seating');
  if (comps.length === 0) return ['Default seats: not in this atlas.'];
  const rows = comps.map(comp => {
    const ratios: number[] = [];
    let wonPlaced = 0;
    let lostByDefault = 0;
    for (const level of d.meta.grid) {
      for (const row of d.at(comp.id, level)) {
        if (row.table.kind !== 'room') continue;
        const placed = d.get(row.table.index, comp.reference!, level);
        if (!placed || placed.rate.win < WIN_OK_PCT || !(placed.xp > 0)) continue;
        wonPlaced++;
        if (row.rate.win < WIN_OK_PCT) lostByDefault++;
        ratios.push(row.xp / placed.xp);
      }
    }
    const placedBest = d.meta.grid.map(level => bestAt(wonRooms(d, comp.reference!, level)));
    const defaultBest = d.meta.grid.map(level => bestAt(wonRooms(d, comp.id, level)));
    const bestRatios = placedBest.flatMap((p, i) => (p && defaultBest[i] ? [defaultBest[i]!.rate.xp[0] / p.rate.xp[0]] : []));
    return [comp.id, wonPlaced, ratio(median(ratios)), ratio(quantile(ratios, 0.1)), `${((100 * lostByDefault) / Math.max(1, wonPlaced)).toFixed(1)} %`, ratio(median(bestRatios)), ratio(minOf(bestRatios))];
  });
  return [
    'Default seats against placed seats, same party. The placed numbers everywhere else on this card hold only once the player has moved the party.',
    '',
    ...table(['party, default seats', 'cells placed wins', 'median XP/hr vs placed', 'p10', 'of those no longer won', 'best room vs placed, median', 'worst level'], rows),
  ];
}

export function metricI1(d: Data): Metric {
  const { pairs, carried, noSoloRoom } = bestRoomPairs(d);
  const strict = pairs.filter(failsStrict);
  const beyond = pairs.filter(failsBeyondNoise);
  const safe = bestRoomPairs(d, r => r.rate.skip === 0).pairs;
  const noRoom = pairs.filter(p => !p.party).length;
  const groups = [...new Set(pairs.map(p => p.group))].sort();
  const groupRow = (list: readonly BestPair[], g: string): (string | number)[] => {
    const here = list.filter(p => p.group === g);
    const ratios = here.map(p => p.ratio);
    const reach = here.map(p => p.reach).filter(Number.isFinite);
    return [
      g,
      here.length,
      here.filter(failsStrict).length,
      here.filter(failsBeyondNoise).length,
      here.filter(p => p.level >= JOURNEYER_MIN_LEVEL && failsStrict(p)).length,
      ratio(median(ratios)),
      ratio(quantile(ratios, 0.1)),
      ratio(quantile(ratios, 0.9)),
      reach.length ? signedLevels(median(reach)) : '-',
      reach.length ? `${signedLevels(quantile(reach, 0.1))}..${signedLevels(quantile(reach, 0.9))}` : '-',
    ];
  };
  const classLevels = new Map<string, BestPair[]>();
  for (const p of pairs) push(classLevels, `${p.className}|${p.level}`, p);
  const noneBeat = [...classLevels.values()].filter(list => list.every(failsStrict));
  const noneBeatByClass = [...new Set(noneBeat.map(list => list[0].className))].sort().map(c => `${c} ${compactLevels(noneBeat.filter(l => l[0].className === c).map(l => l[0].level))}`);
  const limited = bandLimited(d);
  const onLine = pairs.filter(p => p.party && p.party.rate.win < WIN_OK_PCT).length;
  const hiredHeaders = ['party', 'pairs', 'best no more than solo', `by over ${NOISE_TOLERANCE * 100} %`, `no more, level ${JOURNEYER_MIN_LEVEL}+`, 'median best / best', 'p10', 'p90', 'reach, median', 'reach, p10..p90'];
  return {
    id: 'I1',
    title: 'Party\'s best room beats solo\'s best room',
    pass: pairs.length ? beyond.length === 0 : null,
    short: `${beyond.length}/${pairs.length} under by over ${NOISE_TOLERANCE * 100} %`,
    values: { pairs: pairs.length, noMore: strict.length, underBeyondNoise: beyond.length, noMoreLevel10Up: strict.filter(p => p.level >= JOURNEYER_MIN_LEVEL).length, noPartyBeats: noneBeat.length, classLevels: classLevels.size, hiredKnightNoMore: pairs.filter(p => p.group === ARCHER_HIRED_KNIGHT && failsStrict(p)).length, medianRatio: median(pairs.map(p => p.ratio)) },
    magnitude: `best room against best room per class, level and party: ${strict.length}/${pairs.length} pay no more than solo's best (${beyond.length} by over ${NOISE_TOLERANCE * 100} %), ${strict.filter(p => p.level >= JOURNEYER_MIN_LEVEL).length}/${pairs.filter(p => p.level >= JOURNEYER_MIN_LEVEL).length} at level ${JOURNEYER_MIN_LEVEL}+; no party beats solo at ${noneBeat.length}/${classLevels.size} class + level pairs; A+hK no more at ${pairs.filter(p => p.group === ARCHER_HIRED_KNIGHT && failsStrict(p)).length}/${pairs.filter(p => p.group === ARCHER_HIRED_KNIGHT).length} levels`,
    lines: [
      ...coverageNotes(d),
      '',
      `For class C at level L: the best paying room solo C wins at least ${WIN_OK_PCT} %, against the best paying room each party containing C wins at least ${WIN_OK_PCT} %, paying C. The party's rooms need not be solo's. Passes with no pair under by over ${NOISE_TOLERANCE * 100} %; I1c scores the literal case on its own. ${noSoloRoom} class + level + party pairs have no solo room to compare. ${noRoom} pairs have a solo room but no party room won, and count as under. ${onLine} party rooms are on the win line, read under ${WIN_OK_PCT} % with an interval reaching it. Hire-carried cells, where a hire is at least ${HIRE_CARRY_GAP} levels above the lowest human, are out of this table and shown below.`,
      '',
      `No party beats solo at: ${noneBeatByClass.join('; ') || 'nowhere'}.`,
      '',
      `Requiring every best room to be free of auto-retreat skips: ${safe.filter(failsStrict).length}/${safe.length} pairs pay no more (${safe.filter(failsBeyondNoise).length} by over ${NOISE_TOLERANCE * 100} %).`,
      '',
      ...table(hiredHeaders, groups.map(g => groupRow(pairs, g))),
      '',
      `Reach is the hardest room won by the party, in levels over the hardest room solo wins. ${limited.length} party + level pairs have a won room within 1 of the top of their band with harder paying rooms outside it${limited.length ? `: ${limited.slice(0, TOP_OFFENDERS).map(x => `${x.comp.id} L${x.level}`).join(', ')}${limited.length > TOP_OFFENDERS ? ', ...' : ''}` : ''}.`,
      '',
      `Hire-carried cells, reported separately (hires are free within the hire level limit, so these are open to any player who reaches the map):`,
      '',
      ...table(hiredHeaders, [...new Set(carried.map(p => p.group))].sort().map(g => groupRow(carried, g))),
      '',
      'Worst offenders, best room against best room:',
      '',
      ...table(['party', 'member', 'level', 'party room', 'party XP/hr', 'solo room', 'solo XP/hr', 'ratio'], [...strict].sort((a, b) => a.ratio - b.ratio).slice(0, TOP_OFFENDERS).map(p => [
        p.comp.id, p.className, p.level, p.party ? place(p.party) : 'none won', p.party ? rangeOf(p.party, p.partyXp) : '-', place(p.solo), rangeOf(p.solo, p.soloXp), ratio(p.ratio),
      ])),
      '',
      ...archerHiredKnightLines(d),
      '',
      ...seatingLines(d),
      '',
      ...sameRoomLines(d),
    ],
  };
}

// --- I1b ---

interface MemberAddition {
  added: string;
  base: string;
  level: number;
  member: string;
  before: number;
  after: number;
  ratio: number;
  /** Where the raise comes from: the new party's best room is one the old party also wins (speed) or can't (reach). */
  source: 'speed' | 'reach' | 'none';
  beforeRow: Row;
  afterRow: Row | undefined;
  beforeRooms: readonly Row[];
  afterRooms: readonly Row[];
  beforeMember: number;
  afterMember: number;
}

function distinctClassParties(d: Data): XpComp[] {
  return d.comps('core', 'extended').filter(c => c.hires === 'none' && new Set(c.members.map(m => m.className)).size === c.members.length);
}

function classesKey(classes: readonly string[]): string {
  return [...classes].sort().join('+');
}

/** `skipUnavailable`: a level where `next` has no cells at all, such as before xp_bonus unlocks, isn't a comparison. */
function compareAddition(d: Data, base: XpComp, next: XpComp, added: string, results: MemberAddition[], skipUnavailable = false): void {
  for (const level of d.meta.grid) {
    const before = wonRooms(d, base.id, level, undefined, clearWin);
    const after = wonRooms(d, next.id, level, undefined, plausibleWin);
    if (before.length === 0 || (skipUnavailable && d.at(next.id, level).length === 0)) continue;
    base.members.forEach((m, i) => {
      const j = next.members.findIndex(x => x.className === m.className);
      const bestBefore = maxBy(before, r => r.rate.xp[i])!;
      const bestAfter = maxBy(after, r => r.rate.xp[j]);
      const xpBefore = bestBefore.rate.xp[i];
      const xpAfter = bestAfter?.rate.xp[j] ?? 0;
      if (!(xpBefore > 0)) return;
      const oldParty = bestAfter ? d.get(bestAfter.table.index, base.id, level) : undefined;
      const source = !bestAfter ? 'none' : oldParty && oldParty.rate.win >= WIN_OK_PCT ? 'speed' : 'reach';
      results.push({ added, base: base.id, level, member: m.className, before: xpBefore, after: xpAfter, ratio: xpAfter / xpBefore, source, beforeRow: bestBefore, afterRow: bestAfter, beforeRooms: before, afterRooms: after, beforeMember: i, afterMember: j });
    });
  }
}

function additionRows(d: Data): MemberAddition[] {
  const subsets = distinctClassParties(d);
  const byClasses = new Map(subsets.map(c => [classesKey(c.members.map(m => m.className)), c]));
  const results: MemberAddition[] = [];
  const compare = (base: XpComp, next: XpComp, added: string): void => compareAddition(d, base, next, added, results);
  for (const base of subsets) {
    for (const className of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
      if (base.members.some(m => m.className === className)) continue;
      const next = byClasses.get(classesKey([...base.members.map(m => m.className), className]));
      if (next) compare(base, next, className);
    }
  }
  for (const id of SOLO_IDS) {
    const base = d.meta.comps.find(c => c.id === id);
    const hired = d.meta.comps.find(c => c.id === `${id}+hires`);
    if (base && hired) compare(base, hired, 'the usual hires');
  }
  const archer = d.meta.comps.find(c => c.id === 'A');
  const hiredKnight = d.meta.comps.find(c => c.id === ARCHER_HIRED_KNIGHT);
  if (archer && hiredKnight) compare(archer, hiredKnight, 'a hired Knight, for the Archer');
  return results;
}

const BARD_WITH_BONUS = 'Bard with xp_bonus';

/** The same additions of a Bard, wearing xp_bonus, wherever the atlas holds that party. The default loadout never picks it. */
function bonusAdditionRows(d: Data): MemberAddition[] {
  const subsets = distinctClassParties(d);
  const byClasses = new Map(subsets.map(c => [classesKey(c.members.map(m => m.className)), c]));
  const results: MemberAddition[] = [];
  for (const base of subsets) {
    if (base.members.some(m => m.className === 'Bard')) continue;
    const plain = byClasses.get(classesKey([...base.members.map(m => m.className), 'Bard']));
    const withPerk = plain && d.meta.comps.find(c => c.id === `${XP_BONUS_PREFIX}${plain.id}`);
    if (withPerk) compareAddition(d, base, withPerk, BARD_WITH_BONUS, results, true);
  }
  return results;
}

function additionKey(r: MemberAddition): string {
  return `${r.base}|${r.level}|${r.member}`;
}

export function metricI1b(d: Data): Metric {
  const rows = additionRows(d);
  const withPerk = bonusAdditionRows(d);
  const perkAt = new Map(withPerk.map(r => [additionKey(r), r]));
  const rescuedByPerk = (r: MemberAddition): boolean => r.added === 'Bard' && (perkAt.get(additionKey(r))?.ratio ?? 0) >= 1 - NOISE_TOLERANCE;
  const lower = rows.filter(r => !(r.ratio > 1));
  const underNoise = rows.filter(r => r.ratio < 1 - NOISE_TOLERANCE);
  const beyond = underNoise.filter(r => !rescuedByPerk(r));
  const rescued = underNoise.length - beyond.length;
  const additions = [...new Set(rows.map(r => r.added))];
  const bardLike = rows.filter(r => r.added === 'Bard' && perkAt.has(additionKey(r)));
  const perkFrom = Math.min(...d.meta.comps.filter(c => c.xpBonus).flatMap(c => d.meta.grid.filter(level => d.at(c.id, level).length > 0)));
  const bardFailing = underNoise.filter(r => r.added === 'Bard');
  const perkUntested = bardFailing.filter(r => r.level >= perkFrom && !perkAt.has(additionKey(r)));
  const stacked = d.comps('core', 'extended').filter(c => c.hires === 'none' && new Set(c.members.map(m => m.className)).size < c.members.length).map(c => c.id);
  const loadoutRow = (label: string, list: readonly MemberAddition[]): (string | number)[] => {
    const raises = list.filter(r => r.ratio > 1);
    return [label, list.length, list.filter(r => !(r.ratio > 1)).length, list.filter(r => r.ratio < 1 - NOISE_TOLERANCE).length, ratio(median(list.map(r => r.ratio))), ratio(quantile(list.map(r => r.ratio), 0.1)), raises.filter(r => r.source === 'speed').length, raises.filter(r => r.source === 'reach').length];
  };
  return {
    id: 'I1b',
    title: 'Every member helps',
    pass: rows.length ? beyond.length === 0 : null,
    short: `${beyond.length}/${rows.length} lower by over ${NOISE_TOLERANCE * 100} %`,
    values: { pairs: rows.length, lowers: lower.length, lowersBeyondNoise: beyond.length, rescuedByBonus: rescued, medianRatio: median(rows.map(r => r.ratio)), bardFailuresUntestedWithBonus: perkUntested.length, bonusPairs: withPerk.length, bonusLowers: withPerk.filter(r => r.ratio < 1 - NOISE_TOLERANCE).length, bonusMedianRatio: median(withPerk.map(r => r.ratio)) },
    magnitude: `adding a member lowers an existing member's best-room XP/hr at ${lower.length}/${rows.length} pairs (${beyond.length} by over ${NOISE_TOLERANCE * 100} %, after ${rescued} Bard additions that xp_bonus lifts back within it), median ratio ${ratio(median(rows.map(r => r.ratio)))}; a Bard wearing xp_bonus lowers ${withPerk.filter(r => r.ratio < 1 - NOISE_TOLERANCE).length}/${withPerk.length} of the pairs the atlas holds, median ${ratio(median(withPerk.map(r => r.ratio)))}`,
    lines: [
      `For each party of distinct classes and each class that could join it, and for the usual hires: existing members' XP/hr at the party's best room won at least ${WIN_OK_PCT} %, before and after. Under-levelled friends in a carry are under I9. "Speed" means the new party's best room is one the old party also won; "reach" means the old party couldn't win it. A healer or tank that raises pay through reach is doing its job.`,
      '',
      `A Bard's worth includes xp_bonus once it unlocks, and the default loadout never picks it, so Bard additions are scored both ways wherever the atlas holds the party with the perk. A Bard addition counts against the verdict only if it lowers XP/hr by over ${NOISE_TOLERANCE * 100} % on both loadouts:`,
      '',
      ...table(['Bard addition, loadout', 'pairs', 'lowers', `by over ${NOISE_TOLERANCE * 100} %`, 'median ratio', 'p10', 'raises by speed', 'raises by reach'], [
        loadoutRow('default, every pair', rows.filter(r => r.added === 'Bard')),
        loadoutRow('default, pairs with an xp_bonus twin', bardLike),
        loadoutRow('xp_bonus', withPerk),
      ]),
      '',
      `${bardFailing.length} Bard additions lower pay by over ${NOISE_TOLERANCE * 100} %. ${perkUntested.length} of them are at levels where the perk is unlocked but this atlas has no such party wearing it, so they count without being scored with it.`,
      '',
      `Not scored: additions to or of parties with a repeated class${stacked.length ? ` (${stacked.join(', ')})` : ''}, because the atlas holds no party one member away from them. These are an open gap in "each party".`,
      '',
      ...table(['addition', 'pairs', 'lowers', `by over ${NOISE_TOLERANCE * 100} %`, 'median ratio', 'p10', 'raises by speed', 'raises by reach', 'lowers at'], additions.map(added => {
        const list = rows.filter(r => r.added === added);
        const bad = list.filter(r => r.ratio < 1 - NOISE_TOLERANCE);
        const raises = list.filter(r => r.ratio > 1);
        return [added, list.length, list.filter(r => !(r.ratio > 1)).length, bad.length, ratio(median(list.map(r => r.ratio))), ratio(quantile(list.map(r => r.ratio), 0.1)), raises.filter(r => r.source === 'speed').length, raises.filter(r => r.source === 'reach').length, compactLevels(bad.map(r => r.level))];
      })),
      '',
      'By existing party size:',
      '',
      ...table(['existing party', 'pairs', `lowers by over ${NOISE_TOLERANCE * 100} %`, 'median ratio'], [...new Set(rows.map(r => r.base.split('+').length))].sort((a, b) => a - b).map(size => {
        const list = rows.filter(r => r.base.split('+').length === size);
        return [`${size} members`, list.length, list.filter(r => r.ratio < 1 - NOISE_TOLERANCE).length, ratio(median(list.map(r => r.ratio)))];
      })),
      '',
      'Worst additions:',
      '',
      ...table(['existing party', 'adds', 'level', 'member', 'before XP/hr', 'after XP/hr', 'ratio'], [...lower].sort((a, b) => a.ratio - b.ratio).slice(0, TOP_OFFENDERS).map(r => [r.base, r.added, r.level, r.member, fmt(r.before), fmt(r.after), ratio(r.ratio)])),
    ],
  };
}

// --- I2 ---

interface BackwardsPair {
  comp: string;
  level: number;
  low: Row;
  ref: Row;
  ratio: number;
  lowRooms: readonly Row[];
  refRooms: readonly Row[];
}

function backwardsPairs(d: Data): { pairs: BackwardsPair[]; noReference: number } {
  const pairs: BackwardsPair[] = [];
  let noReference = 0;
  for (const comp of d.comps('core', 'extended', 'hired')) {
    for (const level of d.meta.grid) {
      const rows = d.at(comp.id, level).filter(r => r.table.kind === 'room');
      const lowRooms = rows.filter(r => r.table.roomLevel <= level - BACKWARDS_GAP);
      const low = maxBy(lowRooms, r => r.xp);
      if (!low || low.xp === 0) continue;
      const refRooms = rows.filter(r => Math.abs(r.table.roomLevel - level) <= ON_LEVEL_BAND && d.plausiblyWon(r));
      const ref = maxBy(refRooms, r => r.xp);
      if (!ref) {
        noReference++;
        continue;
      }
      pairs.push({ comp: comp.id, level, low, ref, ratio: low.xp / ref.xp, lowRooms, refRooms });
    }
  }
  return { pairs, noReference };
}

export function metricI2(d: Data): Metric {
  const { pairs, noReference } = backwardsPairs(d);
  const tested = pairs.length;
  const offenders = pairs.filter(o => o.ratio > 1);
  const beyond = offenders.filter(o => o.ratio > 1 + NOISE_TOLERANCE);
  const zeroReference = offenders.filter(o => o.ref.xp === 0);
  const paying = offenders.filter(o => o.ref.xp > 0).sort((a, b) => b.ratio - a.ratio);
  const row = (o: typeof offenders[number]): (string | number)[] => [o.comp, o.level, place(o.low), rangeOf(o.low, o.low.xp), place(o.ref), rangeOf(o.ref, o.ref.xp), ratio(o.ratio)];
  const headers = ['composition', 'level', 'low room', 'XP/hr', 'best on-level room', 'XP/hr', 'ratio'];
  return {
    id: 'I2',
    title: 'No backwards',
    pass: tested ? beyond.length === 0 : null,
    short: `${beyond.length}/${tested} over by over ${NOISE_TOLERANCE * 100} %, worst ${ratio(maxOf(paying.map(o => o.ratio)))}`,
    values: { pairs: tested, earnMore: offenders.length, overBeyondNoise: beyond.length, worstRatio: maxOf(paying.map(o => o.ratio)), onLevelPaysNothing: zeroReference.length, noOnLevelRoom: noReference },
    magnitude: `${offenders.length}/${tested} level + composition pairs earn more in a room ${BACKWARDS_GAP}+ levels below (${beyond.length} by over ${NOISE_TOLERANCE * 100} %, which is what fails), worst ${ratio(maxOf(paying.map(o => o.ratio)))} against a paying room; for ${zeroReference.length} pairs the only on-level rooms they win pay nothing; ${noReference} pairs have no on-level room they win`,
    lines: [
      `Best room at least ${BACKWARDS_GAP} levels below the party against the best room within ${ON_LEVEL_BAND} levels that it wins at least ${WIN_OK_PCT} %.`,
      '',
      'Worst offenders where the on-level room pays:',
      '',
      ...table(headers, paying.slice(0, TOP_OFFENDERS).map(row)),
      '',
      'Pairs whose only on-level rooms they win pay nothing:',
      '',
      ...table(headers, zeroReference.slice(0, TOP_OFFENDERS).map(row)),
      '',
      'By party level:',
      '',
      ...table(['level', 'offenders', 'worst ratio, paying room'], d.meta.grid.map(level => {
        const list = offenders.filter(o => o.level === level);
        return [level, list.length, ratio(maxOf(list.filter(o => o.ref.xp > 0).map(o => o.ratio)))];
      }).filter(r => r[1] !== 0)),
    ],
  };
}

// --- I3 ---

function levelsPerDay(d: Data, xpPerHour: number, level: number): number {
  return (xpPerHour * DAY_HOURS) / d.mod.xpForNextLevel(level);
}

function starterAt(d: Data, compId: string, level: number): Row[] {
  return d.at(compId, level).filter(r => r.table.kind === 'room' && r.table.regionIndex === 0 && d.clearlyWon(r));
}

function journeyAt(d: Data, compId: string, level: number): Row[] {
  return d.at(compId, level).filter(r => d.isFarmRoom(r.table) && r.table.regionIndex > 0 && Math.abs(r.table.roomLevel - level) <= ON_LEVEL_BAND && d.plausiblyWon(r));
}

/** The one or two rows a median of these rows' XP/hr reads. */
function medianRows(rows: readonly Row[]): Row[] {
  const sorted = [...rows].sort((a, b) => a.xp - b.xp);
  if (sorted.length === 0) return [];
  return [sorted[Math.floor((sorted.length - 1) / 2)], sorted[Math.ceil((sorted.length - 1) / 2)]];
}

interface StarterPair {
  comp: string;
  level: number;
  starter: Row;
  journey: Row[];
  journeyMedian: number;
  journeyBest: number;
  ratio: number;
}

function starterPairs(d: Data): StarterPair[] {
  const pairs: StarterPair[] = [];
  for (const comp of d.comps('core', 'extended', 'hired')) {
    for (const level of d.meta.grid) {
      if (level < JOURNEYER_MIN_LEVEL) continue;
      const starter = maxBy(starterAt(d, comp.id, level), r => r.xp);
      const journey = journeyAt(d, comp.id, level);
      if (!starter || journey.length === 0) continue;
      const xs = journey.map(r => r.xp);
      const journeyMedian = median(xs);
      pairs.push({ comp: comp.id, level, starter, journey, journeyMedian, journeyBest: Math.max(...xs), ratio: starter.xp / journeyMedian });
    }
  }
  return pairs;
}

interface StarterAnchor {
  compId: string;
  sitter: Row | undefined;
  level: number | undefined;
  journey: Row[];
  journeyMedian: number;
  journeyBest: number;
}

function starterAnchors(d: Data): StarterAnchor[] {
  const anchors = [FULL_PARTY, TYPICAL_PARTY, 'K+P', ...SOLO_IDS, ...HIRE_IDS, ARCHER_HIRED_KNIGHT].filter(id => d.has(id));
  return anchors.map(compId => {
    const sitter = maxBy(d.meta.grid.flatMap(level => starterAt(d, compId, level)), r => r.xp);
    const firstJourney = d.meta.grid.filter(l => l >= JOURNEYER_MIN_LEVEL).map(level => ({ level, rows: journeyAt(d, compId, level) })).find(x => x.rows.length > 0);
    const journey = firstJourney?.rows ?? [];
    const xs = journey.map(r => r.xp);
    return { compId, sitter, level: firstJourney?.level, journey, journeyMedian: xs.length ? median(xs) : NaN, journeyBest: xs.length ? Math.max(...xs) : NaN };
  });
}

export function metricI3(d: Data): Metric {
  const comps = d.comps('core', 'extended', 'hired');
  const starterWeeklies = repeatablesWithinRegion(d.ledger, 0);
  const pairs = starterPairs(d);
  const tested = pairs.length;
  const beatsMedian = pairs.filter(p => p.ratio > 1);
  const beyondMedian = beatsMedian.filter(p => p.ratio > 1 + NOISE_TOLERANCE);
  const anchorRows = starterAnchors(d);
  const anchorFails = anchorRows.filter(x => x.sitter && !(x.sitter.xp <= x.journeyMedian * (1 + NOISE_TOLERANCE)));
  const noJourney = anchorRows.filter(x => x.sitter && !Number.isFinite(x.journeyMedian));
  const anySitter = maxBy(anchorRows.flatMap(x => (x.sitter ? [x.sitter] : [])), r => r.xp);

  const byLevel = d.meta.grid.map(level => {
    const best = maxBy(comps.flatMap(c => starterAt(d, c.id, level)), r => r.xp);
    const journey = maxBy(comps.flatMap(c => journeyAt(d, c.id, level)), r => r.xp);
    return { level, best, journey };
  }).filter(x => x.best);
  const worst = [...beatsMedian].sort((a, b) => b.ratio - a.ratio);
  return {
    id: 'I3',
    title: 'Starter never outpaces',
    pass: tested || anchorRows.some(x => x.sitter) ? beyondMedian.length === 0 && anchorFails.length === 0 : null,
    short: `${beyondMedian.length}/${tested} pairs, ${anchorFails.length}/${anchorRows.length} sitters, worst ${ratio(worst[0]?.ratio ?? NaN)}`,
    values: { pairs: tested, beatsJourneyer: beatsMedian.length, overBeyondNoise: beyondMedian.length, worstRatio: worst[0]?.ratio ?? NaN, partiesWhoseSitterWins: anchorFails.length, parties: anchorRows.length, bestSitterXpPerHour: anySitter?.xp ?? NaN },
    magnitude: `${beatsMedian.length}/${tested} composition + level pairs (level ${JOURNEYER_MIN_LEVEL}+) earn more farming the starter region than the median on-level journeyer of the same party (${beyondMedian.length} by over ${NOISE_TOLERANCE * 100} %, which is what fails), worst ${ratio(worst[0]?.ratio ?? NaN)}; ${anchorFails.length}/${anchorRows.length} parties' best starter sitter of any level beats the same party's first on-level journeyer by over ${NOISE_TOLERANCE * 100} % (${noJourney.length} of them have no later on-level room they win); the best sitter of any party, ${anySitter ? `${fmt(anySitter.xp)} XP/hr` : '-'}, beats ${anchorRows.filter(x => anySitter && anySitter.xp > x.journeyMedian).length}/${anchorRows.length} journeying parties' medians`,
    lines: [
      `Best sitter of any party and level: ${anySitter ? `${anySitter.comp.id} at L${anySitter.cell.level}, ${place(anySitter)}, ${fmt(anySitter.xp)} XP/hr` : '-'}. The verdict compares a sitter with the same party journeying; that one against other parties' journeyers is printed below and judges nothing.`,
      '',
      'The best starter sitter of any level against the same party when it first journeys on-level (level 10 or the first level it has a room it wins):',
      '',
      ...table(['party', 'best sitter XP/hr', 'sitter level', 'sitter room', 'journeyer level', 'journeyer median XP/hr', 'journeyer best XP/hr', 'sitter / median', 'best sitter of any party / median'], anchorRows.map(x => [
        x.compId,
        x.sitter ? fmt(x.sitter.xp) : '-',
        x.sitter?.cell.level ?? '-',
        x.sitter ? place(x.sitter) : '-',
        x.level ?? '-',
        fmt(x.journeyMedian),
        fmt(x.journeyBest),
        x.sitter ? ratio(x.sitter.xp / x.journeyMedian) : '-',
        anySitter ? ratio(anySitter.xp / x.journeyMedian) : '-',
      ])),
      '',
      'Best starter farming per level of any composition, and the best on-level room of a later region at that level:',
      '',
      ...table(['level', 'starter XP/hr', 'party', 'levels/day', 'later region XP/hr', 'party', 'levels/day', 'starter / later', 'weeklies a sitter can do, XP/hr', 'weeklies a journeyer can do, XP/hr', 'starter / later, with weeklies'], byLevel.map(x => {
        const sitterWeekly = repeatableXpPerHour(starterWeeklies, x.level);
        const journeyWeekly = repeatableXpPerHour(d.ledger.repeatable, x.level);
        return [
          x.level,
          fmt(x.best!.xp),
          x.best!.comp.id,
          levelsPerDay(d, x.best!.xp, x.level).toFixed(2),
          x.journey ? fmt(x.journey.xp) : '-',
          x.journey?.comp.id ?? '-',
          x.journey ? levelsPerDay(d, x.journey.xp, x.level).toFixed(2) : '-',
          x.journey ? ratio(x.best!.xp / x.journey.xp) : '-',
          fmt(sitterWeekly),
          fmt(journeyWeekly),
          x.journey ? ratio((x.best!.xp + sitterWeekly) / (x.journey.xp + journeyWeekly)) : '-',
        ];
      })),
      '',
      'Worst offenders, same party and level:',
      '',
      ...table(['party', 'level', 'starter room', 'starter XP/hr', 'journeyer median', 'journeyer best', 'ratio to median'], worst.slice(0, TOP_OFFENDERS).map(o => [o.comp, o.level, place(o.starter), fmt(o.starter.xp), fmt(o.journeyMedian), fmt(o.journeyBest), ratio(o.ratio)])),
    ],
  };
}

// --- I4 ---

function nearestGridLevel(d: Data, roomLevel: number): number {
  return maxBy(d.meta.grid, l => -Math.abs(l - roomLevel))!;
}

function onLevelPoints(d: Data, compId: string): Row[] {
  const points: Row[] = [];
  for (const t of d.meta.tables) {
    if (!d.isFarmRoom(t)) continue;
    const level = nearestGridLevel(d, t.roomLevel);
    const row = d.get(t.index, compId, level);
    if (row && d.plausiblyWon(row) && Math.abs(level - t.roomLevel) <= ON_LEVEL_BAND) points.push(row);
  }
  return points.sort((a, b) => a.table.roomLevel - b.table.roomLevel);
}

interface Inversion {
  low: Row;
  high: Row;
  ratio: number;
}

function monotoneResults(d: Data): { compId: string; points: Row[]; rho: number; near: Inversion[] }[] {
  const refs = [FULL_PARTY, TYPICAL_PARTY, 'K+P', ...SOLO_IDS, ARCHER_HIRED_KNIGHT].filter(id => d.has(id));
  return refs.map(compId => {
    const points = onLevelPoints(d, compId);
    const rho = spearman(points.map(p => p.table.roomLevel), points.map(p => p.xp));
    const near: Inversion[] = [];
    points.forEach((p, i) => {
      const earlier = points.slice(0, i).filter(q => p.table.roomLevel - q.table.roomLevel >= INVERSION_MIN_GAP && d.clearlyWon(q));
      const top = maxBy(earlier, q => q.xp);
      if (top && p.xp < top.xp * RESAMPLE_INVERSION_KEEP) near.push({ low: top, high: p, ratio: p.xp / top.xp });
    });
    return { compId, points, rho, near };
  }).filter(r => r.points.length >= 2);
}

function metricI4(d: Data): Metric {
  const results = monotoneResults(d).map(r => ({ ...r, inversions: r.near.filter(i => i.ratio < INVERSION_KEEP) }));
  const worstRho = minOf(results.map(r => r.rho).filter(Number.isFinite));
  const regionCount = d.regions.length;
  const regionMedian = (compId: string, regionIndex: number): number => {
    const xs = onLevelPoints(d, compId).filter(p => p.table.regionIndex === regionIndex).map(p => p.xp);
    return xs.length ? median(xs) : NaN;
  };
  const worst = results.flatMap(r => r.inversions.map(i => ({ ...i, compId: r.compId }))).sort((a, b) => a.ratio - b.ratio);
  return {
    id: 'I4',
    title: 'Monotone progress',
    pass: results.length ? worstRho >= MONOTONE_PASS_RHO && worst.length === 0 : null,
    short: `worst rho ${worstRho.toFixed(2)}, ${worst.length} inversions`,
    values: { worstRho, fullPartyRho: results.find(r => r.compId === FULL_PARTY)?.rho ?? NaN, inversions: worst.length, worstInversion: worst[0]?.ratio ?? NaN },
    magnitude: `rank correlation of on-level XP/hr with room level: worst ${worstRho.toFixed(2)}, ${FULL_PARTY} ${results.find(r => r.compId === FULL_PARTY)?.rho.toFixed(2) ?? '-'}; ${worst.length} rooms pay under ${INVERSION_KEEP * 100} % of a room ${INVERSION_MIN_GAP}+ levels below, worst ${ratio(worst[0]?.ratio ?? NaN)}`,
    lines: [
      ...table(['party', 'rooms', 'rank correlation', 'inversions'], results.map(r => [r.compId, r.points.length, r.rho.toFixed(3), r.inversions.length])),
      '',
      'Median on-level XP/hr by region:',
      '',
      ...table(['region', ...results.map(r => r.compId)], Array.from({ length: regionCount }, (_, i) => [`R${i} ${d.regions[i].name}`, ...results.map(r => fmt(regionMedian(r.compId, i)))])),
      '',
      'Worst inversions:',
      '',
      ...table(['party', 'room', 'XP/hr', 'pays less than', 'XP/hr', 'ratio'], worst.slice(0, TOP_OFFENDERS).map(w => [w.compId, place(w.high), fmt(w.high.xp), place(w.low), fmt(w.low.xp), ratio(w.ratio)])),
    ],
  };
}

// --- I5 ---

/** Rooms outside the starter region that pay, yet pay nothing to a member who wins them at or above their level, after any bossPolicy: the fear of going AFK and earning nothing, for that player. */
function roomsPayingSomeoneNothing(d: Data): XpTable[] {
  const found = new Map<number, XpTable>();
  for (const r of d.rows) {
    if (r.table.kind !== 'room' || r.table.regionIndex === 0 || d.zero.has(r.table.index) || found.has(r.table.index)) continue;
    if (!playedNormally(r.comp) || r.rate.win < WIN_OK_PCT || r.cell.level < r.table.roomLevel - ON_LEVEL_BAND) continue;
    if (r.rate.xp.some(x => x === 0)) found.set(r.table.index, r.table);
  }
  return [...found.values()];
}

export function metricI5(d: Data): Metric {
  const rooms = d.meta.tables.filter(t => t.kind === 'room');
  const zeroRooms = rooms.filter(t => d.zero.has(t.index));
  const tiles = (list: readonly XpTable[]): number => list.reduce((s, t) => s + t.tileCount, 0);
  const outside = zeroRooms.filter(t => t.regionIndex > 0);
  const refId = d.has(TYPICAL_PARTY) ? TYPICAL_PARTY : d.meta.comps[0].id;
  const byZone = new Map<string, { table: XpTable; xp: number; won: boolean }[]>();
  for (const t of rooms) {
    const row = d.get(t.index, refId, nearestGridLevel(d, t.roomLevel));
    if (row && row.rate.win > 0) push(byZone, t.zoneId, { table: t, xp: row.xp, won: row.rate.win >= WIN_OK_PCT });
  }
  const floors: { table: XpTable; xp: number; won: boolean; zoneMedian: number; ratio: number }[] = [];
  for (const list of byZone.values()) {
    const weighted = list.flatMap(x => Array.from({ length: x.table.tileCount }, () => x.xp));
    const zoneMedian = median(weighted);
    if (!(zoneMedian > 0)) continue;
    for (const x of list) floors.push({ ...x, zoneMedian, ratio: x.xp / zoneMedian });
  }
  const nonZero = floors.filter(f => f.ratio > 0);
  const underFloor = nonZero.filter(f => f.won && f.table.regionIndex > 0 && f.ratio < ROOM_FLOOR_SHARE).map(f => f.table);
  const someoneNothing = roomsPayingSomeoneNothing(d);
  const afkRows = AFK_GAP_BANDS.map(([low, high]) => {
    const shares: number[] = [];
    for (const level of d.meta.grid) {
      const rows = d.at(refId, level).filter(r => d.isFarmRoom(r.table) && r.rate.win >= WIN_OK_PCT);
      const best = maxOf(rows.map(r => r.xp));
      if (!(best > 0)) continue;
      for (const r of rows) {
        const gap = level - r.table.roomLevel;
        if (gap >= low && gap <= high) shares.push(r.xp / best);
      }
    }
    return { low, high, shares };
  });
  const afkLowest = minOf(afkRows.flatMap(x => x.shares));
  const share = (cut: number): string => `${((100 * floors.filter(f => f.ratio >= cut).reduce((s, f) => s + f.table.tileCount, 0)) / Math.max(1, floors.reduce((s, f) => s + f.table.tileCount, 0))).toFixed(1)} %`;
  return {
    id: 'I5',
    title: 'No zero rooms',
    pass: outside.length === 0 && someoneNothing.length === 0 && underFloor.length === 0,
    short: `${tiles(outside)} rooms pay nothing, ${tiles(someoneNothing)} pay someone nothing, ${tiles(underFloor)} under the floor`,
    values: { zeroRoomsOutsideStarter: tiles(outside), zeroTablesOutsideStarter: outside.length, zeroRoomsInStarter: tiles(zeroRooms) - tiles(outside), roomsPayingSomeoneNothing: tiles(someoneNothing), roomsUnderFloor: tiles(underFloor), roomFloor: minOf(nonZero.map(f => f.ratio)), afkLowestShare: afkLowest },
    magnitude: `${tiles(outside)} rooms in ${outside.length} tables pay nothing outside the starter region (${outside.reduce((s, t) => s + t.npcTiles, 0)} of them NPC rooms), ${tiles(zeroRooms) - tiles(outside)} inside it; ${tiles(someoneNothing)} more pay nothing to a member who wins them at or above their level; ${tiles(underFloor)} rooms a party wins pay under ${percent(ROOM_FLOOR_SHARE)} of their zone's median; the lowest paying room earns ${(minOf(nonZero.map(f => f.ratio)) * 100).toFixed(1)} % of it`,
    lines: [
      `Walkable rooms: ${tiles(rooms)}. Paying nothing: ${tiles(zeroRooms)} (${zeroRooms.reduce((s, t) => s + t.npcTiles, 0)} NPC rooms, ${zeroRooms.reduce((s, t) => s + t.shopTiles, 0)} shop rooms, ${zeroRooms.reduce((s, t) => s + t.dungeonTiles, 0)} dungeon entrances). Fails on any room outside the starter region paying nothing, for everyone or for a member who wins it at or above their level, or on a room ${refId} wins paying under ${percent(ROOM_FLOOR_SHARE)} of its zone's median.`,
      '',
      `Room floor, ${refId} at the grid level nearest each room, against its zone's tile-weighted median: at or above 50 % of it ${share(0.5)} of rooms, 25 % ${share(0.25)}, 10 % ${share(0.1)}.`,
      '',
      `Going AFK in a room well below the party, ${refId}, as a share of its best room at that level, for information. A token payment would pass the zero test and show here:`,
      '',
      ...table(['levels above the room', 'readings', 'median', 'lowest'], afkRows.map(x => [`${x.low} to ${x.high}`, x.shares.length, percent(median(x.shares), 1), percent(minOf(x.shares), 1)])),
      '',
      'Zero-paying rooms by region:',
      '',
      ...table(['region', 'rooms', 'NPC rooms'], d.regions.map(r => {
        const list = zeroRooms.filter(t => t.regionIndex === r.index);
        return [`R${r.index} ${r.name}`, tiles(list), list.reduce((s, t) => s + t.npcTiles, 0)];
      })),
      '',
      'Lowest paying rooms that pay something:',
      '',
      ...table(['room', 'rooms sharing it', 'XP/hr', 'zone median', 'ratio'], [...nonZero].sort((a, b) => a.ratio - b.ratio).slice(0, TOP_OFFENDERS).map(f => [`${f.table.label} [R${f.table.regionIndex} L${f.table.roomLevel}]`, f.table.tileCount, fmt(f.xp), fmt(f.zoneMedian), ratio(f.ratio)])),
    ],
  };
}

// --- I6 ---

export type VariantKind = 'not above' | 'faster party' | 'stalling' | 'lose fast' | 'fewer kills';

interface VariantStats {
  xp: number;
  ms: number;
  kph: number;
  win: number;
}

/** Earning more with shorter fights and more kills is a faster party, which I7 says should pay. */
export function classifyVariant(variant: VariantStats, normal: VariantStats): VariantKind {
  if (!(variant.xp > normal.xp * (1 + NOISE_TOLERANCE))) return 'not above';
  if (variant.ms > normal.ms) return 'stalling';
  if (variant.win <= normal.win - LOSE_FAST_WIN_GAP) return 'lose fast';
  if (variant.kph < normal.kph) return 'fewer kills';
  return 'faster party';
}

const FLAGGED_KINDS: readonly VariantKind[] = ['stalling', 'lose fast', 'fewer kills'];

/** The best read of a variant against its normal party, second look included. */
function finalRead(d: Data, c: VariantCell): { kind: VariantKind; ratio: number; fights: number } {
  const here = d.latest(c.row);
  const normal = d.latest(c.normal);
  if (here === c.row.rate && normal === c.normal.rate) return { kind: c.kind, ratio: c.ratio, fights: Math.min(d.sampleSize(c.row), d.sampleSize(c.normal)) };
  return {
    kind: classifyVariant(variantStats(here, c.member), variantStats(normal, c.member)),
    ratio: safeRatio(here.xp[c.member], normal.xp[c.member]),
    fights: Math.min(d.sampleSize(c.row), d.sampleSize(c.normal)),
  };
}

interface VariantCell {
  group: string;
  row: Row;
  normal: Row;
  member: number;
  ratio: number;
  kind: VariantKind;
  /** Before any fresh sample. */
  firstRatio: number;
  firstKind: VariantKind;
}

function variantGroup(comp: XpComp): string | null {
  if (comp.gear === 'ungeared') return 'ungeared';
  if (comp.skills === 'attackOnly') return 'Attack only';
  if (comp.swapSeats) return 'worse seat';
  return null;
}

function variantStats(rate: CellRate, member: number): VariantStats {
  return { xp: rate.xp[member], ms: rate.ms, kph: rate.kph, win: rate.win };
}

function firstVariantStats(rate: CellRate, member: number): VariantStats {
  const first = rate.first ?? rate;
  return { xp: first.xp[member], ms: first.ms, kph: first.kph, win: first.win };
}

/** Same-party variants against that party played normally, at the member the variant pays best, where the normal party wins. */
function variantCells(d: Data): { cells: VariantCell[]; tested: Map<string, number>; losingNormal: number } {
  const cells: VariantCell[] = [];
  const tested = new Map<string, number>();
  let losingNormal = 0;
  for (const comp of d.comps('stall')) {
    const group = variantGroup(comp);
    if (!group || !comp.reference) continue;
    for (const level of d.meta.grid) {
      for (const row of d.at(comp.id, level)) {
        if (row.table.kind !== 'room') continue;
        const normal = d.get(row.table.index, comp.reference, level);
        if (!normal) continue;
        if (!d.clearlyWon(normal)) {
          if (row.xp > normal.xp * (1 + NOISE_TOLERANCE)) losingNormal++;
          continue;
        }
        tested.set(group, (tested.get(group) ?? 0) + 1);
        let member = 0;
        let best = -Infinity;
        row.members.forEach((_, i) => {
          const value = normal.rate.xp[i] > 0 ? row.rate.xp[i] / normal.rate.xp[i] : row.rate.xp[i] > 0 ? Infinity : 0;
          if (value > best) {
            best = value;
            member = i;
          }
        });
        const firstHere = firstVariantStats(row.rate, member);
        const firstNormal = firstVariantStats(normal.rate, member);
        cells.push({
          group, row, normal, member, ratio: best,
          kind: classifyVariant(variantStats(row.rate, member), variantStats(normal.rate, member)),
          firstRatio: firstNormal.xp > 0 ? firstHere.xp / firstNormal.xp : Infinity,
          firstKind: classifyVariant(firstHere, firstNormal),
        });
      }
    }
  }
  return { cells, tested, losingNormal };
}

function xpBonusLines(d: Data): string[] {
  const rows: { comp: string; ratio: number; mult: number; msRatio: number }[] = [];
  for (const comp of d.meta.comps.filter(c => c.xpBonus && c.reference)) {
    for (const level of d.meta.grid) {
      for (const row of d.at(comp.id, level)) {
        if (row.table.kind !== 'room' || d.zero.has(row.table.index)) continue;
        const normal = d.get(row.table.index, comp.reference!, level);
        if (!normal || normal.rate.win < WIN_OK_PCT || !(normal.xp > 0)) continue;
        rows.push({ comp: comp.id, ratio: row.xp / normal.xp, mult: row.cell.xpMult, msRatio: normal.rate.ms > 0 ? row.rate.ms / normal.rate.ms : 1 });
      }
    }
  }
  const comps = [...new Set(rows.map(r => r.comp))];
  return rows.length === 0 ? ['xp_bonus variants: not in this atlas.'] : [
    'xp_bonus passives stack additively across the party with no cap. That is a designed perk of the Bard, stacked or not, so these cells are for information and never count here. Each I: party against the same party with its normal loadout, where the normal party wins:',
    '',
    ...table(['party', 'cells', 'XP multiplier', 'median XP/hr vs normal', 'p90', 'highest', 'median fight time vs normal'], comps.map(id => {
      const list = rows.filter(r => r.comp === id);
      return [id, list.length, median(list.map(r => r.mult)).toFixed(2), ratio(median(list.map(r => r.ratio))), ratio(quantile(list.map(r => r.ratio), 0.9)), ratio(maxOf(list.map(r => r.ratio))), ratio(median(list.map(r => r.msRatio)))];
    })),
  ];
}

export function metricI6(d: Data): Metric {
  const { cells, tested, losingNormal } = variantCells(d);
  if (tested.size === 0) return { id: 'I6', title: 'No stalling', pass: null, magnitude: 'stall variants not in this atlas', lines: [] };
  const finals = cells.map(c => ({ c, read: finalRead(d, c) }));
  const flaggedFirst = cells.filter(c => FLAGGED_KINDS.includes(c.firstKind));
  const flaggedFresh = cells.filter(c => FLAGGED_KINDS.includes(c.kind));
  const confirmed = finals.filter(x => FLAGGED_KINDS.includes(x.read.kind));
  const unsampled = confirmed.filter(x => x.read.fights < CONFIRM_FIGHTS && !(x.read.ratio >= CONFIRM_MARGIN));
  const faster = finals.filter(x => x.read.kind === 'faster party');
  const fasterFresh = faster.filter(x => x.read.fights > 0);
  const fasterBefore = cells.filter(c => c.kind === 'faster party').length;
  const loseFast = confirmed.filter(x => x.read.kind === 'lose fast');
  const stalling = confirmed.filter(x => x.read.kind === 'stalling');
  const fewer = confirmed.filter(x => x.read.kind === 'fewer kills');
  const needsRetreatOff = confirmed.filter(x => d.latest(x.c.row).skip > 0);
  const groups = [...tested.keys()].sort();
  const totalTested = [...tested.values()].reduce((a, b) => a + b, 0);
  const row = ({ c, read }: typeof confirmed[number]): (string | number)[] => {
    const name = c.row.members[c.member].className;
    const here = d.latest(c.row);
    const normal = d.latest(c.normal);
    return [c.row.comp.id, c.row.cell.level, place(c.row), name, read.kind, here.win, fmt(here.ms / 1000), here.skip > 0 ? `0..${fmt(here.xp[c.member])}` : fmt(here.xp[c.member]), normal.win, fmt(normal.ms / 1000), fmt(normal.xp[c.member]), ratio(c.firstRatio), ratio(c.ratio), read.fights, read.ratio.toFixed(3), FLAGGED_KINDS.includes(read.kind) ? 'yes' : 'no'];
  };
  const flaggedRows = finals.filter(x => FLAGGED_KINDS.includes(x.c.kind) || FLAGGED_KINDS.includes(x.read.kind));
  const stage = unsampled.length ? `${unsampled.length} of them not read at ${CONFIRM_FIGHTS} fights` : `holding at ${CONFIRM_FIGHTS} fights a side`;
  const fasterWord = fasterFresh.length === faster.length ? 'on a fresh sample' : `${faster.length - fasterFresh.length} of them on a first read alone`;
  return {
    id: 'I6',
    title: 'No stalling',
    pass: confirmed.length === 0,
    short: `${confirmed.length} flagged, worst ${ratio(maxOf(confirmed.map(x => x.read.ratio)))}`,
    values: { cellsTested: totalTested, stalling: stalling.length, losingFast: loseFast.length, fewerKills: fewer.length, flaggedOnFirstRead: flaggedFirst.length, flaggedOnFreshSample: flaggedFresh.length, notConfirmed: unsampled.length, needsAutoRetreatOff: needsRetreatOff.length, fasterParties: faster.length, fasterBeforeSecondLook: fasterBefore, worstConfirmed: maxOf(confirmed.map(x => x.read.ratio)) },
    magnitude: `same-party variants over ${NOISE_TOLERANCE * 100} % above normal play, of ${totalTested} cells where the normal party wins: ${stalling.length} stalling (longer fights), ${loseFast.length} losing fast, ${fewer.length} with fewer kills an hour, ${stage} (${flaggedFresh.length} flagged at 400 fights, ${flaggedFirst.length} on first read)${confirmed.length ? `, worst ${ratio(maxOf(confirmed.map(x => x.read.ratio)))}, ${needsRetreatOff.length} earning that only with auto-retreat off` : ''}; ${faster.length} more are simply faster parties, not stalling, ${fasterWord} (${fasterBefore} before that second look, most on first reads)`,
    lines: [
      `Each same-party variant against that party played normally, one line per cell at its best-paid member, where the normal party wins at least 90 %. Flagged means over 5 % above normal with longer fights, or by giving up wins for shorter fights, or with fewer kills an hour. A sample of 400 fights can't place a ratio against a 5 % line, so a flagged cell counts only if it holds at ${CONFIRM_FIGHTS} fights a side, unless 400 fights already read it over ${ratio(CONFIRM_MARGIN)}. A cell with auto-retreat skips keeps its shown rate only with auto-retreat off, which is the player's choice. P-only and P+B parties are under I7.`,
      '',
      ...table(['variant', 'cells', `over ${NOISE_TOLERANCE * 100} % above`, 'faster party, before the second look', 'faster party, on a fresh sample', 'flagged on first read', 'flagged at 400', 'confirmed', 'worst confirmed'], groups.map(g => {
        const list = cells.filter(c => c.group === g);
        const conf = confirmed.filter(x => x.c.group === g);
        return [g, tested.get(g) ?? 0, list.filter(c => c.kind !== 'not above').length, list.filter(c => c.kind === 'faster party').length, faster.filter(x => x.c.group === g).length, list.filter(c => FLAGGED_KINDS.includes(c.firstKind)).length, list.filter(c => FLAGGED_KINDS.includes(c.kind)).length, conf.length, ratio(maxOf(conf.map(x => x.read.ratio)))];
      })),
      '',
      `Losing fast, its own line: ${loseFast.length} cells earn more by losing a slow pack quickly than by winning it, because a defeat costs nothing and pays the same pause. The verdict counts them. A further ${losingNormal} cells beat a party that loses here, which is not stalling.`,
      '',
      'Cells flagged at 400 fights, worst first. Win %, seconds and XP/hr are the biggest sample read:',
      '',
      ...table(['variant', 'level', 'room', 'member', 'kind', 'variant win %', 's/fight', 'XP/hr', 'normal win %', 's/fight', 'XP/hr', 'first read', 'at 400 fights', 'fights a side', 'biggest sample', 'counts'], [...flaggedRows].sort((a, b) => b.read.ratio - a.read.ratio).slice(0, TOP_OFFENDERS).map(row)),
      '',
      ...xpBonusLines(d),
    ],
  };
}

// --- I7 ---

function playedNormally(c: XpComp): boolean {
  if (c.family === 'core' || c.family === 'extended' || c.family === 'hired') return true;
  return c.family === 'stall' && c.gear === 'level' && c.skills === 'default' && !c.swapSeats;
}

function balancedPartyLines(d: Data): string[] {
  const comps = d.meta.comps.filter(c => c.reference && !c.xpBonus && playedNormally(c));
  const rows = comps.map(comp => {
    const list: { ratio: number; shorter: boolean }[] = [];
    for (const level of d.meta.grid) {
      for (const row of d.at(comp.id, level)) {
        if (!d.isFarmRoom(row.table)) continue;
        const normal = d.get(row.table.index, comp.reference!, level);
        if (!normal || normal.rate.win < WIN_OK_PCT || !(normal.xp > 0)) continue;
        list.push({ ratio: row.xp / normal.xp, shorter: row.rate.ms < normal.rate.ms });
      }
    }
    const over = list.filter(x => x.ratio > 1 + NOISE_TOLERANCE);
    return [comp.id, comp.reference!, list.length, over.length, over.filter(x => x.shorter).length, ratio(median(list.map(x => x.ratio))), ratio(maxOf(list.map(x => x.ratio)))];
  });
  return [
    'P-only and P+B parties against a mixed party of their size, for information. A different party that kills faster should earn more, so these are efficiency, not stalling:',
    '',
    ...table(['party', 'against', 'cells', `over ${NOISE_TOLERANCE * 100} % above`, 'of those with shorter fights', 'median ratio', 'worst'], rows),
  ];
}

export function metricI7(d: Data): Metric {
  const groups = new Map<string, Row[]>();
  for (const r of d.rows) {
    if (!d.isFarmRoom(r.table) || !playedNormally(r.comp) || r.rate.win < WIN_OK_PCT || !(r.xp > 0)) continue;
    push(groups, `${r.table.index}|${r.cell.level}|${r.members.length + r.cell.hires.length}`, r);
  }
  const FASTER = 1.1;
  const pairsBad: { fast: Row; slow: Row; ratio: number }[] = [];
  const bonusPairsBad: { fast: Row; slow: Row; ratio: number }[] = [];
  let pairsTested = 0;
  let bonusPairsTested = 0;
  let fasterOnlyTested = 0;
  let fasterOnlyBad = 0;
  let spreadGroups = 0;
  const spreads: number[] = [];
  const bonuses: number[] = [];
  const correlations: number[] = [];
  const bestBonus: { r: Row; bonus: number; medianXp: number }[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const xs = rows.map(r => r.xp);
    const med = median(xs);
    spreads.push(Math.max(...xs) / Math.min(...xs));
    bonuses.push(Math.max(...xs) / med);
    const best = maxBy(rows, r => r.xp)!;
    bestBonus.push({ r: best, bonus: best.xp / med, medianXp: med });
    if (rows.length >= 3) {
      spreadGroups++;
      const rho = spearman(rows.map(r => r.rate.kph), xs);
      if (Number.isFinite(rho)) correlations.push(rho);
    }
    for (const a of rows) {
      for (const b of rows) {
        if (a.rate.kph <= b.rate.kph * FASTER) continue;
        const slowerHolds = b.cell.xpMult > 1;
        const inverted = a.xp < b.xp * (1 - NOISE_TOLERANCE);
        if (slowerHolds) bonusPairsTested++;
        else pairsTested++;
        if (inverted) (slowerHolds ? bonusPairsBad : pairsBad).push({ fast: a, slow: b, ratio: a.xp / b.xp });
        if (!slowerHolds && a.cell.xpMult > 1) {
          fasterOnlyTested++;
          if (inverted) fasterOnlyBad++;
        }
      }
    }
  }
  const bandBonus = (level: number): number => {
    const list = bestBonus.filter(b => Math.abs(b.r.cell.level - level) <= ON_LEVEL_BAND && Math.abs(b.r.table.roomLevel - level) <= ON_LEVEL_BAND).map(b => b.bonus);
    return median(list);
  };
  const badShare = pairsBad.length / Math.max(1, pairsTested);
  const killRateCorrelation = median(correlations);
  return {
    id: 'I7',
    title: 'Efficiency pays',
    pass: pairsTested ? badShare <= EFFICIENCY_MAX_BAD_SHARE : null,
    short: `${pairsBad.length}/${pairsTested} inverted, ${(badShare * 100).toFixed(3)} %`,
    values: { pairs: pairsTested, inverted: pairsBad.length, invertedShare: badShare, bonusPairs: bonusPairsTested, bonusInverted: bonusPairsBad.length, spreadMedian: median(spreads), optimisedBonusMedian: median(bonuses), killRateCorrelation, spreadGroups },
    magnitude: `${pairsBad.length}/${pairsTested} pairs (${(badShare * 100).toFixed(3)} %) where a party killing over ${Math.round((FASTER - 1) * 100)} % faster earns over ${NOISE_TOLERANCE * 100} % less; reported apart, ${bonusPairsBad.length}/${bonusPairsTested} pairs where the slower party holds xp_bonus and earns more with it; fast/slow spread median ${ratio(median(spreads))}, p90 ${ratio(quantile(spreads, 0.9))}; optimised-party bonus (best over median) median ${ratio(median(bonuses))}, p90 ${ratio(quantile(bonuses, 0.9))}`,
    lines: [
      `Same room, level and party size, winning at least ${WIN_OK_PCT} %, with P-only parties in. Passes with at most ${EFFICIENCY_MAX_BAD_SHARE * 100} % of pairs inverted, since rooms that roll varied packs leave some spread between samples. A pair where the slower party holds xp_bonus isn't like for like: that party earning more is the perk working. Those pairs are reported apart and leave the verdict; a pair where only the faster party holds it stays in. The spread and bonus figures below still include those parties. Within-group rank correlation of kill rate with XP/hr: median ${killRateCorrelation.toFixed(2)} over ${correlations.length} of ${spreadGroups} groups. Efficiency must pay at least equal and should probably scale up: this verdict can't see pay that ignores kill rate altogether, so the card warns if that correlation is under ${FLAT_PAY_CORRELATION}.`,
      '',
      'Pairs where the slower party holds xp_bonus, for information:',
      '',
      ...table(['pairs', 'faster party earns less', 'lowest ratio'], [[bonusPairsTested, bonusPairsBad.length, ratio(minOf(bonusPairsBad.map(p => p.ratio)))]]),
      '',
      `Leaving out every pair where either party holds it would read ${pairsBad.length - fasterOnlyBad}/${pairsTested - fasterOnlyTested}, ${(((pairsBad.length - fasterOnlyBad) / Math.max(1, pairsTested - fasterOnlyTested)) * 100).toFixed(3)} %.`,
      '',
      'Optimised-party bonus by party level, on-level rooms:',
      '',
      ...table(['level', 'best party over median'], d.meta.grid.filter(l => l >= 5 && l % 5 === 0).map(level => [level, ratio(bandBonus(level))])),
      '',
      'Biggest optimised-party bonuses:',
      '',
      ...table(['party', 'level', 'room', 'XP/hr', 'median of its size', 'bonus'], [...bestBonus].sort((a, b) => b.bonus - a.bonus).slice(0, TOP_OFFENDERS).map(b => [b.r.comp.id, b.r.cell.level, place(b.r), fmt(b.r.xp), fmt(b.medianXp), ratio(b.bonus)])),
      '',
      'Worst offenders:',
      '',
      ...table(['faster party', 'XP/hr', 'kills/hr', 'slower party', 'XP/hr', 'kills/hr', 'level', 'room'], [...pairsBad].sort((a, b) => a.ratio - b.ratio).slice(0, TOP_OFFENDERS).map(p => [p.fast.comp.id, fmt(p.fast.xp), fmt(p.fast.rate.kph), p.slow.comp.id, fmt(p.slow.xp), fmt(p.slow.rate.kph), p.fast.cell.level, place(p.fast)])),
      '',
      ...balancedPartyLines(d),
    ],
  };
}

// --- I8 ---

export function metricI8(d: Data): Metric {
  const deltas = [1, 2, 3, 4, 5];
  const ratios = new Map<number, number[]>();
  const best: { delta: number; compId: string; level: number; ratio: number }[] = [];
  for (const comp of d.comps('core', 'extended')) {
    for (const level of d.meta.grid) {
      const rows = d.at(comp.id, level).filter(r => d.isFarmRoom(r.table) && r.rate.win >= WIN_OK_PCT);
      const base = rows.filter(r => r.table.roomLevel - level === 0 || r.table.roomLevel - level === -1).map(r => r.xp);
      if (base.length === 0) continue;
      const baseMedian = median(base);
      if (!(baseMedian > 0)) continue;
      for (const delta of deltas) {
        const xs = rows.filter(r => r.table.roomLevel - level === delta).map(r => r.xp);
        if (xs.length === 0) continue;
        const value = median(xs) / baseMedian;
        push(ratios, delta, value);
        best.push({ delta, compId: comp.id, level, ratio: value });
      }
    }
  }
  const softRooms = SOFT_ROOM_BANDS.map(([low, high]) => {
    const found: { compId: string; level: number; room: Row; ratio: number }[] = [];
    for (const comp of d.comps('core', 'extended')) {
      for (const level of d.meta.grid) {
        const rows = d.at(comp.id, level).filter(r => d.isFarmRoom(r.table) && r.rate.win >= WIN_OK_PCT);
        const base = rows.filter(r => r.table.roomLevel - level === 0 || r.table.roomLevel - level === -1).map(r => r.xp);
        const room = maxBy(rows.filter(r => r.table.roomLevel - level >= low && r.table.roomLevel - level <= high), r => r.xp);
        if (room && base.length && median(base) > 0) found.push({ compId: comp.id, level, room, ratio: room.xp / median(base) });
      }
    }
    return { low, high, found };
  });
  const medians = deltas.map(delta => median(ratios.get(delta) ?? []));
  const measured = medians.filter(Number.isFinite);
  const monotone = measured.every((m, i) => i === 0 || m >= measured[i - 1] * (1 - NOISE_TOLERANCE));
  return {
    id: 'I8',
    title: 'Challenge pays',
    pass: measured.length ? measured.every(m => m > 1) && monotone : null,
    short: deltas.map((delta, i) => `+${delta} ${ratio(medians[i])}`).join(', '),
    values: { ...Object.fromEntries(deltas.map((delta, i) => [`plus${delta}`, medians[i]])), ...Object.fromEntries(softRooms.map(s => [`softRoomsPlus${s.low}To${s.high}Median`, median(s.found.map(x => x.ratio))])) },
    magnitude: `median XP/hr against on-level rooms while winning at least ${WIN_OK_PCT} %: ${deltas.map((delta, i) => `+${delta}: ${ratio(medians[i])}`).join(', ')}`,
    lines: [
      ...table(['room over player', 'pairs', 'median ratio', 'p10', 'p90', 'share above on-level'], deltas.map(delta => {
        const list = ratios.get(delta) ?? [];
        return [`+${delta}`, list.length, ratio(median(list)), ratio(quantile(list, 0.1)), ratio(quantile(list, 0.9)), `${((100 * list.filter(x => x > 1).length) / Math.max(1, list.length)).toFixed(0)} %`];
      })),
      '',
      `Rooms well above the party, for information: room level isn't difficulty everywhere, so a rule paying by room level also pays under-levelled parties who win a soft room. The party's best such room won at least ${WIN_OK_PCT} % over its on-level median. No verdict reads this, since a limit is a design choice:`,
      '',
      ...table(['room over player', 'party + level pairs', 'median', 'p90', 'highest', 'highest is', 'its room'], softRooms.map(s => {
        const top = maxBy(s.found, x => x.ratio);
        return [`+${s.low} to +${s.high}`, s.found.length, ratio(median(s.found.map(x => x.ratio))), ratio(quantile(s.found.map(x => x.ratio), 0.9)), ratio(top?.ratio ?? NaN), top ? `${top.compId} L${top.level}` : '-', top ? place(top.room) : '-'];
      })),
    ],
  };
}

// --- I8b ---

export interface LosingPair {
  compId: string;
  level: number;
  /** The best room it wins under LOSING_WIN_PCT. */
  lost: Row;
  won: Row;
  ratio: number;
}

/** Each party's best room it mostly loses against its best room it wins. Reads a second look where one was taken, and takes the plan's side on the win line. */
export function losingPairs(d: Data): LosingPair[] {
  const pairs: LosingPair[] = [];
  const pay = (r: Row): number => mean(d.latest(r).xp);
  for (const comp of d.comps('core', 'extended')) {
    for (const level of d.meta.grid) {
      const rooms = d.at(comp.id, level).filter(r => r.table.kind === 'room' && !d.zero.has(r.table.index));
      const won = maxBy(rooms.filter(r => d.plausiblyWon(r)), pay);
      const lost = maxBy(rooms.filter(r => d.latest(r).win < LOSING_WIN_PCT), pay);
      if (won && lost) pairs.push({ compId: comp.id, level, lost, won, ratio: safeRatio(pay(lost), pay(won)) });
    }
  }
  return pairs;
}

export function metricI8b(d: Data): Metric {
  const pairs = losingPairs(d);
  const over = pairs.filter(p => !(p.ratio <= 1 + NOISE_TOLERANCE)).sort((a, b) => b.ratio - a.ratio);
  const retreatOff = over.filter(p => d.latest(p.lost).skip > 0);
  const firstReads = over.filter(p => d.sampleSize(p.lost) === 0);
  return {
    id: 'I8b',
    title: 'Losing doesn\'t pay',
    pass: pairs.length ? over.length === 0 : null,
    short: `${over.length}/${pairs.length} over by over ${NOISE_TOLERANCE * 100} %, worst ${ratio(maxOf(over.map(p => p.ratio)))}`,
    values: { pairs: pairs.length, overBeyondNoise: over.length, worstRatio: maxOf(over.map(p => p.ratio)), needsAutoRetreatOff: retreatOff.length, medianRatio: median(pairs.map(p => p.ratio)), onFirstRead: firstReads.length },
    magnitude: `${over.length}/${pairs.length} party + level pairs earn over ${NOISE_TOLERANCE * 100} % more in a room they win under ${LOSING_WIN_PCT} % than in the best room they win at least ${WIN_OK_PCT} %, worst ${ratio(maxOf(over.map(p => p.ratio)))}; ${retreatOff.length} of those earn it only with auto-retreat off`,
    lines: [
      `No other verdict reads a room a party loses, so a rule paying for lost fights would be invisible. A player sitting in a room they can't beat should not be paid for it. A room won under ${LOSING_WIN_PCT} % is one the party loses; winning ${LOSING_WIN_PCT} to ${WIN_OK_PCT} % and earning more is a challenge paying off, and isn't counted. Core and extended parties. ${firstReads.length} of the rooms counted rest on a first read: flagged picks get a second look at 400 fights when the run re-samples.`,
      '',
      ...table(['party', 'level', 'room it loses', 'win %', 'XP/hr', 'best room it wins', 'XP/hr', 'ratio'], over.slice(0, TOP_OFFENDERS).map(p => [p.compId, p.level, place(p.lost), d.latest(p.lost).win, d.latest(p.lost).skip > 0 ? `0..${fmt(mean(d.latest(p.lost).xp))}` : fmt(mean(d.latest(p.lost).xp)), place(p.won), fmt(mean(d.latest(p.won).xp)), ratio(p.ratio)])),
    ],
  };
}

// --- Curves ---

/** Geometric interpolation over grid levels; gaps take the nearest known level below, else above. */
function makeCurve(d: Data, atLevel: (level: number) => number): (level: number) => number {
  const known = new Map<number, number>();
  for (const level of d.meta.grid) {
    const value = atLevel(level);
    if (value > 0) known.set(level, value);
  }
  const levels = [...known.keys()];
  return (level: number): number => {
    if (levels.length === 0) return 0;
    const below = levels.filter(l => l <= level).pop();
    const above = levels.find(l => l >= level);
    if (below === undefined) return known.get(above!)!;
    if (above === undefined) return known.get(below)!;
    if (below === above) return known.get(below)!;
    const t = (level - below) / (above - below);
    return known.get(below)! ** (1 - t) * known.get(above)! ** t;
  };
}

function typicalRate(d: Data, compId: string, level: number): number {
  const rows = d.onLevel(compId, level);
  if (rows.length) return median(rows.map(r => r.xp));
  const anyWin = d.at(compId, level).filter(r => d.isFarmRoom(r.table) && r.rate.win >= WIN_OK_PCT);
  return anyWin.length ? Math.max(...anyWin.map(r => r.xp)) : 0;
}

function typicalAcross(d: Data, compIds: readonly string[], level: number): number {
  const rates = compIds.filter(id => d.has(id)).map(id => typicalRate(d, id, level)).filter(r => r > 0);
  return rates.length ? median(rates) : 0;
}

function daysBetween(d: Data, rate: (level: number) => number, from: number, to: number): number {
  let hours = 0;
  for (let level = from; level < to; level++) {
    const r = rate(level);
    if (!(r > 0)) return Infinity;
    hours += d.mod.xpForNextLevel(level) / r;
  }
  return hours / DAY_HOURS;
}

// --- I9 ---

export function metricI9(d: Data): Metric {
  const carry = d.comps('carry');
  if (carry.length === 0) return { id: 'I9', title: 'Power-levelling', pass: null, magnitude: 'carry parties not in this atlas', lines: [] };
  const FROM = 5;
  const TO = 30;
  const friendIndex = (r: Row): number => r.members.findIndex(m => m.role === 'friend');
  const carrierIndex = (r: Row): number => r.members.findIndex(m => m.role === 'carrier');
  const onLevelSolo = makeCurve(d, level => typicalAcross(d, SOLO_IDS, level));
  const onLevelParty = makeCurve(d, level => typicalAcross(d, [TYPICAL_PARTY], level));
  const soloDays = daysBetween(d, onLevelSolo, FROM, TO);
  const partyDays = daysBetween(d, onLevelParty, FROM, TO);
  const carrierBaseline = makeCurve(d, level => typicalAcross(d, [TYPICAL_PARTY], level));

  const rowsFor = (comps: readonly XpComp[]): Row[] => comps.flatMap(c => d.meta.grid.flatMap(level => d.at(c.id, level))).filter(r => r.table.kind === 'room' && r.rate.win >= WIN_OK_PCT && !d.zero.has(r.table.index));
  const summarize = (label: string, comps: readonly XpComp[]): (string | number)[] => {
    const rows = rowsFor(comps);
    const bestAt = new Map<number, Row>();
    for (const r of rows) {
      const friend = friendIndex(r);
      const level = r.members[friend].level;
      const current = bestAt.get(level);
      if (!current || r.rate.xp[friend] > current.rate.xp[friendIndex(current)]) bestAt.set(level, r);
    }
    const levels = [...bestAt.keys()].sort((a, b) => a - b);
    if (levels.length === 0) return [label, '-', '-', '-', '-', '-', '-'];
    const curve = (level: number): number => {
      const below = levels.filter(l => l <= level).pop();
      const above = levels.find(l => l >= level);
      const value = (l: number): number => {
        const r = bestAt.get(l)!;
        return r.rate.xp[friendIndex(r)];
      };
      if (below === undefined) return value(above!);
      if (above === undefined) return value(below);
      if (below === above) return value(below);
      const t = (level - below) / (above - below);
      return value(below) ** (1 - t) * value(above) ** t;
    };
    const days = daysBetween(d, curve, FROM, TO);
    const carrierShares: number[] = [];
    const carrierRates: number[] = [];
    for (const level of levels) {
      if (level < FROM || level >= TO) continue;
      const r = bestAt.get(level)!;
      const carrier = carrierIndex(r);
      const baseline = carrierBaseline(r.members[carrier].level);
      carrierRates.push(r.rate.xp[carrier]);
      if (baseline > 0) carrierShares.push(r.rate.xp[carrier] / baseline);
    }
    return [label, days.toFixed(2), ratio(soloDays / days), ratio(partyDays / days), fmt(median(carrierRates)), ratio(median(carrierShares)), levels.filter(l => l >= FROM && l <= TO).length];
  };

  const shapes = [...new Set(carry.map(c => c.id.split(':')[0]))];
  const rows = [
    summarize('every shape', carry),
    ...shapes.map(shape => summarize(shape.slice(1), carry.filter(c => c.id.startsWith(`${shape}:`)))),
    ...carry.map(c => summarize(c.id.slice(1), [c])),
  ];
  const best = rows[0];
  const carryDays = Number(best[1]);
  const overSolo = soloDays / carryDays;
  const overParty = partyDays / carryDays;
  const carrierShare = Number(String(best[5]).replace('x', ''));
  const carrierFlag = carrierShare < CARRIER_FLAG_SHARE;
  return {
    id: 'I9',
    title: 'Power-levelling',
    pass: Number.isFinite(carryDays) || carryDays === Infinity ? overSolo > 1 && overParty > 1 : null,
    short: `carry ${best[1]} days, ${ratio(overSolo)} over solo, ${ratio(overParty)} over party`,
    values: { soloDays, partyDays, carryDays, speedupOverSolo: overSolo, speedupOverParty: overParty, carrierShare },
    magnitude: `L${FROM} to L${TO}: on-level solo ${soloDays.toFixed(1)} days, on-level ${TYPICAL_PARTY} ${partyDays.toFixed(1)} days, best carry ${best[1]} days (${ratio(overSolo)} over solo, ${ratio(overParty)} over party); the carrier earns ${best[5]} of an on-level party's rate${carrierFlag ? `, under the ${ratio(CARRIER_FLAG_SHARE)} flag` : ''}`,
    lines: [
      `Power levelling friends must work, so a carried friend must beat both an on-level solo and an on-level party. A carrier earning little doesn't stop it being possible, so that is flagged under ${ratio(CARRIER_FLAG_SHARE)}, not failed.`,
      '',
      `Days for a friend from L${FROM} to L${TO}, taking at each friend level the best room the carry party wins at least ${WIN_OK_PCT} %. "Carrier" is what the carrier earns in those rooms: XP/hr, and as a share of an on-level ${TYPICAL_PARTY} at the carrier's own level. Friend levels come from the grid minus the gap, interpolated.`,
      '',
      ...table(['shape : gap', 'friend days', 'vs on-level solo', 'vs on-level party', 'carrier XP/hr', 'carrier vs own on-level', 'friend levels measured'], rows),
    ],
  };
}

// --- I10 ---

interface DungeonLoop {
  dungeonId: string;
  name: string;
  compId: string;
  level: number;
  clearPct: number;
  runMs: number;
  /** What a repeat clear pays per member, after any weekly rule. */
  xpPerRun: number[];
  /** Looped all day: paid runs at the repeat rate, plus the idle rate for whatever a clear cap leaves of the day. */
  xpPerHour: number;
  /** Mean XP/hr while actually looping, at the repeat rate. */
  loopingXpPerHour: number;
  /** Mean XP a week per member on top of the repeat rate, from clears a weekly rule pays in full. */
  weeklyLump: number;
  /** The part of that lump beyond one clear a week, which counts in the premium. */
  weeklyExcess: number;
  floors: Row[];
  rule: DungeonWeeklyRule | undefined;
}

function soloEnterableDungeons(d: Data): Set<string> {
  const solo = new Set(d.meta.comps.flatMap((c, i) => (SOLO_IDS.includes(c.id) ? [i] : [])));
  const open = new Set<string>();
  for (const cell of d.cells) {
    const dungeonId = d.meta.tables[cell.table].dungeonId;
    if (dungeonId && !cell.ineligible && solo.has(cell.comp)) open.add(dungeonId);
  }
  return open;
}

export function weeklyRuleFor(policy: BossPolicy | undefined, dungeonId: string, oneCanEnter: boolean): DungeonWeeklyRule | undefined {
  const rule = policy?.dungeonWeekly;
  const found = typeof rule === 'function' ? rule(dungeonId, oneCanEnter) : rule;
  if (found) assertWeeklyRule(found, dungeonId);
  return found;
}

/** Scales one run's XP by a weekly rule: the repeat rate, and the lump a week's full clears add on top of it. */
export function applyWeeklyRule(xpPerRun: number, rule: DungeonWeeklyRule | undefined): { repeat: number; lump: number } {
  if (!rule) return { repeat: xpPerRun, lump: 0 };
  const repeat = xpPerRun * rule.repeatFactor;
  return { repeat, lump: rule.fullClearsPerWeek * (xpPerRun - repeat) };
}

/** What a weekly rule pays beyond one full clear a week. */
export function weeklyExcessXp(xpPerRun: number, rule: DungeonWeeklyRule | undefined): number {
  return rule ? Math.max(0, rule.fullClearsPerWeek - 1) * (xpPerRun - xpPerRun * rule.repeatFactor) : 0;
}

/** XP over `hours` hours of looping this dungeon; once a clear cap is hit the rest of those hours earn the idle rate. */
export function loopHoursXp(loop: Pick<DungeonLoop, 'runMs' | 'clearPct'> & { xpPerRun: number }, cap: number | undefined, hours: number, idleXp: number): number {
  const runs = (hours * HOUR_MS) / loop.runMs;
  const clearShare = loop.clearPct / 100;
  const paidRuns = cap !== undefined && runs * clearShare > cap ? cap / clearShare : runs;
  const spentHours = (paidRuns * loop.runMs) / HOUR_MS;
  return paidRuns * loop.xpPerRun + Math.max(0, hours - spentHours) * idleXp;
}

function dungeonLoops(d: Data): DungeonLoop[] {
  const byDungeon = new Map<string, XpTable[]>();
  for (const t of d.meta.tables) if (t.dungeonId) push(byDungeon, t.dungeonId, t);
  const loops: DungeonLoop[] = [];
  const cap = d.policy?.dungeonClearsPerDay;
  const soloOpen = d.policy?.dungeonWeekly ? soloEnterableDungeons(d) : new Set<string>();
  for (const [dungeonId, floors] of byDungeon) {
    const ordered = [...floors].sort((a, b) => a.floorIndex! - b.floorIndex!);
    const rule = weeklyRuleFor(d.policy, dungeonId, soloOpen.has(dungeonId));
    for (const comp of d.comps('core', 'extended')) {
      for (const level of d.meta.grid) {
        const rows = ordered.map(t => d.get(t.index, comp.id, level));
        if (rows.some(r => !r)) continue;
        let reach = 1;
        let timeMs = d.reentryMs;
        const xp = comp.members.map(() => 0);
        for (const r of rows as Row[]) {
          timeMs += reach * (r.rate.ms + d.meta.pauseMs);
          r.rate.xpf.forEach((x, m) => {
            xp[m] += reach * x;
          });
          reach *= r.rate.win / 100;
        }
        const idle = d.idleRoom(comp.id, level)?.xp ?? 0;
        const paid = xp.map(x => applyWeeklyRule(x, rule));
        const repeatXp = mean(paid.map(p => p.repeat));
        loops.push({
          dungeonId,
          name: ordered[0].dungeonName ?? dungeonId,
          compId: comp.id,
          level,
          clearPct: reach * 100,
          runMs: timeMs,
          xpPerRun: paid.map(p => p.repeat),
          xpPerHour: loopHoursXp({ runMs: timeMs, clearPct: reach * 100, xpPerRun: repeatXp }, cap, DAY_HOURS, idle) / DAY_HOURS,
          loopingXpPerHour: (repeatXp / timeMs) * HOUR_MS,
          weeklyLump: mean(paid.map(p => p.lump)),
          weeklyExcess: mean(xp.map(x => weeklyExcessXp(x, rule))),
          floors: rows as Row[],
          rule,
        });
      }
    }
  }
  return loops;
}

function bossBounties(d: Data): QuestLump[] {
  return d.ledger.repeatable.filter(q => ((d.content.quests?.[q.id]?.objectives ?? []) as any[]).some(o => {
    const def = o.kind === 'kill' ? d.content.monsters[o.monsterId] : undefined;
    return !!def && ['boss', 'raid'].includes(d.mod.effectiveMonsterTier(def));
  }));
}

interface SoloLoopCase {
  loop: DungeonLoop;
  className: string;
  /** The room idleRoom picks. Undefined: no paying non-boss room this class wins alone. */
  room: Row | undefined;
  roomXp: number;
  ratio: number;
}

/** No solo dungeon as an XP source: each lone loop that clears, against the best room the class wins alone. The room may sit on the win line, so a plan can't fail because a rival room reads just under it. A dungeon only makes this list if one player can enter it. */
function soloLoopCases(d: Data): SoloLoopCase[] {
  return dungeonLoops(d).filter(l => CLASS_BY_SOLO_ID.has(l.compId) && l.clearPct >= WIN_OK_PCT).map(loop => {
    const room = d.idleRoom(loop.compId, loop.level);
    const roomXp = room?.rate.xp[0] ?? 0;
    return { loop, className: CLASS_BY_SOLO_ID.get(loop.compId)!, room, roomXp, ratio: safeRatio(loop.xpPerHour, roomXp) };
  });
}

function referenceFarmParties(d: Data): string[] {
  return [FULL_PARTY, TYPICAL_PARTY, 'K+P', ...SOLO_IDS].filter(id => d.has(id));
}

function farmRows(d: Data, compIds: readonly string[] = referenceFarmParties(d)) {
  const loops = dungeonLoops(d);
  const loopsAt = new Map<string, DungeonLoop[]>();
  for (const l of loops) if (l.clearPct >= WIN_OK_PCT) push(loopsAt, `${l.compId}|${l.level}`, l);
  const bounties = bossBounties(d);
  const cap = d.policy?.dungeonClearsPerDay;
  const h = d.activeHours;
  return compIds.flatMap(compId => d.meta.grid.map(level => {
    const here = wonRooms(d, compId, level, undefined, clearWin);
    const idle = d.idleRoom(compId, level);
    const idleXp = idle?.xp ?? 0;
    const bossRooms = here.filter(r => r.table.boss);
    const boss = maxBy(bossRooms, r => d.bossDayRate(r));
    const bossXp = boss ? d.bossDayRate(boss) : 0;
    const atLoops = loopsAt.get(`${compId}|${level}`) ?? [];
    const dungeon = maxBy(atLoops, l => l.xpPerHour);
    const dailyIdle = idleXp * DAY_HOURS;
    const bossActive = bossRooms.map(r => {
      const split = r.rate.bs;
      const inRoom = split && hasBossRule(d.policy)
        ? mean(r.members.map((_, m) => bossHoursXp(split, m, d.policy!, d.meta.pauseMs, h, idle?.rate.xp[m] ?? 0)))
        : r.xp * h;
      return inRoom + (DAY_HOURS - h) * idleXp;
    });
    const loopActive = atLoops.map(l => loopHoursXp({ runMs: l.runMs, clearPct: l.clearPct, xpPerRun: mean(l.xpPerRun) }, cap, h, idleXp) + (DAY_HOURS - h) * idleXp);
    const dailyActive = Math.max(dailyIdle, bossXp * DAY_HOURS, ...bossActive, ...loopActive);
    return {
      compId,
      level,
      idle,
      boss,
      bossXp,
      dungeon,
      idleXp,
      dailyIdle,
      dailyActive,
      weeklyPerDay: repeatableXpPerHour(d.ledger.repeatable, level) * DAY_HOURS,
      bountyPerDay: repeatableXpPerHour(bounties, level) * DAY_HOURS,
      fullClearsPerDay: maxOf(atLoops.map(l => l.weeklyLump)) / 7 || 0,
      excessClearsPerDay: maxOf(atLoops.map(l => l.weeklyExcess)) / 7 || 0,
    };
  })).filter(x => (x.idle && (x.boss || x.dungeon)) || x.bossXp > 0 || (x.dungeon?.xpPerHour ?? 0) > 0);
}

/** Floors written at 0 XP are reported. A floor whose content pays, cut to nothing for a party winning it, breaks the rule that repeat clears stay above zero XP. */
function floorZeros(d: Data): { floors: XpTable[]; written: XpTable[]; cutToNothing: XpTable[] } {
  const floors = d.meta.tables.filter(t => t.kind === 'floor');
  return {
    floors,
    written: floors.filter(t => t.zeroXp),
    cutToNothing: floors.filter(t => !t.zeroXp && d.ofTable(t.index).some(r => r.rate.win >= WIN_OK_PCT && r.rate.xpf.some(x => x === 0))),
  };
}

const IDLE_DAY_PARTIES = [TYPICAL_PARTY, FULL_PARTY, ...SOLO_IDS];

function daysOfIdle(d: Data, xp: number, compId: string, level: number): number {
  const rate = d.idleRoom(compId, level)?.xp ?? 0;
  return rate > 0 ? xp / (rate * DAY_HOURS) : NaN;
}

function daysCell(days: number): string {
  return Number.isFinite(days) ? days.toFixed(1) : '-';
}

/** First clears and weeklies, which are allowed: their size stays visible and no verdict counts them. */
function idleDayLines(d: Data): { lines: string[]; firstClearTotal: number; weeklyTotal: number } {
  const parties = IDLE_DAY_PARTIES.filter(id => d.has(id));
  const loops = dungeonLoops(d);
  const firstClears = (Object.values(d.content.dungeons) as any[]).filter(x => (x.firstClearXp ?? 0) > 0).map(x => {
    const clearing = loops.filter(l => l.dungeonId === x.id && l.clearPct >= WIN_OK_PCT).map(l => l.level);
    const level = clearing.length ? Math.min(...clearing) : nearestGridLevel(d, x.entryRequirements?.minLevel ?? 1);
    return { name: x.name as string, xp: x.firstClearXp as number, level };
  }).sort((a, b) => a.level - b.level);
  const bounties = new Set(bossBounties(d).map(q => q.id));
  const weeklies = [...d.ledger.repeatable].sort((a, b) => a.availableAt - b.availableAt);
  let curve = 0;
  for (let level = 1; level < MAX_LEVEL; level++) curve += d.mod.xpForNextLevel(level);
  const firstClearTotal = firstClears.reduce((sum, x) => sum + x.xp, 0);
  const weeklyTotal = weeklies.reduce((sum, q) => sum + q.xp, 0);
  return {
    firstClearTotal,
    weeklyTotal,
    lines: [
      `First clears and weekly quests, boss-kill weeklies included, are allowed and count against no verdict. Days of idle XP: the reward over that party's best non-boss room for a day, at the level shown. A first clear uses the lowest grid level any party clears it at. First clears total ${fmt(firstClearTotal)}, ${((100 * firstClearTotal) / curve).toFixed(1)} % of the XP to L${MAX_LEVEL}.`,
      '',
      ...table(['first clear', 'XP', 'level', ...parties.map(id => `days, ${id}`)], firstClears.map(x => [x.name, fmt(x.xp), x.level, ...parties.map(id => daysCell(daysOfIdle(d, x.xp, id, x.level)))])),
      '',
      ...table(['weekly quest', 'level', 'XP a week', 'kills a boss', ...parties.map(id => `days, ${id}`)], weeklies.map(q => {
        const level = nearestGridLevel(d, q.availableAt);
        return [q.name, q.availableAt, fmt(q.xp), bounties.has(q.id) ? 'yes' : 'no', ...parties.map(id => daysCell(daysOfIdle(d, q.xp, id, level)))];
      })),
    ],
  };
}

export function metricI10(d: Data): Metric {
  const bounties = bossBounties(d);
  const h = d.activeHours;
  const rows = farmRows(d, d.comps('core', 'extended').map(c => c.id));
  const referenceIds = referenceFarmParties(d);
  const bossAbove = rows.filter(x => x.boss && x.bossXp > x.idleXp);
  const dungeonAbove = rows.filter(x => x.dungeon && x.dungeon.xpPerHour > x.idleXp);
  const worstBoss = maxOf(bossAbove.map(x => safeRatio(x.bossXp, x.idleXp)));
  const worstDungeon = maxOf(dungeonAbove.map(x => safeRatio(x.dungeon!.xpPerHour, x.idleXp)));
  const premium = rows.map(x => safeRatio(x.dailyActive + x.excessClearsPerDay, x.dailyIdle));
  const withBounties = rows.map(x => safeRatio(x.dailyActive + x.bountyPerDay, x.dailyIdle));
  const withWeeklies = rows.map(x => safeRatio(x.dailyActive + x.weeklyPerDay, x.dailyIdle));
  const withFullClears = rows.map(x => safeRatio(x.dailyActive + x.fullClearsPerDay, x.dailyIdle));
  const refRows = rows.filter(x => x.compId === FULL_PARTY || x.compId === TYPICAL_PARTY);
  const atReference = (x: { compId: string }): boolean => referenceIds.includes(x.compId);
  const referenceRows = rows.filter(atReference);
  const referencePremium = referenceRows.map(x => safeRatio(x.dailyActive + x.excessClearsPerDay, x.dailyIdle));
  const referenceWithBounties = referenceRows.map(x => safeRatio(x.dailyActive + x.bountyPerDay, x.dailyIdle));
  const referenceWithWeeklies = referenceRows.map(x => safeRatio(x.dailyActive + x.weeklyPerDay, x.dailyIdle));
  const zeroFloors = floorZeros(d);
  const noIdleRoom = rows.filter(x => !x.idle);
  const entrances = d.meta.tables.filter(t => t.kind === 'room' && t.dungeonTiles > 0);
  const entranceCount = entrances.reduce((sum, t) => sum + t.dungeonTiles, 0);
  const entrancesPayingNothing = entrances.filter(t => d.zero.has(t.index)).reduce((sum, t) => sum + t.dungeonTiles, 0);
  const bossRooms = d.meta.tables.filter(t => t.kind === 'room' && t.boss);
  const solo = soloLoopCases(d);
  const soloOver = solo.filter(c => c.ratio > 1);
  const soloBeyond = solo.filter(c => c.ratio > 1 + NOISE_TOLERANCE);
  const soloDungeons = [...new Set(soloOver.map(c => c.loop.dungeonId))];
  const idleDays = idleDayLines(d);
  const openDungeons = soloEnterableDungeons(d);
  const headers = ['party', 'level', 'best idle XP/hr', 'room', 'best boss XP/hr', 'room', 'boss / idle', 'best dungeon XP/hr', 'dungeon', 'dungeon / idle', 'active premium', 'with boss-kill weeklies', 'with every weekly'];
  const fmtRow = (x: typeof rows[number]): (string | number)[] => [
    x.compId,
    x.level,
    fmt(x.idleXp),
    x.idle ? place(x.idle) : '-',
    x.boss ? fmt(x.bossXp) : '-',
    x.boss ? place(x.boss) : '-',
    x.boss ? ratio(safeRatio(x.bossXp, x.idleXp)) : '-',
    x.dungeon ? fmt(x.dungeon.xpPerHour) : '-',
    x.dungeon?.name ?? '-',
    x.dungeon ? ratio(safeRatio(x.dungeon.xpPerHour, x.idleXp)) : '-',
    ratio(safeRatio(x.dailyActive, x.dailyIdle)),
    ratio(safeRatio(x.dailyActive + x.bountyPerDay, x.dailyIdle)),
    ratio(safeRatio(x.dailyActive + x.weeklyPerDay, x.dailyIdle)),
  ];
  const bountyRows = bounties.map(q => {
    const quest = d.content.quests![q.id];
    const targets = ((quest.objectives ?? []) as any[]).filter(o => o.kind === 'kill').map(o => `${d.content.monsters[o.monsterId]?.name ?? o.monsterId} x${o.count ?? 1} (${d.mod.effectiveMonsterTier(d.content.monsters[o.monsterId])})`);
    const idleRate = d.idleRoom(TYPICAL_PARTY, nearestGridLevel(d, q.availableAt))?.xp ?? NaN;
    return [q.name, q.availableAt, fmt(q.xp), targets.join(', '), fmt(idleRate * DAY_HOURS), ratio(q.xp / (idleRate * DAY_HOURS))];
  });
  const pass = rows.length || solo.length ? !(worstBoss > FARM_PASS_RATIO) && !(worstDungeon > FARM_PASS_RATIO) && !(quantile(premium, 0.9) > FARM_PASS_RATIO) && soloBeyond.length === 0 && zeroFloors.cutToNothing.length === 0 : null;
  const soloWorst = [...soloOver].sort((a, b) => b.ratio - a.ratio);
  const soloByDungeon = [...new Set(solo.map(c => c.loop.dungeonId))].map(id => {
    const list = solo.filter(c => c.loop.dungeonId === id);
    const over = list.filter(c => c.ratio > 1);
    return [list[0].loop.name, list.length, over.length, list.filter(c => c.ratio > 1 + NOISE_TOLERANCE).length, ratio(maxOf(list.map(c => c.ratio))), ratio(median(list.map(c => c.ratio)))];
  });
  const hasWeeklyRule = !!d.policy?.dungeonWeekly;
  const allLoops = dungeonLoops(d);
  const gearRunRows = [...new Set(zeroFloors.floors.map(t => t.dungeonId!))].map(id => {
    const here = zeroFloors.floors.filter(t => t.dungeonId === id);
    const clearing = allLoops.filter(l => l.dungeonId === id && l.clearPct >= WIN_OK_PCT);
    const shares = clearing.flatMap(l => {
      const idle = d.idleRoom(l.compId, l.level)?.xp ?? 0;
      return idle > 0 ? [l.loopingXpPerHour / idle] : [];
    });
    return [here[0].dungeonName ?? id, openDungeons.has(id) ? 'yes' : 'no', here.length, here.filter(t => t.zeroXp).length, zeroFloors.cutToNothing.filter(t => t.dungeonId === id).length, clearing.length, ratio(median(shares)), ratio(minOf(shares)), ratio(maxOf(shares))];
  });
  return {
    id: 'I10',
    title: 'Boss and dungeon farming',
    pass,
    short: `boss ${ratio(worstBoss)}, loop ${ratio(worstDungeon)}, solo loops ${soloBeyond.length}/${solo.length}, premium ${ratio(quantile(premium, 0.9))}, floors cut to nothing ${zeroFloors.cutToNothing.length}`,
    values: {
      bossPairsAbove: bossAbove.length, bossPairs: rows.filter(x => x.boss).length, worstBoss,
      loopPairsAbove: dungeonAbove.length, loopPairs: rows.filter(x => x.dungeon).length, worstLoop: worstDungeon,
      premiumMedian: median(premium), premiumP90: quantile(premium, 0.9),
      premiumP90WithBossWeeklies: quantile(withBounties, 0.9), premiumMedianWithWeeklies: median(withWeeklies), premiumP90WithWeeklies: quantile(withWeeklies, 0.9),
      premiumP90WithWeeklyFullClears: quantile(withFullClears, 0.9),
      soloLoopCases: solo.length, soloLoopsOver: soloOver.length, soloLoopsOverBeyondNoise: soloBeyond.length, soloLoopDungeonsOver: soloDungeons.length, soloDungeons: openDungeons.size, worstSoloLoop: maxOf(solo.map(c => c.ratio)),
      firstClearXpTotal: idleDays.firstClearTotal, weeklyXpTotal: idleDays.weeklyTotal,
      floorsCutToNothing: zeroFloors.cutToNothing.length, floorsWrittenAtZero: zeroFloors.written.length, entrancesPayingNothing, entrances: entranceCount, partyLevelsWithNoIdleRoom: noIdleRoom.length,
      referenceBossPairsAbove: bossAbove.filter(atReference).length, referenceLoopPairsAbove: dungeonAbove.filter(atReference).length, referencePremiumP90: quantile(referencePremium, 0.9),
    },
    magnitude: `boss rooms beat the best non-boss room at ${bossAbove.length}/${rows.filter(x => x.boss).length} level + party pairs (worst ${ratio(worstBoss)}), dungeon loops at ${dungeonAbove.length}/${rows.filter(x => x.dungeon).length} (worst ${ratio(worstDungeon)}); a lone player's loop pays over the class's best solo room at ${soloOver.length}/${solo.length} cases clearing at least ${WIN_OK_PCT} %, in ${soloDungeons.length} of the ${openDungeons.size} dungeons one player can enter (${soloBeyond.length} by over ${NOISE_TOLERANCE * 100} %, worst ${ratio(maxOf(solo.map(c => c.ratio)))}); active premium for ${h} h/day, weeklies left out, median ${ratio(median(premium))}, p90 ${ratio(quantile(premium, 0.9))}; reported only: with boss-kill weeklies p90 ${ratio(quantile(withBounties, 0.9))}, with every weekly median ${ratio(median(withWeeklies))}, p90 ${ratio(quantile(withWeeklies, 0.9))}; ${zeroFloors.written.length} of ${zeroFloors.floors.length} floors are written at 0 XP, ${zeroFloors.cutToNothing.length} more are cut to nothing; ${entrancesPayingNothing} of ${entranceCount} dungeon entrances are in rooms paying nothing`,
    lines: [
      `Every core and extended party counts for the verdict, not just the reference parties; the reference parties alone read boss rooms over at ${bossAbove.filter(atReference).length} pairs, worst ${ratio(maxOf(bossAbove.filter(atReference).map(x => safeRatio(x.bossXp, x.idleXp))))}, loops at ${dungeonAbove.filter(atReference).length}, worst ${ratio(maxOf(dungeonAbove.filter(atReference).map(x => safeRatio(x.dungeon!.xpPerHour, x.idleXp))))}, premium p90 ${ratio(quantile(referencePremium, 0.9))}, with boss-kill weeklies ${ratio(quantile(referenceWithBounties, 0.9))}, with every weekly ${ratio(quantile(referenceWithWeeklies, 0.9))}. ${noIdleRoom.length} party + level pairs have a paying boss room or loop but no paying non-boss room they win, which reads as infinitely over it. Loops charge the wait to re-enter as earning nothing, so where the entrance room pays, a real loop earns a little more than shown.`,
      '',
      `${bossRooms.reduce((sum, t) => sum + t.tileCount, 0)} overworld rooms hold boss encounters, in ${bossRooms.length} tables. Winning at least ${WIN_OK_PCT} %. Boss rooms loop unattended, so a boss room beating the best room is itself the farm. Dungeon loops charge ${d.reentryMs / 1000} s to re-enter by hand and need a clear rate of at least ${WIN_OK_PCT} %. Active premium: the best of idling all day, sitting in the best boss room all day, or ${h} h a day on the best boss or dungeon loop plus the best unattended room for the rest, over the best non-boss room all day. Floored at 1x: a player would just not do a worse loop. Passes with boss rooms and loops within ${FARM_PASS_RATIO}x of the best non-boss room, the p90 premium without any weekly within ${FARM_PASS_RATIO}x, no solo loop over the class's best solo room by over ${NOISE_TOLERANCE * 100} %, and no floor whose content pays cut to nothing. First clears and weeklies never count.${hasWeeklyRule ? ` This plan has a weekly dungeon rule: loops read at their repeat rate, and with the full clears as a lump the premium's p90 is ${ratio(quantile(withFullClears, 0.9))}, reported only. Clears past the first each week do count in the premium.` : ''}`,
      '',
      ...table(headers, refRows.map(fmtRow)),
      '',
      `**No solo dungeon as an XP source.** For every dungeon one player can enter: the loop against the best paying non-boss room that class clearly wins alone, at the same level, per class and level clearing at least ${WIN_OK_PCT} %:`,
      '',
      ...table(['dungeon', 'cases', 'pays more', `by over ${NOISE_TOLERANCE * 100} %`, 'worst', 'median'], soloByDungeon),
      '',
      ...table(['dungeon', 'class', 'level', 'clear %', 'loop XP/hr', 'best solo room', 'room XP/hr', 'ratio'], soloWorst.slice(0, TOP_OFFENDERS).map(c => [c.loop.name, c.className, c.loop.level, c.loop.clearPct.toFixed(0), fmt(c.loop.xpPerHour), c.room ? place(c.room) : 'none won', fmt(c.roomXp), ratio(c.ratio)])),
      '',
      `Worst boss rooms against the best non-boss room, every party:`,
      '',
      ...table(headers, [...bossAbove].sort((a, b) => b.bossXp / b.idleXp - a.bossXp / a.idleXp).slice(0, TOP_OFFENDERS).map(fmtRow)),
      '',
      `Worst dungeon loops against the best non-boss room, every party:`,
      '',
      ...table(headers, [...dungeonAbove].sort((a, b) => b.dungeon!.xpPerHour / b.idleXp - a.dungeon!.xpPerHour / a.idleXp).slice(0, TOP_OFFENDERS).map(fmtRow)),
      '',
      `What's left for a player who runs a dungeon for gear, at its repeat rate, and whether anyone can get stuck earning nothing. A floor written at 0 XP is reported, and one the plan cuts to nothing fails, since monster XP in a detuned dungeon must stay above zero. Loop over the party's best non-boss room, across parties clearing it at least ${WIN_OK_PCT} %. ${entrancesPayingNothing} of ${entranceCount} dungeon entrances are in rooms paying nothing, so a party that finishes a run and goes AFK there earns nothing:`,
      '',
      ...table(['dungeon', 'one player can enter', 'floors', 'written at 0 XP', 'cut to nothing', 'clearing loops', 'median loop / room', 'lowest', 'highest'], gearRunRows),
      '',
      'Weekly quests with a boss kill objective, which the boss metric above doesn\'t see. They are allowed, so the verdict\'s premium leaves them out and they are reported:',
      '',
      ...table(['quest', 'available at level', 'XP a week', 'kill', `a day idle, ${TYPICAL_PARTY}`, 'weekly / a day idle'], bountyRows),
      '',
      ...idleDays.lines,
    ],
  };
}

// --- I16 and Gold ---

export interface GoldLoop {
  loop: DungeonLoop;
  /** Read like the loop's own, off any fresh read the gold lines took. */
  clearPct: number;
  runMs: number;
  /** Per member, per attempt, before any weekly rule. */
  full: RunGold[];
  /** Per member, per attempt, at the repeat rate. */
  repeat: RunGold[];
  /** Coin plus floor rewards an hour per member at the repeat rate, with any clear cap: what I16 reads. */
  goldPerHour: number[];
  /** The same before any weekly rule. */
  fullPerHour: number[];
  /** Monster drops' sale value an hour per member, reported apart. */
  dropsPerHour: number[];
  /** The same as the atlas's own content pays it. */
  atlasDropsPerHour: number[];
  /** Mean gold a week per member on top of the repeat rate, from clears a weekly rule pays in full. */
  weeklyLump: number;
  /** Per member, floor by floor, for a run stopping early. */
  floorReads: (FloorGoldRead & { cycleMs: number })[][];
  /** What an hour earns in the room this party would stand in for XP. */
  idleCoin: number;
}

function goldLoops(d: Data, reentryMs = d.reentryMs, keep: (compId: string) => boolean = () => true): GoldLoop[] {
  const cap = d.policy?.dungeonClearsPerDay;
  const rewardMemo = new Map<string, number>();
  const rewardOf = (r: Row, className: string): number => {
    const key = `${r.table.index}|${className}`;
    let value = rewardMemo.get(key);
    if (value === undefined) {
      value = floorRewardValue(d.content.dungeons[r.table.dungeonId!]?.floors?.[r.table.floorIndex!], className, d.content.items);
      rewardMemo.set(key, value);
    }
    return value;
  };
  return dungeonLoops(d).filter(loop => keep(loop.compId)).map(loop => {
    const idle = d.idleRoom(loop.compId, loop.level);
    const idleCoin = idle ? d.coinPerHour(idle) : 0;
    const reads = loop.floors.map(r => ({ r, rate: d.goldRate(r) }));
    let reach = 1;
    let runMs = reentryMs;
    for (const { rate } of reads) {
      runMs += reach * (rate.ms + d.meta.pauseMs);
      reach *= rate.win / 100;
    }
    const clearPct = reach * 100;
    const floorReads = loop.floors[0].members.map((member, m) => reads.map(({ r, rate }) => ({ winPct: rate.win, coinPerFight: rate.g?.cf ?? 0, dropsPerFight: rate.g?.df[m] ?? 0, rewardPerWin: rewardOf(r, member.className), cycleMs: rate.ms + d.meta.pauseMs })));
    const full = floorReads.map(loopRunGold);
    const atlasDrops = loop.floors[0].members.map((_, m) => loopRunGold(reads.map(({ rate }) => ({ winPct: rate.win, coinPerFight: 0, dropsPerFight: (rate.g?.atlas ?? rate.g)?.df[m] ?? 0, rewardPerWin: 0 }))).drops);
    const paid = full.map(run => applyGoldFactors(run, goldFactors(loop.rule), loop.rule?.fullClearsPerWeek ?? 0));
    const over = (perRun: number): number => loopHoursXp({ runMs, clearPct, xpPerRun: perRun }, cap, DAY_HOURS, idleCoin) / DAY_HOURS;
    return {
      loop,
      clearPct,
      runMs,
      full,
      repeat: paid.map(p => p.repeat),
      goldPerHour: paid.map(p => over(p.gold)),
      fullPerHour: full.map(run => over(run.coin + run.rewards)),
      dropsPerHour: full.map(run => (run.drops / runMs) * HOUR_MS),
      atlasDropsPerHour: atlasDrops.map(drops => (drops / runMs) * HOUR_MS),
      weeklyLump: mean(paid.map(p => p.lump)),
      floorReads,
      idleCoin,
    };
  });
}

/** The richest room this party plausibly wins at this level, the same side of the win line I10's solo line takes. */
function richestRoom(d: Data, compId: string, level: number, keep: (r: Row) => boolean = () => true): Row | undefined {
  return maxBy(d.at(compId, level).filter(r => r.table.kind === 'room' && d.goldWon(r) && d.coinPerHour(r) > 0 && keep(r)), r => d.coinPerHour(r));
}

const notBossRoom = (r: Row): boolean => !r.table.boss;

interface GoldYardstick {
  /** The room behind `coin`. Undefined: no paying room won, or the atlas's own content pays nothing in them. */
  room: Row | undefined;
  coin: number;
}

/** The richest room as the plan pays it, held at or under the richest as the atlas's own content pays it: a plan can lower this line, not lift it. */
function goldYardstick(d: Data, compId: string, level: number, keep: (r: Row) => boolean = notBossRoom): GoldYardstick {
  const rooms = d.at(compId, level).filter(r => r.table.kind === 'room' && d.goldWon(r) && keep(r));
  const planRoom = maxBy(rooms.filter(r => d.coinPerHour(r) > 0), r => d.coinPerHour(r));
  const atlasRoom = maxBy(rooms.filter(r => d.atlasCoinPerHour(r) > 0), r => d.atlasCoinPerHour(r));
  const planCoin = planRoom ? d.coinPerHour(planRoom) : 0;
  const atlasCoin = atlasRoom ? d.atlasCoinPerHour(atlasRoom) : 0;
  return atlasCoin < planCoin ? { room: atlasRoom, coin: atlasCoin } : { room: planRoom, coin: planCoin };
}

interface LoneStop {
  /** Floors tried before walking out. */
  floors: number;
  runMs: number;
  /** Share of attempts winning all of them. */
  reach: number;
  /** One attempt at the repeat rate. */
  repeat: RunGold;
  /** Coin plus floor rewards an hour at the repeat rate, with any clear cap. */
  perHour: number;
  /** The same as a loop before any cap, for reading a capped loop per hour spent in it. */
  activePerHour: number;
}

/** The richest place for a lone player to walk out, the full run on a tie. A run needn't clear to earn: floors pay as they're won. */
function bestLoneStop(d: Data, g: GoldLoop, reentryMs: number): LoneStop {
  const factors = goldFactors(g.loop.rule);
  const cap = d.policy?.dungeonClearsPerDay;
  const stops = goldStops(g.floorReads[0], reentryMs).map(stop => {
    const paid = applyGoldFactors(stop.run, factors, 0);
    return {
      floors: stop.floors,
      runMs: stop.runMs,
      reach: stop.reach,
      repeat: paid.repeat,
      perHour: loopHoursXp({ runMs: stop.runMs, clearPct: stop.reach * 100, xpPerRun: paid.gold }, cap, DAY_HOURS, g.idleCoin) / DAY_HOURS,
      activePerHour: (paid.gold / stop.runMs) * HOUR_MS,
    };
  });
  return maxBy([...stops].reverse(), stop => stop.perHour)!;
}

interface LoneLoop {
  gold: GoldLoop;
  className: string;
  stop: LoneStop;
}

/** Every lone loop that wins its first floor at all. A dungeon only makes this list if one player passes its door, which the atlas read through the real entry rule. */
function loneLoops(d: Data, reentryMs = d.reentryMs): LoneLoop[] {
  return goldLoops(d, reentryMs, id => CLASS_BY_SOLO_ID.has(id)).filter(g => g.floorReads[0][0].winPct > 0).map(gold => ({
    gold,
    className: CLASS_BY_SOLO_ID.get(gold.loop.compId)!,
    stop: bestLoneStop(d, gold, reentryMs),
  }));
}

export interface SoloGoldCase {
  gold: GoldLoop;
  className: string;
  /** The richest place to walk out, which may be the full run: what the verdict reads. */
  stop: LoneStop;
  /** The yardstick: the class's richest ordinary room alone, held at or under what the atlas's own content pays. Undefined: none won. */
  room: Row | undefined;
  roomCoin: number;
  ratio: number;
  /** A full clear alone against the same room. */
  fullRatio: number;
  /** The class's richest room with boss rooms let in, reported. */
  anyRoom: Row | undefined;
  anyRoomRatio: number;
  /** The room it would stand in for XP, reported. */
  xpRoom: Row | undefined;
  xpRoomCoin: number;
  xpRoomRatio: number;
  /** The richest room of any human party holding this class, reported. */
  partyRoom: Row | undefined;
  partyRoomCoin: number;
  partyRoomRatio: number;
  /** The best loop any human party holding this class clears, per member of the class, reported. */
  partyLoop: GoldLoop | undefined;
  partyLoopGold: number;
}

/** No solo dungeon as a gold source: each lone loop, against the class's rooms at that level. */
export function soloGoldCases(d: Data): SoloGoldCase[] {
  const loops = goldLoops(d).filter(g => g.clearPct >= WIN_OK_PCT);
  const layouts = humanLayouts(d);
  const memberOf = (comp: XpComp | undefined, className: string): number => comp?.members.findIndex(m => m.className === className) ?? -1;
  const compById = new Map(d.meta.comps.map(c => [c.id, c]));
  const partyLoops = new Map<string, { gold: GoldLoop; value: number }>();
  for (const g of loops) {
    const comp = compById.get(g.loop.compId);
    if (!comp || comp.members.length < 2) continue;
    for (const className of new Set(comp.members.map(m => m.className))) {
      const value = g.goldPerHour[memberOf(comp, className)];
      const key = `${className}|${g.loop.level}`;
      if (!(value <= (partyLoops.get(key)?.value ?? -1))) partyLoops.set(key, { gold: g, value });
    }
  }
  const partyRooms = new Map<string, Row | undefined>();
  const bestPartyRoom = (className: string, level: number): Row | undefined => {
    const key = `${className}|${level}`;
    if (!partyRooms.has(key)) {
      const rooms = layouts.filter(c => memberOf(c, className) >= 0).flatMap(c => richestRoom(d, c.id, level) ?? []);
      partyRooms.set(key, maxBy(rooms, r => d.coinPerHour(r)));
    }
    return partyRooms.get(key);
  };
  const coinOf = (r: Row | undefined): number => (r ? d.coinPerHour(r) : 0);
  return loneLoops(d).map(({ gold: g, className, stop }) => {
    const { compId, level } = g.loop;
    const gold = stop.perHour;
    const { room, coin: roomCoin } = goldYardstick(d, compId, level);
    const { room: anyRoom, coin: anyRoomCoin } = goldYardstick(d, compId, level, () => true);
    const xpRoom = d.idleRoom(compId, level);
    const partyRoom = bestPartyRoom(className, level);
    const partyLoop = partyLoops.get(`${className}|${level}`);
    return {
      gold: g,
      className,
      stop,
      room,
      roomCoin,
      ratio: safeRatio(gold, roomCoin),
      fullRatio: safeRatio(g.goldPerHour[0], roomCoin),
      anyRoom,
      anyRoomRatio: safeRatio(gold, anyRoomCoin),
      xpRoom,
      xpRoomCoin: coinOf(xpRoom),
      xpRoomRatio: safeRatio(gold, coinOf(xpRoom)),
      partyRoom,
      partyRoomCoin: coinOf(partyRoom),
      partyRoomRatio: safeRatio(gold, coinOf(partyRoom)),
      partyLoop: partyLoop?.gold,
      partyLoopGold: partyLoop?.value ?? 0,
    };
  });
}

function doorText(requirements: Record<string, any> | undefined): string {
  const req = requirements ?? {};
  const parts = [
    req.minLevel !== undefined ? `L${req.minLevel}+` : '',
    req.maxLevel !== undefined ? `to L${req.maxLevel}` : '',
    req.minPartySize !== undefined ? `at least ${req.minPartySize}` : '',
    req.maxPartySize !== undefined ? `at most ${req.maxPartySize}` : '',
    req.requiredClasses?.length ? `${req.requiredClasses.join(', ')} only` : '',
    req.requiredItemId ? 'a key' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'open';
}

function hasGold(d: Data): boolean {
  return d.rows.some(r => r.rate.g);
}

const NO_GOLD_FIGURES = 'this run holds no gold figures: evaluate the plan again';

/** The verdict's own count under another re-entry wait, with no second looks taken for it. */
function overAtReentry(d: Data, reentryMs: number): number {
  const line = 1 + NOISE_TOLERANCE;
  const yardsticks = new Map<string, number>();
  const coinFor = (compId: string, level: number): number => {
    const key = `${compId}|${level}`;
    let coin = yardsticks.get(key);
    if (coin === undefined) {
      coin = goldYardstick(d, compId, level).coin;
      yardsticks.set(key, coin);
    }
    return coin;
  };
  return loneLoops(d, reentryMs).filter(({ gold, stop }) => safeRatio(stop.perHour, coinFor(gold.loop.compId, gold.loop.level)) > line).length;
}

interface PartyInOpenDungeon {
  gold: GoldLoop;
  ratio: number;
}

/** Parties clearing a dungeon one player could also enter, against their own richest ordinary room: not in the verdict, whose rule may or may not reach them. */
function partiesInOpenDungeons(d: Data, open: ReadonlySet<string>): PartyInOpenDungeon[] {
  const compIndex = new Map(d.meta.comps.map(c => [c.id, c]));
  return goldLoops(d, d.reentryMs, id => (compIndex.get(id)?.members.length ?? 1) >= 2)
    .filter(g => g.clearPct >= WIN_OK_PCT && open.has(g.loop.dungeonId))
    .map(gold => ({ gold, ratio: safeRatio(mean(gold.goldPerHour), goldYardstick(d, gold.loop.compId, gold.loop.level).coin) }));
}

export function metricI16(d: Data): Metric {
  if (!hasGold(d)) return { id: 'I16', title: 'No solo dungeon for gold', pass: null, magnitude: NO_GOLD_FIGURES, lines: [] };
  const cases = soloGoldCases(d);
  const open = soloEnterableDungeons(d);
  const line = 1 + NOISE_TOLERANCE;
  const over = cases.filter(c => c.ratio > 1);
  const beyond = cases.filter(c => c.ratio > line);
  const beyondWithBoss = cases.filter(c => c.anyRoomRatio > line);
  const inDungeons = new Set(beyond.map(c => c.gold.loop.dungeonId));
  const worst = maxOf(cases.map(c => c.ratio));
  const clears = (c: SoloGoldCase): boolean => c.gold.clearPct >= WIN_OK_PCT;
  const clearing = cases.filter(clears);
  const clearingBeyond = clearing.filter(c => c.fullRatio > line);
  const beyondWithoutClearing = beyond.filter(c => !clears(c));
  const onlyStoppingEarly = beyond.filter(c => c.fullRatio <= line);
  const noRoom = cases.filter(c => !c.room && c.stop.perHour > 0);
  const nothingAgainstNothing = cases.filter(c => !c.room && !(c.stop.perHour > 0));
  const dropsRaised = cases.filter(c => c.gold.dropsPerHour[0] > c.gold.atlasDropsPerHour[0] * GOLD_RAISED_LINE);
  const mostlyMeasured = cases.length > 0 && nothingAgainstNothing.length * 2 <= cases.length;
  const finiteWorst = maxOf(cases.flatMap(c => (Number.isFinite(c.ratio) ? [c.ratio] : [])));
  const overLine = (list: readonly SoloGoldCase[], at: number): number => list.filter(c => c.ratio > at * line).length;
  const headline = (values: readonly number[]): string => (values.length ? `median ${ratio(median(values))}, worst ${ratio(maxOf(values))}` : 'none');
  const dropsAnHour = (c: SoloGoldCase): number => (c.stop.repeat.drops / c.stop.runMs) * HOUR_MS;
  const roomWithDrops = (c: SoloGoldCase): number => maxOf(d.at(c.gold.loop.compId, c.gold.loop.level).filter(r => r.table.kind === 'room' && notBossRoom(r) && d.goldWon(r)).map(r => d.coinPerHour(r) + (d.goldRate(r).g?.dh[0] ?? 0)));
  const frozenXpRoom = (c: SoloGoldCase): number => (c.xpRoom ? Math.min(d.coinPerHour(c.xpRoom), d.atlasCoinPerHour(c.xpRoom)) : 0);
  const overWithDropsInLoop = cases.filter(c => safeRatio(c.stop.perHour + dropsAnHour(c), c.roomCoin) > line);
  const overWithDropsBothSides = cases.filter(c => safeRatio(c.stop.perHour + dropsAnHour(c), roomWithDrops(c) || 0) > line);
  const overStrictLine = cases.filter(c => safeRatio(c.stop.perHour, Math.max(frozenXpRoom(c), STRICT_LINE_SHARE * c.roomCoin)) > line);
  const atReentry = REENTRY_PROBES.map(seconds => ({ seconds, over: overAtReentry(d, seconds * 1000) }));
  const parties = partiesInOpenDungeons(d, open);
  const partiesOver = parties.filter(p => p.ratio > line);
  const dungeonRows = [...new Set(cases.map(c => c.gold.loop.dungeonId))].map(id => {
    const list = cases.filter(c => c.gold.loop.dungeonId === id);
    return [
      list[0].gold.loop.name,
      doorText(d.content.dungeons[id]?.entryRequirements),
      list.length,
      list.filter(c => c.ratio > 1).length,
      list.filter(c => c.ratio > line).length,
      `${list.filter(clears).filter(c => c.fullRatio > line).length}/${list.filter(clears).length}`,
      ratio(maxOf(list.map(c => c.ratio))),
      ratio(median(list.map(c => c.ratio))),
      ...GOLD_REPORT_LINES.map(at => overLine(list, at)),
      ratio(median(list.map(c => c.xpRoomRatio))),
      ratio(median(list.map(c => c.partyRoomRatio))),
      ratio(median(list.map(c => safeRatio(c.stop.perHour, c.partyLoopGold)))),
    ];
  });
  const noFloorWon = [...open].filter(id => !cases.some(c => c.gold.loop.dungeonId === id)).map(id => d.content.dungeons[id]?.name ?? id);
  const worstRows = [...cases].sort((a, b) => b.ratio - a.ratio).slice(0, TOP_OFFENDERS).map(c => {
    const perHour = (value: number): string => fmt((value / c.stop.runMs) * HOUR_MS);
    return [
      c.gold.loop.name, c.className, c.gold.loop.level, `${c.stop.floors} of ${c.gold.floorReads[0].length}`, (c.stop.reach * 100).toFixed(0), c.gold.clearPct.toFixed(0),
      perHour(c.stop.repeat.coin), perHour(c.stop.repeat.rewards), fmt(c.stop.perHour),
      c.room ? place(c.room) : 'none won', fmt(c.roomCoin), ratio(c.ratio),
      c.xpRoom ? place(c.xpRoom) : 'none won', fmt(c.xpRoomCoin), ratio(c.xpRoomRatio),
      fmt(c.partyRoomCoin), ratio(c.partyRoomRatio), c.partyLoop ? `${fmt(c.partyLoopGold)}, ${c.partyLoop.loop.compId} in ${c.partyLoop.loop.name}` : '-',
      fmt(c.gold.dropsPerHour[0]),
    ];
  });
  const levels = [...new Set(cases.map(c => c.gold.loop.level))].sort((a, b) => a - b);
  const levelRows = levels.map(level => {
    const list = cases.filter(c => c.gold.loop.level === level);
    const richVsXp = list.flatMap(c => (c.room && c.xpRoomCoin > 0 ? [c.roomCoin / c.xpRoomCoin] : []));
    return [
      level, list.length, list.filter(c => c.ratio > line).length,
      fmt(median(list.map(c => c.stop.perHour))),
      fmt(median(list.map(c => c.roomCoin))), fmt(median(list.map(c => c.xpRoomCoin))), ratio(median(richVsXp)),
      ratio(median(list.map(c => c.ratio))), ratio(median(list.map(c => c.xpRoomRatio))), ratio(median(list.map(c => c.partyRoomRatio))),
    ];
  });
  const lenient = levels.flatMap(level => {
    const list = cases.filter(c => c.gold.loop.level === level && c.room && c.xpRoomCoin > 0);
    const spread = median(list.map(c => c.roomCoin / c.xpRoomCoin));
    return spread >= 2 ? [`L${level} ${ratio(spread)}`] : [];
  });
  const cap = d.policy?.dungeonClearsPerDay;
  const capLine = cap === undefined ? [] : [`A clear cap of ${cap} a day is read over a whole day with the idle room filling the rest, which dilutes it. Per hour spent in the dungeon instead, ${cases.filter(c => safeRatio(c.stop.activePerHour, c.roomCoin) > line).length} of ${cases.length} are over by ${NOISE_TOLERANCE * 100} %.`, ''];
  const otherReadings = [
    [`Only full clears by lone players clearing at least ${WIN_OK_PCT} %`, `${clearingBeyond.length}/${clearing.length}`],
    ...atReentry.map(x => [`${x.seconds} s to re-enter, not ${d.reentryMs / 1000} s`, `${x.over}/${cases.length}`]),
    ['Boss rooms let into the yardstick', `${beyondWithBoss.length}/${cases.length}`],
    ['Monster drops counted in the loop, room still coin only', `${overWithDropsInLoop.length}/${cases.length}`],
    ['Monster drops counted on both sides', `${overWithDropsBothSides.length}/${cases.length}`],
    [`A line at the richer of the XP room and ${STRICT_LINE_SHARE}x the richest room`, `${overStrictLine.length}/${cases.length}`],
    ...GOLD_REPORT_LINES.map(at => [`A line at ${at}x the richest room`, `${overLine(cases, at)}/${cases.length}`]),
  ];
  return {
    id: 'I16',
    title: 'No solo dungeon for gold',
    pass: beyond.length > 0 || dropsRaised.length > 0 ? false : mostlyMeasured ? true : null,
    short: `${beyond.length}/${cases.length} over, worst ${ratio(finiteWorst)}, in ${inDungeons.size} of ${open.size} dungeons${dropsRaised.length ? `, ${dropsRaised.length} with drops raised` : ''}`,
    values: {
      cases: cases.length, over: over.length, overBeyondNoise: beyond.length, worst, medianRatio: median(cases.map(c => c.ratio)),
      clearingCases: clearing.length, clearingOverBeyondNoise: clearingBeyond.length,
      overWithoutClearing: beyondWithoutClearing.length, overOnlyStoppingEarly: onlyStoppingEarly.length,
      noRoomToCompare: noRoom.length, nothingAgainstNothing: nothingAgainstNothing.length, dropsRaised: dropsRaised.length,
      dungeonsOver: inDungeons.size, dungeons: open.size,
      overBeyondNoiseWithBossRooms: beyondWithBoss.length,
      overHalf: overLine(cases, 0.5), overQuarter: overLine(cases, 0.25),
      overWithDropsInLoop: overWithDropsInLoop.length, overWithDropsBothSides: overWithDropsBothSides.length, overStrictLine: overStrictLine.length,
      ...Object.fromEntries(atReentry.map(x => [`overAtReentry${x.seconds}s`, x.over])),
      partyPairs: parties.length, partyPairsOver: partiesOver.length,
      medianAgainstXpRoom: median(cases.map(c => c.xpRoomRatio)), worstAgainstXpRoom: maxOf(cases.map(c => c.xpRoomRatio)),
      medianAgainstPartyRoom: median(cases.map(c => c.partyRoomRatio)), worstAgainstPartyRoom: maxOf(cases.map(c => c.partyRoomRatio)),
      overBestPartyLoop: cases.filter(c => c.stop.perHour > c.partyLoopGold).length,
      freshReads: d.goldLook.cells,
    },
    magnitude: `a lone player's repeat runs pay over the class's richest ordinary room at ${over.length}/${cases.length} cases (${beyond.length} by over ${NOISE_TOLERANCE * 100} %, worst ${ratio(finiteWorst)}${noRoom.length ? `, ${noRoom.length} with no paying room won to compare` : ''}), in ${inDungeons.size} of the ${open.size} dungeons one player can enter${!mostlyMeasured && cases.length ? `; ${nothingAgainstNothing.length} of the cases pay nothing against no paying room, so they measure nothing` : ''}${dropsRaised.length ? `; the plan raised monster drops over ${GOLD_RAISED_LINE}x in ${dropsRaised.length}` : ''}. Full clears by loops clearing at least ${WIN_OK_PCT} % alone: ${clearingBeyond.length}/${clearing.length}; ${beyondWithoutClearing.length} more clear less often, and ${onlyStoppingEarly.length} of all the cases pay over only by walking out early. Reported only: at ${REENTRY_PROBES.join(' s and ')} s to re-enter ${atReentry.map(x => x.over).join(' and ')} against ${beyond.length} at ${d.reentryMs / 1000} s; against the room they'd stand in for XP ${headline(cases.map(c => c.xpRoomRatio))}; against the best party's gold room ${headline(cases.map(c => c.partyRoomRatio))}; over the 0.5x line ${overLine(cases, 0.5)}, over the 0.25x line ${overLine(cases, 0.25)}; a lone run beats the best loop of any party holding that class at ${cases.filter(c => c.stop.perHour > c.partyLoopGold).length}; parties in these same dungeons, not judged, ${partiesOver.length} of ${parties.length} over`,
    lines: [
      `For every dungeon one player can enter, by the real door rule, each class and grid level where that lone player wins the first floor at all: gold an hour from repeat runs, coin plus the sale value of floor rewards, per the XP loop's model (${d.reentryMs / 1000} s to re-enter, ${d.meta.pauseMs / 1000} s after every floor). Floors pay as they're won, so a run needn't clear to earn: each case reads the richest place to walk out, the full run included, with a loss ending the run where it falls. First clears and weeklies don't count. Against the class's richest ordinary room alone at that level, held at or under what the atlas's own content pays there. Fails on any case over by more than ${NOISE_TOLERANCE * 100} %, or on a plan raising a lone loop's monster drops over ${GOLD_RAISED_LINE}x what the atlas's own content pays.`,
      '',
      ...table(['dungeon', 'door', 'cases', 'pays more', `by over ${NOISE_TOLERANCE * 100} %`, `full clears over by ${NOISE_TOLERANCE * 100} %, of those clearing ${WIN_OK_PCT} %`, 'worst', 'median', ...GOLD_REPORT_LINES.map(at => `over ${at}x`), 'median / XP room', 'median / best party room', 'median / best party loop'], dungeonRows),
      ...(noFloorWon.length ? ['', `One player can enter these but no class wins even their first floor alone at any grid level, so they have no cases: ${noFloorWon.join(', ')}.`] : []),
      ...(noRoom.length ? ['', `${noRoom.length} cases pay something where the class wins no paying room at all, which reads as over with nothing to compare: ${[...new Set(noRoom.map(c => `${c.className} L${c.gold.loop.level}`))].join(', ')}.`] : []),
      '',
      'Worst cases:',
      '',
      ...table(['dungeon', 'class', 'level', 'walks out after floor', 'reaches there %', 'clears %', 'coin/hr', 'floor rewards/hr', 'gold/hr', 'richest ordinary room', 'room coin/hr', 'ratio', 'room for XP', 'its coin/hr', 'ratio', 'best party room coin/hr', 'ratio', 'best party loop', 'monster drops/hr, not counted'], worstRows),
      '',
      'By level, medians across those cases:',
      '',
      ...table(['level', 'cases', `over by ${NOISE_TOLERANCE * 100} %`, 'gold/hr', 'richest room coin/hr', 'XP room coin/hr', 'richest / XP room', 'run / richest', 'run / XP room', 'run / best party room'], levelRows),
      '',
      `**The same count read other ways, none of which judges.** Cases over by ${NOISE_TOLERANCE * 100} %, against ${beyond.length} of ${cases.length} in the verdict:`,
      '',
      ...table(['reading', 'over'], otherReadings),
      '',
      ...capLine,
      `**Parties in these same dungeons aren't judged.** The rule's words reach "a dungeon one player can enter", but I16 reads lone players, so a cut aimed at them can leave these standing. Pairs clearing at least ${WIN_OK_PCT} %, per member against their own richest ordinary room: ${partiesOver.length} of ${parties.length} over by ${NOISE_TOLERANCE * 100} %. Whether they should count is a design choice. The Gold section prints them by dungeon.`,
      '',
      '**Adjustable numbers and choices:**',
      '',
      `- Re-entry: ${d.reentryMs / 1000} s from the end of the last floor's pause, for a person coming back. The game has no re-entry cooldown, so a script can beat it, and the party really leaves about a second before that pause ends, so the loop reads a little low. The table above shows how far this one assumption moves the count.`,
      `- Every lone run that wins its first floor counts, with no clear line, since gold flows from floors won and a line would let a plan keep the gold by pushing clears just under it. A rule's factors cut these runs too. A clear cap counts a run walking out early as a clear.`,
      `- Yardstick: the richest room the lone class plausibly wins at that level, coin only, the same side of the win line I10's solo line takes. A room read near the line counts if its sample's interval reaches ${WIN_OK_PCT} %. A plan can lower it, by cutting that room, and can't raise it past what the atlas's own content pays, so raising a room's coin can't pass this line. A plan with its own atlas sets that base itself.`,
      `- Boss rooms are out of the yardstick: their coin assumes a boss looping forever, which the no-boss-farming rule rules out and a plan may remove, and a yardstick resting on them would let a dungeon hide behind one room. Letting them in reads ${beyondWithBoss.length} of ${cases.length} over by ${NOISE_TOLERANCE * 100} %, against ${beyond.length}.`,
      '- Rooms paying 0 XP count if they pay coin: someone after gold doesn\'t care about XP.',
      '- Auto-retreat: a room with packs under the line reads at its shown rate, the top of its range.',
      `- Monster drops' sale value is left out of both sides, since the line counts coin plus floor rewards. It is printed above and in the Gold section, and it is real gold. So a plan moving gold into drops isn't left to that wording: a lone loop's drops over ${GOLD_RAISED_LINE}x what the atlas's own content pays fail.`,
      '- Income from the entrance room during the re-entry wait isn\'t counted.',
      `- ${NOISE_TOLERANCE * 100} % is the card's usual noise allowance. The other lines carry it too.`,
      d.goldLook.fights > 0 ? `- Noise: a case within ${RESAMPLE_MARGIN}x of the line, its floors, and any room within ${UNDER_READ}x under the yardstick get a fresh read of ${d.goldLook.fights} fights that only these lines use, so they can't move another metric: ${d.goldLook.cells} cells this run (${d.goldLook.simulatedCells} simulated for it). Other cases read as sampled.` : '- Noise: no fresh reads this run, so a case near the line can move with the seed.',
      '',
      `**Why the richest room is a poor yardstick.** It is lenient exactly where a room far below the player out-pays everything near them, so a loop can pay many times what that player earns while levelling and still pass. The richest room over the XP room, median across these cases: ${lenient.length ? lenient.join(', ') : 'under 2x at every level'}. So read the XP-room column beside the verdict, and a plan that passes only because of a starter room hasn't made a solo dungeon insignificant. The Gold section reports the backwards room itself.`,
    ],
  };
}

function xpOnlyDungeonRules(d: Data): string[] {
  if (!d.policy?.dungeonWeekly) return [];
  const open = soloEnterableDungeons(d);
  const dungeons = [...new Set(d.meta.tables.flatMap(t => (t.dungeonId ? [t.dungeonId] : [])))];
  return dungeons.flatMap(id => {
    const rule = weeklyRuleFor(d.policy, id, open.has(id));
    return rule && rule.repeatFactor < 1 && rule.repeatCoinFactor === undefined && rule.repeatRewardFactor === undefined ? [d.content.dungeons[id]?.name ?? id] : [];
  });
}

function ruleText(rule: DungeonWeeklyRule | undefined): string {
  if (!rule) return 'none';
  const { coin, rewards } = goldFactors(rule);
  return `${rule.fullClearsPerWeek} full a week; XP x${rule.repeatFactor}, coin x${coin}, rewards x${rewards}`;
}

function meanCoin(monster: any): number {
  return ((monster?.goldMin ?? 0) + (monster?.goldMax ?? 0)) / 2;
}

/** Monsters a plan's retuneContent pays over GOLD_RAISED_LINE of the atlas's own coin. */
function monstersWithCoinRaised(d: Data): { monsters: number; bosses: number } {
  const base = d.baseContent;
  if (!base) return { monsters: 0, bosses: 0 };
  const raised = (Object.values(d.content.monsters) as any[]).filter(m => meanCoin(m) > meanCoin(base.monsters[m.id]) * GOLD_RAISED_LINE);
  return { monsters: raised.length, bosses: raised.filter(m => !m.passive && ['boss', 'raid'].includes(d.mod.effectiveMonsterTier(m))).length };
}

function itemsWithValueRaised(d: Data): number {
  const base = d.baseContent;
  if (!base) return 0;
  return (Object.values(d.content.items ?? {}) as any[]).filter(item => base.items?.[item.id] && (item.value ?? 1) > (base.items[item.id].value ?? 1)).length;
}

/** The median across won on-level rooms of what the plan pays over what the atlas's own content pays. Undefined: nothing to compare. */
function roomCoinAgainstAtlas(d: Data): number | undefined {
  if (!d.baseContent) return undefined;
  const ratios = d.rows.flatMap(r => {
    const atlas = r.rate.g?.atlas?.ch;
    if (!atlas || r.table.kind !== 'room' || r.table.boss || r.rate.win < WIN_OK_PCT || !playedNormally(r.comp) || Math.abs(r.table.roomLevel - r.cell.level) > ON_LEVEL_BAND) return [];
    return [r.rate.g!.ch / atlas];
  });
  return ratios.length ? median(ratios) : undefined;
}

/** Gear the atlas's own content hands out on a floor that the plan leaves with no source anywhere. A week's full clears count as a source. */
export function gearWithNoSource(d: Data): string[] {
  const open = soloEnterableDungeons(d);
  const rolls = (reward: any): boolean => reward.chance > 0 && meanQuantity(reward) > 0;
  const content = d.content as any;
  const before = (d.baseContent ?? d.content) as any;
  const onFloorBefore = new Set<string>((Object.values(before.dungeons) as any[]).flatMap(x => (x.floors ?? []).flatMap((f: any) => (f.rewards ?? []).filter(rolls).map((r: any) => r.itemId))));
  const stillGiven = new Set<string>();
  const give = (itemId: string | undefined): void => {
    if (itemId) stillGiven.add(itemId);
  };
  for (const dungeon of Object.values(content.dungeons) as any[]) {
    const found = weeklyRuleFor(d.policy, dungeon.id, open.has(dungeon.id));
    const stillPays = !found || found.fullClearsPerWeek > 0 || goldFactors(found).rewards > 0;
    if (stillPays) for (const floor of dungeon.floors ?? []) (floor.rewards ?? []).filter(rolls).forEach((r: any) => give(r.itemId));
    (dungeon.firstClearRewards ?? []).filter(rolls).forEach((r: any) => give(r.itemId));
  }
  for (const shop of Object.values(content.shops ?? {}) as any[]) (shop.inventory ?? []).forEach((entry: any) => give(entry.itemId));
  for (const recipe of Object.values(content.recipes ?? {}) as any[]) give(recipe.result?.itemId);
  for (const monster of Object.values(content.monsters ?? {}) as any[]) (monster.drops ?? []).filter((drop: any) => drop.chance > 0).forEach((drop: any) => give(drop.itemId));
  for (const quest of Object.values(content.quests ?? {}) as any[]) (quest.rewards ?? []).filter((r: any) => r.kind === 'item').forEach((r: any) => give(r.itemId));
  return [...onFloorBefore].filter(id => content.items?.[id]?.equipSlot && !stillGiven.has(id)).map(id => content.items[id].name ?? id).sort();
}

function goldWarnings(d: Data): string[] {
  const warnings: string[] = [];
  const cap = d.policy?.dungeonClearsPerDay;
  const open = soloEnterableDungeons(d);
  if (cap !== undefined && cap * 7 > MAX_WEEKLY_FULL_CLEARS && d.meta.tables.some(t => t.dungeonId && !goldCutByRule(weeklyRuleFor(d.policy, t.dungeonId, open.has(t.dungeonId))))) warnings.push(`A clear cap of ${cap} a day pays ${Math.round(cap * 7)} clears a week in full where no rule cuts their gold, against the ${MAX_WEEKLY_FULL_CLEARS} a weekly rule may. Only weekly or first runs are allowed, so unless this is meant, I16's 24-hour reading is diluting them with idle coin.`);
  const gone = gearWithNoSource(d);
  if (gone.length) warnings.push(`This plan leaves ${gone.length} pieces of gear with no source anywhere: ${gone.join(', ')}. No verdict reads this.`);
  if (!d.baseContent) return warnings;
  if (d.rows.some(r => r.rate.g) && !d.rows.some(r => r.rate.g?.atlas)) warnings.push('This run retuned content but holds no read of the atlas\'s own gold, so I16 is reading the plan\'s own rooms as its yardstick: evaluate the plan again.');
  const coin = monstersWithCoinRaised(d);
  if (coin.monsters) warnings.push(`This plan pays over ${GOLD_RAISED_LINE}x the atlas's coin on ${coin.monsters} monsters, ${coin.bosses} of them bosses. I16's yardstick ignores the raise, and no verdict reads boss rooms' coin, so gold moved there goes unjudged: see the Gold section.`);
  const items = itemsWithValueRaised(d);
  if (items) warnings.push(`This plan raises the sale value of ${items} items over the atlas's. No verdict reads what that does to rooms, party-only dungeons or crafted income.`);
  const rooms = roomCoinAgainstAtlas(d);
  if (rooms !== undefined && (rooms < ROOM_COIN_BAND[0] || rooms > ROOM_COIN_BAND[1])) warnings.push(`The median on-level room pays ${ratio(rooms)} the atlas's coin, outside ${ROOM_COIN_BAND[0]}x to ${ROOM_COIN_BAND[1]}x. No verdict scores the room economy moving, so a dungeon line read against it means less than it seems.`);
  return warnings;
}

function goldCutByRule(rule: DungeonWeeklyRule | undefined): boolean {
  if (!rule) return false;
  const { coin, rewards } = goldFactors(rule);
  return coin < 1 && rewards < 1;
}

/** What a plan's retuneContent changed that gold reads. */
function goldContentChanges(d: Data): { monsters: number; rewards: number; items: number } {
  const base = d.baseContent;
  if (!base) return { monsters: 0, rewards: 0, items: 0 };
  const monsters = Object.values(d.content.monsters).filter((m: any) => base.monsters[m.id]?.goldMin !== m.goldMin || base.monsters[m.id]?.goldMax !== m.goldMax).length;
  const items = Object.values(d.content.items ?? {}).filter((i: any) => base.items?.[i.id]?.value !== i.value).length;
  let rewards = 0;
  for (const dungeon of Object.values(d.content.dungeons) as any[]) {
    (dungeon.floors ?? []).forEach((floor: any, f: number) => {
      (floor.rewards ?? []).forEach((reward: any, r: number) => {
        const was = (base.dungeons[dungeon.id] as any)?.floors?.[f]?.rewards?.[r];
        if (was?.chance !== reward.chance || was?.minQty !== reward.minQty || was?.maxQty !== reward.maxQty) rewards++;
      });
    });
  }
  return { monsters, rewards, items };
}

/** Share of a clear's floor reward sale value that is equipment, rolling every reward whatever its class restriction. */
export function gearShareOfRewards(content: XpSnapshot, dungeonId: string): number {
  let gear = 0;
  let all = 0;
  for (const floor of (content.dungeons[dungeonId] as any)?.floors ?? []) {
    for (const reward of floor.rewards ?? []) {
      const value = floorRewardValue({ rewards: [{ ...reward, classRestriction: undefined }] }, '', content.items);
      all += value;
      if (content.items?.[reward.itemId]?.equipSlot) gear += value;
    }
  }
  return all > 0 ? gear / all : 0;
}

function hoursCell(hours: readonly number[]): string {
  if (hours.length === 0) return '-';
  const m = median(hours);
  return m < 0.1 ? '<0.1' : m.toFixed(1);
}

/** Reported only: the gold a repeat loop or a far room leaves on the table that I16 doesn't judge. */
export function metricGold(d: Data): Metric {
  if (!hasGold(d)) return { id: 'Gold', title: 'Reported, not scored', pass: null, magnitude: NO_GOLD_FIGURES, lines: [] };
  const loops = goldLoops(d).filter(g => g.clearPct >= WIN_OK_PCT);
  const open = soloEnterableDungeons(d);
  const dungeonIds = [...new Set(d.meta.tables.flatMap(t => (t.dungeonId ? [t.dungeonId] : [])))];
  const dungeonName = (id: string): string => d.content.dungeons[id]?.name ?? id;
  const compIndex = new Map(d.meta.comps.map(c => [c.id, c]));
  const humans = (g: GoldLoop): number => compIndex.get(g.loop.compId)?.members.length ?? 1;
  const overYardstick = (list: readonly GoldLoop[]): number[] => list.flatMap(g => {
    const { coin } = goldYardstick(d, g.loop.compId, g.loop.level);
    return coin > 0 ? [safeRatio(mean(g.goldPerHour), coin)] : [];
  });
  const partyLoopRow = (id: string): (string | number)[] => {
    const list = loops.filter(g => g.loop.dungeonId === id && humans(g) >= 2);
    const against = (pick: (g: GoldLoop) => Row | undefined): number[] => list.flatMap(g => {
      const room = pick(g);
      return room ? [safeRatio(mean(g.goldPerHour), d.coinPerHour(room))] : [];
    });
    const top = maxBy(list, g => mean(g.goldPerHour));
    return [
      dungeonName(id),
      doorText(d.content.dungeons[id]?.entryRequirements),
      list.length,
      list.length ? fmt(median(list.map(g => mean(g.goldPerHour)))) : '-',
      top ? `${fmt(mean(top.goldPerHour))}, ${top.loop.compId} L${top.loop.level}` : '-',
      list.length ? ratio(median(overYardstick(list))) : '-',
      list.length ? ratio(median(against(g => d.idleRoom(g.loop.compId, g.loop.level)))) : '-',
      list.length ? `${Math.round(100 * median(list.map(g => { const coin = mean(g.repeat.map(r => r.coin)); const rewards = mean(g.repeat.map(r => r.rewards)); return safeRatio(rewards, coin + rewards); })))} %` : '-',
      list.length ? fmt(median(list.map(g => mean(g.dropsPerHour)))) : '-',
    ];
  };
  const loopHeaders = ['dungeon', 'door', 'party and level pairs clearing', 'median loop gold/hr per member', 'best', 'median / richest ordinary room', 'median / XP room', 'share from floor rewards', 'monster drops/hr, not counted'];
  const partyOnly = dungeonIds.filter(id => !open.has(id));
  const layouts = d.meta.comps.filter(c => playedNormally(c) && !c.xpBonus);
  const backwardsRows = d.meta.grid.flatMap(level => {
    const pairs = layouts.flatMap(comp => {
      const xpRoom = d.idleRoom(comp.id, level);
      const rich = richestRoom(d, comp.id, level);
      if (!xpRoom || !rich) return [];
      const ordinary = richestRoom(d, comp.id, level, notBossRoom);
      const boss = richestRoom(d, comp.id, level, r => r.table.boss);
      const xpCoin = d.coinPerHour(xpRoom);
      return [{ rich, ordinary, xpCoin, ratio: safeRatio(d.coinPerHour(rich), xpCoin), ordinaryRatio: ordinary ? safeRatio(d.coinPerHour(ordinary), xpCoin) : NaN, bossRatio: boss && ordinary ? safeRatio(d.coinPerHour(boss), d.coinPerHour(ordinary)) : NaN, hit: xpRoom.xp > 0 ? 1 - rich.xp / xpRoom.xp : 0 }];
    });
    if (pairs.length === 0) return [];
    const ratios = pairs.map(p => p.ratio);
    const bossRatios = pairs.flatMap(p => (Number.isFinite(p.bossRatio) ? [p.bossRatio] : []));
    return [[
      level, pairs.length, ratio(median(ratios)), ratio(quantile(ratios, 0.1)), ratio(quantile(ratios, 0.9)),
      ratio(median(pairs.flatMap(p => (Number.isFinite(p.ordinaryRatio) ? [p.ordinaryRatio] : [])))),
      `${Math.round((100 * pairs.filter(p => p.rich.table.regionIndex === STARTER_REGION).length) / pairs.length)} %`,
      median(pairs.map(p => p.rich.table.roomLevel)),
      `${Math.round(100 * median(pairs.map(p => p.hit)))} %`,
      ratio(median(bossRatios)), ratio(maxOf(bossRatios)),
    ]];
  });
  const gearGone = gearWithNoSource(d);
  const coinRaised = monstersWithCoinRaised(d);
  const changes = goldContentChanges(d);
  const ruleRows = dungeonIds.map(id => {
    const list = loops.filter(g => g.loop.dungeonId === id);
    const rule = weeklyRuleFor(d.policy, id, open.has(id));
    const fullRates = list.map(g => mean(g.fullPerHour));
    const repeatRates = list.map(g => mean(g.goldPerHour));
    return [dungeonName(id), open.has(id) ? 'yes' : 'no', ruleText(rule), list.length, list.length ? fmt(median(fullRates)) : '-', list.length ? fmt(median(repeatRates)) : '-', list.length ? ratio(median(overYardstick(list))) : '-', list.length ? fmt(median(list.map(g => g.weeklyLump))) : '-', percent(gearShareOfRewards(d.content, id))];
  });
  const { model, summaries } = materialSummaries(d);
  const uncut = new Map(buildMaterials(d.baseContent ?? d.content, d.mod).map(m => [m.id, m]));
  const refs = MATERIAL_REFERENCE_PARTIES.filter(id => d.has(id));
  const materialRows = summaries.filter(s => s.dungeonOnly && s.material.usedByGear).map(s => {
    const cases = s.levels.flatMap(level => refs.map(id => ({ now: model.fastestLoopHours(s.material, id, level), before: model.fastestLoopHours(s.material, id, level, uncut.get(s.material.id) ?? s.material) })));
    const clearing = cases.filter(c => c.before !== undefined);
    const now = clearing.flatMap(c => (c.now === undefined ? [] : [c.now]));
    return [s.material.name, [...new Set(s.material.floors.map(f => dungeonName(f.dungeonId)))].join(', ') || '-', Number.isInteger(s.material.perCraft) ? s.material.perCraft : s.material.perCraft.toFixed(2), s.material.freeOnce ? s.material.freeOnce.toFixed(1) : '-', `${clearing.length}/${cases.length}`, hoursCell(clearing.map(c => c.before!)), s.cutToNothing ? 'cut to nothing' : hoursCell(now)];
  });
  const firstClearRows = dungeonIds.flatMap(id => {
    const dungeon: any = d.content.dungeons[id];
    const classes = Object.keys(SOLO_ID_BY_CLASS);
    const rewards = maxOf(classes.map(className => floorRewardValue({ rewards: dungeon?.firstClearRewards }, className, d.content.items)));
    return dungeon?.firstClearGold || rewards > 0 ? [[dungeonName(id), fmt(dungeon?.firstClearGold ?? 0), fmt(rewards)]] : [];
  });
  return {
    id: 'Gold',
    title: 'Reported, not scored',
    pass: null,
    short: `${partyOnly.length} party-only dungeons, rule ${d.policy?.dungeonWeekly ? 'set' : 'none'}`,
    values: {
      partyOnlyDungeons: partyOnly.length,
      monstersGoldChanged: changes.monsters, floorRewardsChanged: changes.rewards, itemValuesChanged: changes.items,
      monstersCoinRaised: coinRaised.monsters, bossesCoinRaised: coinRaised.bosses, itemValuesRaised: itemsWithValueRaised(d), gearWithNoSource: gearGone.length,
    },
    magnitude: `party-only dungeons, the richest room against the XP room by level, what a dungeon rule leaves, and dungeon-only materials. Not modelled: crafted income, trading, gear prices`,
    lines: [
      'Scored nowhere, for information: whether party-only dungeons should also pay less gold is still open. **Not modelled:** crafted income, including the profit between part costs and sale value; trading between players; and what gear costs, so nothing here says what gold buys. Coin and floor rewards are counted as in I16, and monster drops are printed beside them and not added in. All per member.',
      '',
      '**Party-only dungeon loops**, repeat full clears, parties clearing at least 90 %:',
      '',
      ...table(loopHeaders, partyOnly.map(partyLoopRow)),
      '',
      '**Parties in dungeons one player can also enter**, for comparison with I16:',
      '',
      ...table(loopHeaders, dungeonIds.filter(id => open.has(id)).map(partyLoopRow)),
      '',
      `**The backwards gold room.** Each layout's richest room against the coin in its best XP room, by level. Boss rooms count here, since a party can stand in one, so the next column leaves them out. A wide spread is a real trade-off for gold at a real XP cost, shown as the XP hit. The last two columns read a boss room's coin over the layout's richest ordinary room: the no-boss-farming rule is about XP, so no verdict reads this, and a plan moving gold there shows only here and in a warning (${coinRaised.bosses} bosses raised over ${GOLD_RAISED_LINE}x by this plan):`,
      '',
      ...table(['level', 'layouts', 'richest / XP room', 'p10', 'p90', 'richest ordinary / XP room', 'richest room in the starter region', 'richest room\'s level', 'XP hit there', 'boss room / richest ordinary, median', 'worst'], backwardsRows),
      '',
      `**Gear this plan leaves with no source.** Gear the atlas's own content hands out on a floor that now has no floor, shop, recipe, monster, first clear or quest giving it: ${gearGone.length ? gearGone.join(', ') : 'none'}. A week's full clears count as a source. No verdict reads this; it is reported only.`,
      '',
      `**What this plan's dungeon rule leaves.** ${d.policy?.dungeonWeekly ? 'Loops at the repeat rate, with the full clears as a weekly lump.' : 'This plan has no dungeon rule, so repeat clears pay in full.'} Monster drops aren't touched by any rule. The last column is the share of a clear's floor reward value that is gear, which a plan can cut and leave crafting materials alone. Medians across parties clearing at least ${WIN_OK_PCT} %, with its monster coin, floor rewards and item values changed by retuneContent in ${changes.monsters}, ${changes.rewards} and ${changes.items} places:`,
      '',
      ...table(['dungeon', 'one player can enter', 'rule', 'parties clearing', 'gold/hr before the rule', 'gold/hr left', 'left / richest ordinary room', 'gold a week from full clears', 'floor reward value in gear'], ruleRows),
      '',
      `**Dungeon-only materials under this plan.** Each drops only on a dungeon floor, or from monsters on one, and a gear recipe needs it. A plan cutting floor rewards must keep these obtainable, so here is how long a craft's worth takes at the fastest loop each party clears, for ${refs.join(', ')} at the recipe's level. "Before" is the atlas's own content with no weekly rule. "Free once" is what one-off quests and first clears hand out. The same cut in a monster's drop isn't possible here, since retuneContent can't change drops:`,
      '',
      ...table(['material', 'dungeons', 'per craft', 'free once', 'cases with a loop', 'hours per craft, before', 'hours per craft, now'], materialRows),
      '',
      'First clears, which stay and no metric counts: gold, and the most a class can expect to sell its first-clear items for:',
      '',
      ...table(['dungeon', 'first-clear gold', 'first-clear items, sale value'], firstClearRows),
    ],
  };
}

// --- I11 ---

export function buildCurve(d: Data): Record<string, Record<string, number>> {
  const curve: Record<string, Record<string, number>> = {};
  for (const compId of [FULL_PARTY, TYPICAL_PARTY, 'K+P', ...SOLO_IDS, ...HIRE_IDS, ARCHER_HIRED_KNIGHT]) {
    if (!d.has(compId)) continue;
    curve[compId] = {};
    for (const level of d.meta.grid) {
      const rows = d.onLevel(compId, level);
      if (rows.length) curve[compId][level] = Math.round(median(rows.map(r => r.xp)));
    }
  }
  return curve;
}

function logLinearFit(points: readonly [number, number][]): (level: number) => number {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => Math.log(p[1]));
  const mx = mean(xs);
  const my = mean(ys);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = den > 0 ? num / den : 0;
  return (level: number) => Math.exp(my + slope * (level - mx));
}

export function metricI11(d: Data): Metric {
  const refs = [FULL_PARTY, TYPICAL_PARTY].filter(id => d.has(id));
  const blocks: string[] = [];
  let inside = 0;
  let measured = 0;
  const allRatios: number[] = [];
  for (const compId of refs) {
    const stats = d.meta.grid.map(level => {
      const xs = d.onLevel(compId, level).map(r => r.xp);
      return { level, xs, med: xs.length ? median(xs) : NaN };
    });
    const points = stats.filter(s => s.med > 0).map(s => [s.level, s.med] as [number, number]);
    const fit = points.length >= 2 ? logLinearFit(points) : null;
    const reference = d.baselineCurve?.[compId];
    blocks.push(
      `**${compId}**`,
      '',
      ...table(['level', 'rooms', 'median XP/hr', 'p10', 'p90', 'model XP/hr', 'median / model', reference ? 'median / baseline' : 'median / log fit'], stats.filter(s => s.xs.length).map(s => {
        const model = d.mod.XP_INCOME_MODEL(s.level) / DAY_HOURS;
        const r = s.med / model;
        allRatios.push(r);
        measured++;
        if (Math.abs(r - 1) <= FIT_TOLERANCE) inside++;
        const other = reference ? reference[s.level] : fit?.(s.level);
        return [s.level, s.xs.length, fmt(s.med), fmt(quantile(s.xs, 0.1)), fmt(quantile(s.xs, 0.9)), fmt(model), ratio(r), other ? ratio(s.med / other) : '-'];
      })),
      '',
    );
  }
  return {
    id: 'I11',
    title: 'Target fit',
    pass: measured ? inside / measured >= FIT_PASS_SHARE : null,
    short: `${inside}/${measured} within ${FIT_TOLERANCE * 100} %, median ${ratio(median(allRatios))}`,
    values: { within: inside, measured, medianRatio: median(allRatios), lowest: minOf(allRatios), highest: maxOf(allRatios) },
    magnitude: `${inside}/${measured} on-level reference medians within ${FIT_TOLERANCE * 100} % of XP_INCOME_MODEL; median ratio ${ratio(median(allRatios))}, lowest ${ratio(minOf(allRatios))}, highest ${ratio(maxOf(allRatios))}`,
    lines: [
      'The reference parties are examples for measuring income against the target curves, not the party the game should push players towards. Which layout is best where is I14\'s question.',
      '',
      ...blocks,
    ],
  };
}

// --- I12 ---

function soloShares(d: Data) {
  return d.meta.grid.map(level => {
    const party = d.onLevel(FULL_PARTY, level).map(r => r.xp);
    const partyMedian = party.length ? median(party) : NaN;
    const shares = SOLO_IDS.map(id => {
      const xs = d.onLevel(id, level).map(r => r.xp);
      return xs.length ? median(xs) / partyMedian : NaN;
    });
    return { level, partyMedian, shares };
  }).filter(r => Number.isFinite(r.partyMedian));
}

/** Parties of two or more humans, played normally: what a class alone could join. */
function humanLayouts(d: Data): XpComp[] {
  return d.meta.comps.filter(c => playedNormally(c) && c.hires === 'none' && c.members.length >= 2);
}

const CLASS_BY_SOLO_ID = new Map(Object.entries(SOLO_ID_BY_CLASS).map(([className, id]) => [id, className]));

export interface SoloLayoutPair {
  className: string;
  level: number;
  comp: XpComp;
  solo: Row;
  soloXp: number;
  /** Undefined: the layout wins no paying room here. */
  party: Row | undefined;
  partyXp: number;
  ratio: number;
}

/** A class's best room alone against its best room in each layout it could join, per level. A layout with no cells at a level, such as an xp_bonus party before it unlocks, isn't a comparison. */
export function soloLayoutPairs(d: Data, soloGate: WinGate, partyGate: WinGate): SoloLayoutPair[] {
  const pairs: SoloLayoutPair[] = [];
  const layouts = humanLayouts(d);
  for (const [soloId, className] of CLASS_BY_SOLO_ID) {
    if (!d.has(soloId)) continue;
    for (const level of d.meta.grid) {
      const solo = bestAt(wonRooms(d, soloId, level, undefined, soloGate));
      if (!solo || !(solo.rate.xp[0] > 0)) continue;
      for (const comp of layouts) {
        const member = comp.members.findIndex(m => m.className === className);
        if (member < 0 || d.at(comp.id, level).length === 0) continue;
        const party = bestAt(wonRooms(d, comp.id, level, undefined, partyGate), member);
        const partyXp = party?.rate.xp[member] ?? 0;
        pairs.push({ className, level, comp, solo, soloXp: solo.rate.xp[0], party, partyXp, ratio: partyXp / solo.rate.xp[0] });
      }
    }
  }
  return pairs;
}

export interface SoloPlayable {
  className: string;
  level: number;
  /** 0: no paying room won alone, or it paid nothing. */
  soloXp: number;
  /** What the class earns in the median layout it could join, best room against best room. */
  partyMedian: number;
  share: number;
}

/** One line per class and level a party of it has cells at: solo stays playable if it wins a paying room and earns a fair share of what the median party does. */
export function soloPlayability(d: Data): SoloPlayable[] {
  const found: SoloPlayable[] = [];
  const layouts = humanLayouts(d);
  for (const [soloId, className] of CLASS_BY_SOLO_ID) {
    if (!d.has(soloId)) continue;
    for (const level of d.meta.grid) {
      const paid: number[] = [];
      for (const comp of layouts) {
        const member = comp.members.findIndex(m => m.className === className);
        if (member < 0 || d.at(comp.id, level).length === 0) continue;
        paid.push(bestAt(wonRooms(d, comp.id, level, undefined, plausibleWin), member)?.rate.xp[member] ?? 0);
      }
      if (paid.length === 0) continue;
      const partyMedian = median(paid);
      const soloXp = bestAt(wonRooms(d, soloId, level, undefined, plausibleWin))?.rate.xp[0] ?? 0;
      found.push({ className, level, soloXp, partyMedian, share: safeRatio(soloXp, partyMedian) });
    }
  }
  return found;
}

function onLevelMemberXp(d: Data, comp: XpComp, member: number, level: number): number {
  const rows = d.onLevel(comp.id, level);
  return rows.length ? median(rows.map(r => r.rate.xp[member])) : NaN;
}

function percent(value: number, digits = 0): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)} %` : '-';
}

export function metricI12(d: Data): Metric {
  const pairs = soloLayoutPairs(d, clearWin, plausibleWin);
  const plainPairs = soloLayoutPairs(d, plainWin, plainWin);
  const playability = soloPlayability(d);
  if (pairs.length === 0 && playability.length === 0) return { id: 'I12', title: 'Weak solo, strong together', pass: null, magnitude: 'no solo and party pair in this atlas', lines: [] };
  const noRoomAlone = playability.filter(p => !(p.soloXp > 0));
  const underFloor = playability.filter(p => p.soloXp > 0 && p.share < SOLO_PLAYABLE_SHARE);
  const levelsByClass = (list: readonly SoloPlayable[]): string => [...new Set(list.map(p => p.className))].map(c => `${c} ${compactLevels(list.filter(p => p.className === c).map(p => p.level))}`).join(', ') || 'none';
  const loneWithHires = [...CLASS_BY_SOLO_ID].flatMap(([soloId, className]) => d.meta.grid.flatMap(level => {
    const hired = d.has(`${soloId}+h${SOLO_FILL_HIRES}`) ? bestAt(wonRooms(d, `${soloId}+h${SOLO_FILL_HIRES}`, level, undefined, plausibleWin)) : undefined;
    const humans = maxOf(pairs.filter(p => p.className === className && p.level === level).map(p => p.partyXp));
    return hired && humans > 0 ? [hired.rate.xp[0] / humans] : [];
  }));
  const beyond = pairs.filter(p => p.ratio < 1 - NOISE_TOLERANCE);
  const plainBeyond = plainPairs.filter(p => p.ratio < 1 - NOISE_TOLERANCE);
  const lowLevel = (list: readonly SoloLayoutPair[]): number => list.filter(p => p.level < JOURNEYER_MIN_LEVEL).length;
  const classes = [...CLASS_BY_SOLO_ID.values()];
  const classCols = classes.filter(c => pairs.some(p => p.className === c));
  const pairsAt = (className: string, level: number): SoloLayoutPair[] => pairs.filter(p => p.className === className && p.level === level);
  const layouts = humanLayouts(d);
  const shareAt = (className: string, level: number): { compId: string; size: number; share: number }[] => {
    const solo = d.onLevel(SOLO_ID_BY_CLASS[className as keyof typeof SOLO_ID_BY_CLASS], level).map(r => r.rate.xp[0]);
    if (solo.length === 0) return [];
    const soloMedian = median(solo);
    return layouts.flatMap(comp => {
      const member = comp.members.findIndex(m => m.className === className);
      if (member < 0) return [];
      const party = onLevelMemberXp(d, comp, member, level);
      return party > 0 ? [{ compId: comp.id, size: comp.members.length, share: soloMedian / party }] : [];
    });
  };
  const allShares = d.meta.grid.flatMap(level => classes.flatMap(c => shareAt(c, level).map(s => ({ ...s, level, className: c }))));
  const shareOver = allShares.filter(s => s.share >= 1 + NOISE_TOLERANCE);
  const noneBeat = classes.flatMap(c => d.meta.grid.filter(level => {
    const list = pairsAt(c, level);
    return list.length > 0 && !list.some(p => p.ratio > 1);
  }).map(level => ({ className: c, level })));
  const onLevelCount = (soloId: string, level: number): number => d.onLevel(soloId, level).length;
  const noOnLevel = classes.map(c => {
    const soloId = SOLO_ID_BY_CLASS[c as keyof typeof SOLO_ID_BY_CLASS];
    return { className: c, soloId, levels: d.has(soloId) ? d.meta.grid.filter(level => onLevelCount(soloId, level) === 0) : [] };
  });
  const hired = bestRoomPairs(d).pairs.filter(p => p.comp.hires !== 'none');
  const fiveParty = d.has(FULL_PARTY) ? soloShares(d) : [];
  const worst = [...beyond].sort((a, b) => a.ratio - b.ratio);
  const levelsWord = noOnLevel.filter(x => x.levels.length).map(x => `${x.className} ${compactLevels(x.levels)}`).join(', ') || 'none';
  return {
    id: 'I12',
    title: 'Weak solo, strong together',
    pass: beyond.length === 0 && noRoomAlone.length === 0 && underFloor.length === 0,
    short: `${beyond.length}/${pairs.length} layouts out-earned, ${lowLevel(beyond)} under L${JOURNEYER_MIN_LEVEL}; solo unplayable at ${noRoomAlone.length + underFloor.length}`,
    values: {
      pairs: pairs.length, outEarnedBeyondNoise: beyond.length, outEarnedUnderLevel10: lowLevel(beyond),
      plainLinePairs: plainPairs.length, plainLineOutEarned: plainBeyond.length, plainLineUnderLevel10: lowLevel(plainBeyond),
      noPartyBeatsSolo: noneBeat.length, shareMedian: median(allShares.map(s => s.share)), shareP90: quantile(allShares.map(s => s.share), 0.9), shareCombinations: allShares.length, shareOverParty: shareOver.length, shareOverPartyUnderLevel10: shareOver.filter(s => s.level < JOURNEYER_MIN_LEVEL).length,
      classLevelsWithNoOnLevelRoom: noOnLevel.reduce((sum, x) => sum + x.levels.length, 0),
      classLevelsWithNoRoomAlone: noRoomAlone.length, classLevelsUnderSoloFloor: underFloor.length, lowestSoloShare: minOf(playability.map(p => p.share)),
      loneWithHiresPairs: loneWithHires.length, loneWithHiresWithinNoise: loneWithHires.filter(x => x >= 1 - NOISE_TOLERANCE).length, loneWithHiresMedian: median(loneWithHires),
    },
    magnitude: `a class alone out-earns a party of humans it could join by over ${NOISE_TOLERANCE * 100} %, best room against best room, at ${beyond.length}/${pairs.length} class, level and layout combinations, ${lowLevel(beyond)} of them under L${JOURNEYER_MIN_LEVEL} (${plainBeyond.length}/${plainPairs.length} and ${lowLevel(plainBeyond)} at a plain ${WIN_OK_PCT} % line); no party beats solo at ${noneBeat.length} class + level pairs; on-level, solo earns a median ${percent(median(allShares.map(s => s.share)))} of a party member, p90 ${percent(quantile(allShares.map(s => s.share), 0.9))}, and over ${100 + NOISE_TOLERANCE * 100} % at ${shareOver.length}/${allShares.length} combinations, ${shareOver.filter(s => s.level < JOURNEYER_MIN_LEVEL).length} of them under L${JOURNEYER_MIN_LEVEL}; solo must stay playable: ${noRoomAlone.length ? `no paying room won alone at ${levelsByClass(noRoomAlone)}` : 'every class wins a paying room alone at every level'}, and it earns under ${percent(SOLO_PLAYABLE_SHARE)} of the median layout it could join at ${levelsByClass(underFloor)}; reported only, no on-level room won alone at ${levelsWord}`,
    lines: [
      ...coverageNotes(d),
      '',
      `Solo must stay playable, which is part of the rule: a class fails at a level where it wins no paying room alone, or where its best room alone pays under ${percent(SOLO_PLAYABLE_SHARE)} of what it earns in the median layout it could join, best room against best room. That share is adjustable. A level with no on-level room won alone is reported only, since a weak solo can fairly fight easier rooms.`,
      '',
      `A lone player with ${SOLO_FILL_HIRES} free hires against the best party of humans holding that class, best room against best room, for information: within ${NOISE_TOLERANCE * 100} % or better at ${loneWithHires.filter(x => x >= 1 - NOISE_TOLERANCE).length} of ${loneWithHires.length} class + level pairs, median ${ratio(median(loneWithHires))}, p90 ${ratio(quantile(loneWithHires, 0.9))}. Hires stand in for friends not yet online, so "strong together" could vanish through them; no verdict reads this, since a limit is a design choice.`,
      '',
      `A hard rule, against every layout. Best room against best room: a class's best paying room alone, against its best in each party of humans it could join, each won at least ${WIN_OK_PCT} %, per class and level. The party's room can be a harder one, and in the same room a party that doesn't kill faster may earn less per member (I1 shows that, for information). Fails at any combination out-earned by over ${NOISE_TOLERANCE * 100} %, reading the ${WIN_OK_PCT} % line as I1 does: solo's room must clearly clear it, the party's must be able to reach it. Parties with hires are I1's; the count here is below.`,
      '',
      `Parties with hires, for information: ${hired.filter(failsBeyondNoise).length}/${hired.length} class, level and party combinations pay under solo's best room by over ${NOISE_TOLERANCE * 100} %, hire-carried cells left out.`,
      '',
      'Each cell: the best party\'s room over the class alone, that party, then how many layouts solo out-earns by over 5 % out of those it could join.',
      '',
      ...table(['level', ...classCols], d.meta.grid.map(level => [level, ...classCols.map(c => {
        const list = pairsAt(c, level);
        const best = maxBy(list, p => p.ratio);
        return best ? `${ratio(best.ratio)} ${best.comp.id} (${list.filter(p => p.ratio < 1 - NOISE_TOLERANCE).length}/${list.length})` : '-';
      })])),
      '',
      'Solo on-level XP/hr as a share of a party member\'s on-level XP/hr, medians over the rooms each wins at least 90 %. Each cell: the median across every layout the class could join, then the highest:',
      '',
      ...table(['level', ...classCols], d.meta.grid.map(level => [level, ...classCols.map(c => {
        const list = shareAt(c, level).map(s => s.share);
        return list.length ? `${percent(median(list))} (${percent(maxOf(list))})` : '-';
      })])),
      '',
      'The same by party size, every level and class:',
      '',
      ...table(['humans', 'combinations', 'solo share, median', 'p10', 'p90', `over ${100 + NOISE_TOLERANCE * 100} %`], [...new Set(allShares.map(s => s.size))].sort((a, b) => a - b).map(size => {
        const list = allShares.filter(s => s.size === size).map(s => s.share);
        return [size, list.length, percent(median(list)), percent(quantile(list, 0.1)), percent(quantile(list, 0.9)), list.filter(s => s >= 1 + NOISE_TOLERANCE).length];
      })),
      '',
      ...(fiveParty.length ? [`One of those layouts, ${FULL_PARTY}, as an example:`, '', ...table(['level', 'its member XP/hr', ...SOLO_IDS], fiveParty.map(r => [r.level, fmt(r.partyMedian), ...r.shares.map(s => percent(s))])), ''] : []),
      'Solo must stay playable. On-level rooms a class wins at least 90 % alone, then with the usual hires, and its best room alone minus its level:',
      '',
      ...table(['class', 'levels with none alone', ...REPORTED_LEVEL_STEPS.map(l => `L${l} alone / with hires`), ...REPORTED_LEVEL_STEPS.map(l => `L${l} best room minus level`)], noOnLevel.map(x => {
        const nearest = (l: number): number => nearestGridLevel(d, l);
        return [
          x.className,
          compactLevels(x.levels),
          ...REPORTED_LEVEL_STEPS.map(l => `${onLevelCount(x.soloId, nearest(l))} / ${onLevelCount(`${x.soloId}+hires`, nearest(l))}`),
          ...REPORTED_LEVEL_STEPS.map(l => {
            const room = bestAt(wonRooms(d, x.soloId, nearest(l)));
            return room ? signedLevels(room.table.roomLevel - nearest(l)) : '-';
          }),
        ];
      })),
      '',
      'Worst combinations:',
      '',
      ...table(['class', 'level', 'alone, room', 'XP/hr', 'layout', 'its best room', 'XP/hr', 'ratio'], worst.slice(0, TOP_OFFENDERS).map(p => [p.className, p.level, place(p.solo), fmt(p.soloXp), p.comp.id, p.party ? place(p.party) : 'none won', fmt(p.partyXp), ratio(p.ratio)])),
    ],
  };
}

// --- Layouts: shared by I13 and I14 ---

/** A layout is a party shape: an xp_bonus twin is the same party with a different passive. */
function shapeOf(comp: XpComp): string {
  return comp.xpBonus ? comp.reference! : comp.id;
}

interface LayoutCell {
  shape: string;
  xp: number;
  /** Per class in the party. */
  classXp: Map<string, number>;
  bonus: boolean;
  humans: number;
  hires: number;
}

interface RoomLevelPair {
  table: XpTable;
  level: number;
  /** Per shape, the better of its loadouts among those won; hired layouts apart from human ones. */
  humans: Map<string, LayoutCell>;
  hired: Map<string, LayoutCell>;
}

/** On-level paying rooms, boss rooms too, won at least 90 % by someone, per room and level. `withBonus` false leaves every xp_bonus party out. */
function roomLevelPairs(d: Data, withBonus: boolean): RoomLevelPair[] {
  const pairs = new Map<string, RoomLevelPair>();
  for (const r of d.rows) {
    if (r.table.kind !== 'room' || d.zero.has(r.table.index) || Math.abs(r.table.roomLevel - r.cell.level) > ON_LEVEL_BAND) continue;
    if (!playedNormally(r.comp) || r.rate.win < WIN_OK_PCT || !(r.xp > 0)) continue;
    if (!withBonus && r.comp.xpBonus) continue;
    const key = `${r.table.index}|${r.cell.level}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { table: r.table, level: r.cell.level, humans: new Map(), hired: new Map() };
      pairs.set(key, pair);
    }
    const into = r.comp.hires === 'none' ? pair.humans : pair.hired;
    const shape = shapeOf(r.comp);
    const held = into.get(shape);
    if (held && held.xp >= r.xp) continue;
    const classXp = new Map<string, number>();
    r.members.forEach((m, i) => classXp.set(m.className, Math.max(classXp.get(m.className) ?? 0, r.rate.xp[i])));
    into.set(shape, { shape, xp: r.xp, classXp, bonus: !!r.comp.xpBonus, humans: r.members.length, hires: r.cell.hires.length });
  }
  return [...pairs.values()].filter(p => p.humans.size > 0);
}

function leaderOf(cells: ReadonlyMap<string, LayoutCell>): LayoutCell | undefined {
  return maxBy([...cells.values()], c => c.xp);
}

function leadShares(pairs: readonly RoomLevelPair[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const leader = leaderOf(pair.humans);
    if (leader) counts.set(leader.shape, (counts.get(leader.shape) ?? 0) + 1);
  }
  return counts;
}

function topLeaders(pairs: readonly RoomLevelPair[], count = 3): string {
  const total = Math.max(1, pairs.length);
  return [...leadShares(pairs)].sort((a, b) => b[1] - a[1]).slice(0, count).map(([shape, n]) => `${shape} ${percent(n / total)}`).join(', ') || '-';
}

function closeLayouts(pairs: readonly RoomLevelPair[]): Set<string> {
  const close = new Set<string>();
  for (const pair of pairs) {
    const top = leaderOf(pair.humans)?.xp ?? 0;
    for (const cell of pair.humans.values()) if (cell.xp >= top * (1 - CLOSE_TO_BEST)) close.add(cell.shape);
  }
  return close;
}

export interface ReachReading {
  reach: number | null;
  /** Rooms were held out on the way, behind a level gate or beyond the atlas's band: the party might reach further if it could stand there. */
  heldBack: boolean;
}

/**
 * The highest room level the party keeps winning on the way up from the world's lowest room. A soft room far above a gap doesn't
 * count, which "hardest room won" would. A room it can't stand in says nothing about whether it would win, so it leaves the test.
 */
export function reachReading(d: Data, compId: string, level: number): ReachReading {
  const comp = d.meta.comps.find(c => c.id === compId);
  const lowest = level + Math.min(0, ...(comp?.members.map(m => m.levelOffset) ?? []));
  const heldOut = (t: XpTable): boolean => !d.get(t.index, compId, level) && (!memberReaches(t, lowest) || (!!comp && t.roomLevel - level > -comp.band[0]));
  const rooms = d.meta.tables.filter(t => d.isFarmRoom(t));
  const levels = [...new Set(rooms.map(t => t.roomLevel))].sort((a, b) => a - b);
  let reach: number | null = null;
  let heldBack = false;
  for (const roomLevel of levels) {
    const near = rooms.filter(t => Math.abs(t.roomLevel - roomLevel) <= REACH_WINDOW);
    const measured = near.filter(t => !heldOut(t));
    if (measured.length < near.length) heldBack = true;
    if (measured.length === 0) break;
    const won = measured.filter(t => {
      const row = d.get(t.index, compId, level);
      return !!row && row.rate.win >= WIN_OK_PCT;
    });
    if (won.length / measured.length < REACH_ROOM_SHARE) break;
    reach = roomLevel;
  }
  return { reach, heldBack };
}

export function robustReach(d: Data, compId: string, level: number): number | null {
  return reachReading(d, compId, level).reach;
}

function reachCell(reading: ReachReading): string {
  return reading.reach === null ? '-' : `${reading.reach}${reading.heldBack ? '+' : ''}`;
}

// --- I13 ---

interface BardScore {
  roomsWon: number;
  led: number;
  best: Row | undefined;
  reach: ReachReading;
  medianToLeader: number;
}

/** `leaders`: per room, the XP/hr to match at this level. */
function bardScore(d: Data, compId: string, level: number, leaders: ReadonlyMap<number, number>): BardScore {
  const won = d.at(compId, level).filter(r => d.isFarmRoom(r.table) && r.rate.win >= WIN_OK_PCT && r.xp > 0);
  const onLevel = won.filter(r => Math.abs(r.table.roomLevel - level) <= ON_LEVEL_BAND);
  const ratios = onLevel.flatMap(r => {
    const top = leaders.get(r.table.index) ?? 0;
    return top > 0 ? [r.xp / top] : [];
  });
  return { roomsWon: onLevel.length, led: ratios.filter(x => x >= 1).length, best: maxBy(won, r => r.xp), reach: reachReading(d, compId, level), medianToLeader: ratios.length ? median(ratios) : NaN };
}

function bardColumns(score: BardScore | undefined): (string | number)[] {
  if (!score) return ['-', '-', '-', '-', '-', '-'];
  return [score.roomsWon, score.led, score.best?.table.roomLevel ?? '-', score.best ? fmt(score.best.xp) : '-', reachCell(score.reach), ratio(score.medianToLeader)];
}

export function metricI13(d: Data): Metric {
  const bonusId = `${XP_BONUS_PREFIX}${FIVE_BARDS}`;
  if (!d.has(FIVE_BARDS)) return { id: 'I13', title: 'What five Bards are for', pass: null, magnitude: 'five Bards not in this atlas', lines: [] };
  const plainPairs = roomLevelPairs(d, false);
  const fiveIds = humanLayouts(d).filter(c => c.members.length === 5 && !c.xpBonus).map(c => c.id);
  const wins = (compId: string, table: number, level: number): boolean => (d.get(table, compId, level)?.rate.win ?? 0) >= WIN_OK_PCT;
  const rows = d.meta.grid.map(level => {
    const atLevel = plainPairs.filter(p => p.level === level);
    const here = atLevel.filter(p => d.isFarmRoom(p.table));
    const bossPairs = atLevel.filter(p => p.table.boss);
    const leaders = new Map(here.map(p => [p.table.index, leaderOf(p.humans)?.xp ?? 0]));
    const furthest = maxBy(fiveIds.map(id => ({ id, reading: reachReading(d, id, level) })).filter(x => x.reading.reach !== null), x => x.reading.reach!);
    return {
      level, here, bossPairs,
      bossWon: bossPairs.filter(p => wins(FIVE_BARDS, p.table.index, level)).length,
      bossWonWithBonus: d.has(bonusId) ? bossPairs.filter(p => wins(bonusId, p.table.index, level)).length : 0,
      plain: bardScore(d, FIVE_BARDS, level, leaders),
      bonus: d.has(bonusId) && d.at(bonusId, level).length ? bardScore(d, bonusId, level, leaders) : undefined,
      furthest,
    };
  }).filter(x => x.here.length || x.bossPairs.length || x.plain.best);
  const leadTotal = rows.reduce((sum, x) => sum + x.plain.led, 0);
  const wonTotal = rows.reduce((sum, x) => sum + x.plain.roomsWon, 0);
  const bonusLeadTotal = rows.reduce((sum, x) => sum + (x.bonus?.led ?? 0), 0);
  const bonusPairTotal = rows.reduce((sum, x) => sum + (x.bonus ? x.here.length : 0), 0);
  const pairTotal = rows.reduce((sum, x) => sum + x.here.length, 0);
  const bossPairTotal = rows.reduce((sum, x) => sum + x.bossPairs.length, 0);
  const bossWonTotal = rows.reduce((sum, x) => sum + x.bossWon, 0);
  const bossBonusTotal = rows.reduce((sum, x) => sum + x.bossWonWithBonus, 0);
  const reachGap = rows.flatMap(x => (x.plain.reach.reach !== null && x.furthest ? [x.furthest.reading.reach! - x.plain.reach.reach] : []));
  return {
    id: 'I13',
    title: 'What five Bards are for',
    pass: null,
    short: `lead ${leadTotal}/${pairTotal}, win ${bossWonTotal}/${bossPairTotal} boss rooms, others reach ${signedLevels(median(reachGap))}`,
    values: { pairs: pairTotal, roomsWon: wonTotal, ledWithoutBonus: leadTotal, ledWithBonus: bonusLeadTotal, bonusPairs: bonusPairTotal, bossPairs: bossPairTotal, bossWon: bossWonTotal, bossWonWithBonus: bossBonusTotal, medianReachGap: median(reachGap) },
    magnitude: `reported, not scored: of ${pairTotal} ordinary on-level room and level pairs, five Bards win ${wonTotal} and lead ${leadTotal}; wearing xp_bonus they match or beat the no-bonus leader at ${bonusLeadTotal} of the ${bonusPairTotal} pairs where it is unlocked; of ${bossPairTotal} on-level boss-room pairs they win ${bossWonTotal}, ${bossBonusTotal} wearing it; the furthest-reaching five-player layout reaches a median ${signedLevels(median(reachGap))} levels past them, with rooms behind a gate held out`,
    lines: [
      ...coverageNotes(d),
      '',
      `Reach holds out any room the party can't stand in, because a gate says nothing about whether it would win there, and a + marks a reach where that happened, so the party might go further with gates lifted. An atlas with gates lifted is the other reading.`,
      '',
      `For information: five Bards with and without xp_bonus, against the layouts best suited to each room, the balanced party being only one of them. The perk is never a failure and a Bard party leading somewhere is fine; it only counts through I14, if one layout leads nearly everywhere. Rooms here are ordinary rooms; boss rooms have their own columns. "Rooms won" are on-level rooms won at least ${WIN_OK_PCT} %. "Lead" is rooms where they match or beat the best human party without xp_bonus. Reach is the highest room level kept on the way up from the world's lowest room, where each level needs ${percent(REACH_ROOM_SHARE)} of the ordinary paying rooms within ${REACH_WINDOW} levels won at least ${WIN_OK_PCT} %, so a soft room far above doesn't count.`,
      '',
      ...table(['level', 'on-level rooms anyone wins', `${FIVE_BARDS} rooms won`, 'lead', 'best room level', 'best XP/hr', 'reach', 'median vs room leader', 'with xp_bonus: rooms won', 'lead', 'best room level', 'best XP/hr', 'reach', 'median vs room leader', 'on-level boss rooms anyone wins', `${FIVE_BARDS} win`, 'wearing xp_bonus', 'leaders here', 'furthest five-player reach'], rows.map(x => [
        x.level,
        x.here.length,
        ...bardColumns(x.plain),
        ...bardColumns(x.bonus),
        x.bossPairs.length,
        x.bossWon,
        x.bossWonWithBonus,
        topLeaders(x.here),
        x.furthest ? `${x.furthest.id} ${reachCell(x.furthest.reading)}` : '-',
      ])),
    ],
  };
}

// --- I14 ---

function regionCountOf(d: Data): number {
  return d.regions.length || Math.max(0, ...d.meta.tables.map(t => t.regionIndex)) + 1;
}

/** Index of the first region counted as mid game. */
export function midGameRegion(regionCount: number): number {
  return Math.ceil(regionCount * EARLY_REGION_SHARE);
}

function stageName(regionIndex: number, midGame: number, regionCount: number): string {
  if (regionIndex < midGame) return 'early';
  return regionIndex < midGame + Math.ceil((regionCount - midGame) / 2) ? 'mid' : 'late';
}

export interface VarietyTest {
  midGame: number;
  pairs: number;
  topLeader: string;
  topLeadShare: number;
  effective: number;
  /** Per class: the layout close to its best at the most stops, and the share of stops. */
  journeys: { className: string; stops: number; distinctBest: number; fewestCover: number; topLayout: string; topShare: number; sequence: string }[];
  /** Parties with too few rooms where they are best or close among their size. */
  noPurpose: { shape: string; rooms: number }[];
  dominated: { shape: string; by: string; shared: number; worseShare: number; extraShare: number; medianRatio: number }[];
  pass: boolean | null;
}

/** "Something for any party and any party for something", from region `midGame` on. `layouts`, shape to head count, adds any layout that wins or earns nothing, which has no purpose and so must not vanish from the test. */
export function varietyTest(pairs: readonly RoomLevelPair[], midGame: number, classes: readonly string[], layouts: ReadonlyMap<string, number> = new Map()): VarietyTest {
  const scoped = pairs.filter(p => p.table.regionIndex >= midGame);
  const shares = leadShares(scoped);
  const top = maxBy([...shares], ([, n]) => n);
  const shapes = new Map<string, number>(layouts);
  for (const pair of pairs) for (const cell of pair.humans.values()) shapes.set(cell.shape, cell.humans);

  const journeys = classes.map(className => {
    const stops = new Map<string, { level: number; region: number; best: Map<string, number> }>();
    for (const pair of scoped) {
      const key = `${pair.table.regionIndex}|${pair.level}`;
      const stop = stops.get(key) ?? { level: pair.level, region: pair.table.regionIndex, best: new Map<string, number>() };
      stops.set(key, stop);
      for (const cell of pair.humans.values()) {
        const xp = cell.classXp.get(className);
        if (xp !== undefined && xp > (stop.best.get(cell.shape) ?? 0)) stop.best.set(cell.shape, xp);
      }
    }
    const list = [...stops.values()].filter(s => s.best.size > 0).sort((a, b) => a.level - b.level || a.region - b.region);
    const closes = list.map(s => {
      const bestXp = Math.max(...s.best.values());
      return [...s.best].filter(([, xp]) => xp >= bestXp * (1 - CLOSE_TO_BEST)).map(([shape]) => shape);
    });
    const bests = list.map(s => maxBy([...s.best], ([, xp]) => xp)![0]);
    const counts = new Map<string, number>();
    for (const close of closes) for (const shape of close) counts.set(shape, (counts.get(shape) ?? 0) + 1);
    const leading = maxBy([...counts], ([, n]) => n);
    const runs: { shape: string; from: number; to: number }[] = [];
    list.forEach((s, i) => {
      const last = runs[runs.length - 1];
      if (last && last.shape === bests[i]) last.to = s.level;
      else runs.push({ shape: bests[i], from: s.level, to: s.level });
    });
    return {
      className,
      stops: list.length,
      distinctBest: new Set(bests).size,
      fewestCover: coverOfStops(closes).length,
      topLayout: leading?.[0] ?? '-',
      topShare: leading && list.length ? leading[1] / list.length : 0,
      sequence: runs.map(r => `${r.shape} L${r.from}${r.to !== r.from ? `-${r.to}` : ''}`).join(' > '),
    };
  });

  const noPurpose: VarietyTest['noPurpose'] = [];
  const parties = [...shapes].filter(([, humans]) => humans >= 2);
  for (const [shape, humans] of parties) {
    const rooms = new Set<number>();
    for (const pair of scoped) {
      const mine = pair.humans.get(shape);
      if (!mine) continue;
      const bestOfSize = Math.max(...[...pair.humans.values()].filter(c => c.humans === humans).map(c => c.xp));
      if (mine.xp >= bestOfSize * (1 - CLOSE_TO_BEST)) rooms.add(pair.table.index);
    }
    if (rooms.size < MIN_PURPOSE_ROOMS) noPurpose.push({ shape, rooms: rooms.size });
  }

  const wonBy = new Map<string, Map<string, number>>();
  for (const pair of scoped) {
    for (const cell of pair.humans.values()) {
      const rooms = wonBy.get(cell.shape) ?? new Map<string, number>();
      rooms.set(`${pair.table.index}|${pair.level}`, cell.xp);
      wonBy.set(cell.shape, rooms);
    }
  }
  const dominated: VarietyTest['dominated'] = [];
  for (const [shape, humans] of parties) {
    for (const [other, otherHumans] of parties) {
      if (shape === other || humans !== otherHumans) continue;
      const compared = compareLayouts(wonBy.get(shape) ?? new Map<string, number>(), wonBy.get(other) ?? new Map<string, number>(), CLOSE_TO_BEST);
      if (compared.shared >= DOMINATED_MIN_SHARED && compared.worseShare >= DOMINATED_ROOM_SHARE && compared.extraShare <= DOMINATED_EXTRA_ROOMS) dominated.push({ shape, by: other, ...compared });
    }
  }
  const topLeadShare = top && scoped.length ? top[1] / scoped.length : 0;
  const measured = scoped.length > 0;
  return {
    midGame,
    pairs: scoped.length,
    topLeader: top?.[0] ?? '-',
    topLeadShare,
    effective: effectiveNumber([...shares.values()]),
    journeys,
    noPurpose,
    dominated,
    pass: measured ? topLeadShare <= NEARLY_EVERYWHERE && journeys.every(j => j.topShare <= ONE_SENSIBLE_PARTY) && noPurpose.length === 0 && dominated.length === 0 : null,
  };
}

function spreadRowsFor(d: Data, size: number, keep: (r: Row) => boolean): SpreadRow[] {
  return d.rows.filter(r => r.table.kind === 'room' && !d.zero.has(r.table.index) && Math.abs(r.table.roomLevel - r.cell.level) <= ON_LEVEL_BAND && playedNormally(r.comp) && !r.comp.xpBonus && r.comp.hires === 'none' && r.members.length === size && r.rate.win >= WIN_OK_PCT && r.xp > 0 && keep(r)).map(r => ({
    y: Math.log(r.xp),
    room: r.table.index,
    level: r.cell.level,
    region: r.table.regionIndex,
    layout: r.comp.id,
  }));
}

export function metricI14(d: Data): Metric {
  const pairs = roomLevelPairs(d, true);
  const pairsNoBonus = roomLevelPairs(d, false);
  const regionCount = regionCountOf(d);
  const classes = [...CLASS_BY_SOLO_ID.values()];
  const midGame = midGameRegion(regionCount);
  const layouts = new Map(humanLayouts(d).map(c => [shapeOf(c), c.members.length]));
  const main = varietyTest(pairs, midGame, classes, layouts);
  const noBonusTest = varietyTest(pairsNoBonus, midGame, classes, new Map(humanLayouts(d).filter(c => !c.xpBonus).map(c => [c.id, c.members.length])));
  const ordinaryTest = varietyTest(pairs.filter(p => !p.table.boss), midGame, classes, layouts);
  const anyStage = varietyTest(pairs, 0, classes, layouts);
  const boundaries = [midGame - 1, midGame, midGame + 1].filter(b => b >= 0 && b < regionCount);
  const sensitivity = boundaries.map(b => ({ b, test: b === midGame ? main : varietyTest(pairs, b, classes, layouts) }));
  const scopedPairs = pairs.filter(p => p.table.regionIndex >= midGame);
  const leaderHolds = (needs: readonly string[]): number => scopedPairs.filter(p => {
    const leader = leaderOf(p.humans);
    return !!leader && needs.every(c => leader.classXp.has(c));
  }).length / Math.max(1, scopedPairs.length);
  const regionName = (index: number): string => d.regions[index]?.name ?? `R${index}`;
  const stage = (p: RoomLevelPair): string => stageName(p.table.regionIndex, midGame, regionCount);
  const stages = ['early', 'mid', 'late'].filter(s => pairs.some(p => stage(p) === s));
  const worstJourney = maxBy(main.journeys, j => j.topShare);
  const conditions = [
    `one layout leads over ${percent(NEARLY_EVERYWHERE)} of on-level rooms`,
    `one layout is within ${percent(CLOSE_TO_BEST)} of a class's best at over ${percent(ONE_SENSIBLE_PARTY)} of that class's stops`,
    `a party of two or more humans is best or within ${percent(CLOSE_TO_BEST)} of the best of its own size in under ${MIN_PURPOSE_ROOMS} rooms`,
    `a party is dominated: another of the same head count earns over ${percent(CLOSE_TO_BEST)} more in at least ${percent(DOMINATED_ROOM_SHARE)} of the rooms both win (at least ${DOMINATED_MIN_SHARED} shared), and at most ${percent(DOMINATED_EXTRA_ROOMS)} of its rooms are won only by it`,
  ];
  const stageRow = (label: string, list: readonly RoomLevelPair[]): (string | number)[] => {
    const byLevel = new Map<number, RoomLevelPair[]>();
    for (const p of list) push(byLevel, p.level, p);
    const withinLevel = [...byLevel.values()].map(group => effectiveNumber([...leadShares(group).values()]));
    return [label, list.length, new Set(list.map(p => p.table.index)).size, effectiveNumber([...leadShares(list).values()]).toFixed(1), withinLevel.length ? median(withinLevel).toFixed(1) : '-', closeLayouts(list).size, topLeaders(list, 4)];
  };
  const stageHeaders = ['pairs', 'rooms', 'effective layouts', 'effective within a level, median', 'layouts within 10 % somewhere', 'leaders'];
  const shapes = [...new Set(pairs.flatMap(p => [...p.humans.keys()]))];
  const humansOf = new Map(pairs.flatMap(p => [...p.humans.values()].map(c => [c.shape, c.humans] as const)));
  const sizes = [...new Set(humansOf.values())].sort((a, b) => a - b);
  const layoutRows = shapes.map(shape => {
    const humans = humansOf.get(shape)!;
    const cellsByStage = stages.map(s => {
      const list = pairs.filter(p => stage(p) === s && p.humans.has(shape));
      const close = list.filter(p => p.humans.get(shape)!.xp >= Math.max(...[...p.humans.values()].filter(c => c.humans === humans).map(c => c.xp)) * (1 - CLOSE_TO_BEST));
      const best = list.filter(p => p.humans.get(shape)!.xp >= Math.max(...[...p.humans.values()].filter(c => c.humans === humans).map(c => c.xp)));
      return list.length ? `${close.length} (${best.length}) / ${list.length}` : '-';
    });
    const led = pairs.filter(p => leaderOf(p.humans)?.shape === shape).length;
    const scoped = pairs.filter(p => p.table.regionIndex >= midGame);
    const ledOn = scoped.filter(p => leaderOf(p.humans)?.shape === shape).length;
    return { shape, humans, led, row: [shape, humans, ...cellsByStage, percent(led / Math.max(1, pairs.length)), percent(ledOn / Math.max(1, scoped.length)), humans < 2 ? 'not tested' : main.noPurpose.some(x => x.shape === shape) ? 'no' : 'yes', main.dominated.filter(x => x.shape === shape).map(x => x.by).slice(0, 2).join(', ') || '-'] };
  }).sort((a, b) => b.humans - a.humans || b.led - a.led);
  const spreads = sizes.filter(size => size >= 2).flatMap(size => (['early', 'mid on'] as const).map(label => {
    const rows = spreadRowsFor(d, size, r => (label === 'early') === (r.table.regionIndex < midGame));
    return rows.length ? { size, label, shares: layoutSpread(rows) } : undefined;
  })).filter((x): x is { size: number; label: 'early' | 'mid on'; shares: SpreadShares } => !!x);
  const midSpreads = spreads.filter(s => s.label === 'mid on');
  const interaction = (s: SpreadShares): number => s.layoutByRegion + s.layoutByRoom;
  const favoured = midSpreads.flatMap(s => [...s.shares.favour.values()].filter(f => Math.exp(f.effect) >= FAVOURED_ROOM).map(f => ({ ...f, size: s.size }))).sort((a, b) => b.effect - a.effect).slice(0, TOP_OFFENDERS * 2);
  const closeInRoom = (layout: string, size: number, room: number): string => {
    const here = pairs.filter(p => p.table.index === room && p.humans.has(layout));
    const close = here.filter(p => p.humans.get(layout)!.xp >= Math.max(...[...p.humans.values()].filter(c => c.humans === size).map(c => c.xp)) * (1 - CLOSE_TO_BEST));
    return `${close.length}/${here.length}`;
  };
  const wholeJourney = varietyTest(pairs, 0, classes).journeys;
  const hiredLead = pairs.filter(p => {
    const top = leaderOf(p.hired);
    return top && top.xp > (leaderOf(p.humans)?.xp ?? 0);
  }).length;
  return {
    id: 'I14',
    title: 'Layouts have different purposes',
    pass: main.pass,
    short: `top lead ${percent(main.topLeadShare)}, worst class ${percent(worstJourney?.topShare ?? NaN)}, ${main.noPurpose.length} no purpose, ${new Set(main.dominated.map(x => x.shape)).size} dominated`,
    values: {
      midGameRegion: midGame, pairsTested: main.pairs, topLeadShare: main.topLeadShare, effectiveLayouts: main.effective, worstClassCover: worstJourney?.topShare ?? NaN,
      layoutsWithNoPurpose: main.noPurpose.length, dominatedLayouts: new Set(main.dominated.map(x => x.shape)).size, dominatedPairs: main.dominated.length,
      noPurposeAtAnyStage: anyStage.noPurpose.length, leadHoldsMageAndBard: leaderHolds(['Mage', 'Bard']), leadHoldsKnightAndPriest: leaderHolds(['Knight', 'Priest']), leadHoldsBard: leaderHolds(['Bard']),
      noBonusTopLeadShare: noBonusTest.topLeadShare, noBonusEffectiveLayouts: noBonusTest.effective, interactionShareMedian: median(midSpreads.map(s => interaction(s.shares))), layoutAloneShareMedian: median(midSpreads.map(s => s.shares.layout)),
    },
    magnitude: `from the mid game on (region ${midGame} of ${regionCount}), ${main.pairs} on-level room and level pairs: ${main.topLeader} leads ${percent(main.topLeadShare)} (limit ${percent(NEARLY_EVERYWHERE)}), ${main.effective.toFixed(1)} effective layouts; the most one-party class is ${worstJourney?.className ?? '-'}, ${worstJourney?.topLayout ?? '-'} close to best at ${percent(worstJourney?.topShare ?? NaN)} of stops (limit ${percent(ONE_SENSIBLE_PARTY)}); ${main.noPurpose.length} parties have under ${MIN_PURPOSE_ROOMS} rooms where they are best or close among their size; ${new Set(main.dominated.map(x => x.shape)).size} parties are dominated by one of their size`,
    lines: [
      ...coverageNotes(d),
      '',
      `The test is "something for any party and any party for something", and a balanced party is not the goal. Fails, from the mid game on, if any of these hold: ${conditions.map((c, i) => `(${i + 1}) ${c}`).join('; ')}. A layout is a party shape: a Bard party with and without xp_bonus is one layout at the better of the two, and solos and hired parties are not tested here, since a solo should be weak (I12) and hires are the stand-in for not having friends. "Close" is within ${percent(CLOSE_TO_BEST)}: XP/hr is the party's mean per member, in on-level paying rooms won at least ${WIN_OK_PCT} %, boss rooms included. These reflect one default loadout per class, so "no purpose" and "dominated" hold only for the builds simulated.`,
      '',
      `**The mid-game boundary.** The first ${percent(EARLY_REGION_SHARE)} of the world's regions count as early, here R0 to R${midGame - 1} of ${regionCount}, with room levels up to ${Math.max(0, ...d.meta.tables.filter(t => t.kind === 'room' && t.regionIndex < midGame).map(t => t.roomLevel))}. Early content may lean towards balanced parties while players learn the game, so those regions are only reported. A third is a judgement: long enough to meet the classes and start grouping, short enough that most of the game is tested. Moving it by one region:`,
      '',
      ...table(['mid game starts at', 'pairs', 'top lead', 'effective layouts', 'worst class cover', 'parties with no purpose', 'dominated parties', 'verdict'], [...sensitivity.map(({ b, test }) => ({ label: `R${b} ${regionName(b)}${b === midGame ? ' (used)' : ''}`, test })), { label: `R${midGame} ${regionName(midGame)}, ordinary rooms only`, test: ordinaryTest }].map(({ label, test }) => [label, test.pairs, `${test.topLeader} ${percent(test.topLeadShare)}`, test.effective.toFixed(1), percent(maxOf(test.journeys.map(j => j.topShare))), test.noPurpose.length, new Set(test.dominated.map(x => x.shape)).size, verdict(test.pass)])),
      '',
      `Variety is tested from the mid game on, so the verdict reads the mid game on. Counting early rooms too, at any stage of the game, ${anyStage.noPurpose.length} parties have no purpose${anyStage.noPurpose.length ? `: ${anyStage.noPurpose.map(x => x.shape).join(', ')}` : ''}.`,
      '',
      `Leaders by what they hold, from the mid game on, since one family can lead most rooms while no single layout passes the ${percent(NEARLY_EVERYWHERE)} line: holds a Mage and a Bard ${percent(leaderHolds(['Mage', 'Bard']))}, a Knight and a Priest ${percent(leaderHolds(['Knight', 'Priest']))}, any Bard ${percent(leaderHolds(['Bard']))}. For information, as the verdict tests single layouts.`,
      '',
      `With every xp_bonus party left out, the same tests read: ${noBonusTest.topLeader} leads ${percent(noBonusTest.topLeadShare)}, ${noBonusTest.effective.toFixed(1)} effective layouts, worst class cover ${percent(maxOf(noBonusTest.journeys.map(j => j.topShare)))}, ${noBonusTest.noPurpose.length} parties with no purpose, ${new Set(noBonusTest.dominated.map(x => x.shape)).size} dominated: ${verdict(noBonusTest.pass)}. Hired parties out-earn every human party at ${hiredLead} of ${pairs.length} pairs, for information.`,
      '',
      'By stage of the game:',
      '',
      ...table(['stage', ...stageHeaders], stages.map(s => stageRow(s, pairs.filter(p => stage(p) === s)))),
      '',
      'By region:',
      '',
      ...table(['region', ...stageHeaders], [...new Set(pairs.map(p => p.table.regionIndex))].sort((a, b) => a - b).map(r => stageRow(`R${r} ${regionName(r)}${r < midGame ? ' (reported only)' : ''}`, pairs.filter(p => p.table.regionIndex === r)))),
      '',
      'By party level:',
      '',
      ...table(['level', ...stageHeaders], d.meta.grid.filter(level => pairs.some(p => p.level === level)).map(level => stageRow(`L${level}`, pairs.filter(p => p.level === level)))),
      '',
      `Every layout. Stage cells: pairs within ${percent(CLOSE_TO_BEST)} of the best of its own size (pairs best of its size) / pairs won. "Purpose" and "dominated by" are from the mid game on:`,
      '',
      ...table(['layout', 'humans', ...stages, 'leads, whole game', 'leads, mid game on', 'purpose', 'dominated by'], layoutRows.map(x => x.row)),
      '',
      'A player of each class as they travel, from the mid game on. Stops are level and region; "close" is within 10 % of the best layout holding them; "cover" is the fewest layouts that are close at every stop:',
      '',
      ...table(['class', 'stops', 'different best layouts', 'fewest that cover', 'layout close at most stops', 'share of stops', 'best in turn'], main.journeys.map(j => [j.className, j.stops, j.distinctBest, j.fewestCover, j.topLayout, percent(j.topShare), j.sequence])),
      '',
      'The whole game, early regions in, for information:',
      '',
      ...table(['class', 'stops', 'different best layouts', 'fewest that cover', 'layout close at most stops', 'share of stops'], wholeJourney.map(j => [j.className, j.stops, j.distinctBest, j.fewestCover, j.topLayout, percent(j.topShare)])),
      '',
      'How much of the XP/hr spread comes from layouts meeting rooms, rather than one layout simply being better everywhere. Log XP/hr with party size fixed and no xp_bonus parties, so neither the split nor the perk confounds it; shares of what is left once room and level are out, each term added in turn:',
      '',
      ...table(['humans', 'stage', 'cells', 'layout simply better', 'layout at this level', 'layout in this region', 'layout in this room', 'rest', 'layout and room together'], spreads.map(s => [s.size, s.label, s.shares.cells, percent(s.shares.layout), percent(s.shares.layoutByLevel), percent(s.shares.layoutByRegion), percent(s.shares.layoutByRoom), percent(s.shares.rest), percent(interaction(s.shares))])),
      '',
      `Rooms that clearly favour a layout, from the mid game on: at least ${ratio(FAVOURED_ROOM)} its usual XP/hr at that level, once room and level are out, among parties of its size:`,
      '',
      ...table(['layout', 'humans', 'room', 'over its usual', 'level pairs', 'pairs close to the best of its size'], favoured.map(f => {
        const t = d.meta.tables[f.room];
        return [f.layout, f.size, `${t.label} [R${t.regionIndex} L${t.roomLevel}]`, ratio(Math.exp(f.effect)), f.pairs, closeInRoom(f.layout, f.size, f.room)];
      })),
    ],
  };
}

// --- I15 ---

interface MaterialCase {
  material: MaterialInfo;
  compId: string;
  level: number;
  /** Undefined: see `why`. */
  source: MaterialSource | undefined;
  /** Why there is no source: it loses every room or loop that drops it, it's below every such room's gate, or a dungeon door refuses it. */
  why?: 'lost' | 'gate' | 'door';
}

interface MaterialSource {
  kind: 'room' | 'dungeon';
  label: string;
  xpPerHour: number;
  hoursPerCraft: number;
  hit: number;
  /** Hours of best-room XP given up per craft. */
  givenUp: number;
}

interface LoopSupply {
  label: string;
  hoursPerCraft: number;
  dungeonHours: number;
  xpPerHour: number;
}

/** A clear cap counts clears a day, so failed attempts run on until the cap's clears are reached, as loopHoursXp reads it. */
export function paidRunsPerHour(runMs: number, clearPct: number, cap: number | undefined): number {
  const runs = (DAY_HOURS * HOUR_MS) / runMs;
  const clearShare = clearPct / 100;
  return (cap !== undefined && runs * clearShare > cap ? cap / clearShare : runs) / DAY_HOURS;
}

class MaterialModel {
  readonly materials: MaterialInfo[];
  private readonly drops: Map<string, number>[];
  private readonly loops = new Map<string, DungeonLoop[]>();
  private readonly allLoops = new Map<string, DungeonLoop[]>();
  private readonly tablesWith = new Map<string, Set<number>>();

  constructor(private readonly d: Data) {
    this.materials = buildMaterials(d.content, d.mod);
    this.drops = encounterDropTables(d.content, d.mod, d.meta.encounters ?? [], d.meta.rewardMultiplier);
    for (const loop of dungeonLoops(d)) {
      push(this.allLoops, `${loop.compId}|${loop.level}`, loop);
      if (loop.clearPct >= WIN_OK_PCT) push(this.loops, `${loop.compId}|${loop.level}`, loop);
    }
    d.meta.tables.forEach(t => {
      if (t.kind !== 'room') return;
      for (const stratum of t.strata) {
        const encounter = stratum.encounterId === null ? -1 : (d.meta.encounters ?? []).indexOf(stratum.encounterId);
        for (const itemId of this.drops[encounter]?.keys() ?? []) {
          const set = this.tablesWith.get(itemId) ?? new Set<number>();
          set.add(t.index);
          this.tablesWith.set(itemId, set);
        }
      }
    });
  }

  dropsInRooms(material: MaterialInfo): boolean {
    return (this.tablesWith.get(material.id)?.size ?? 0) > 0;
  }

  private shareToMember(row: Row, material: MaterialInfo): number {
    const humans = row.members.length;
    const hireClasses = row.cell.hires.map(id => this.d.content.henchmen[id]?.className as string);
    if (material.classes.length === 0) return 1 / (humans + hireClasses.length);
    const matchingHumans = row.members.filter(m => material.classes.includes(m.className)).length;
    const eligible = matchingHumans + hireClasses.filter(c => material.classes.includes(c)).length;
    return eligible === 0 ? 1 / (humans + hireClasses.length) : matchingHumans / eligible / humans;
  }

  private dropsPerWin(row: Row, itemId: string): number {
    let drops = 0;
    for (const [encounter, share, , win] of row.rate.st) drops += share * (win / 100) * (this.drops[encounter]?.get(itemId) ?? 0);
    return drops;
  }

  /** Mean items per hour reaching one human member in this room. */
  roomRate(row: Row, material: MaterialInfo): number {
    let cycle = 0;
    for (const [, share, , , ms] of row.rate.st) cycle += share * (ms + this.d.meta.pauseMs);
    return cycle > 0 ? (this.dropsPerWin(row, material.id) * this.shareToMember(row, material) * HOUR_MS) / cycle : 0;
  }

  /** Mean items per run reaching one human member: monster drops split, floor rewards rolled per member. `rewardFactor` is what a weekly rule leaves of floor reward chances. */
  loopRate(loop: DungeonLoop, material: MaterialInfo, rewardFactor = goldFactors(loop.rule).rewards): number {
    let reach = 1;
    let items = 0;
    loop.floors.forEach(row => {
      const winShare = row.rate.win / 100;
      items += reach * this.dropsPerWin(row, material.id) * this.shareToMember(row, material);
      for (const floor of material.floors) {
        if (floor.dungeonId !== loop.dungeonId || floor.floorIndex !== row.table.floorIndex) continue;
        const rolling = floor.classes.length ? row.members.filter(m => floor.classes.includes(m.className)).length / row.members.length : 1;
        items += reach * winShare * floor.chance * floor.quantity * rolling * rewardFactor;
      }
      reach *= winShare;
    });
    return items;
  }

  /**
   * The ways this loop supplies a craft's worth. Looping: the repeat rate up to any clear cap, plus the week's full clears, which pay more per run.
   * Under a rule, also the full clears alone, a short visit a week. `hoursPerCraft` is how long a craft takes to come; `dungeonHours`, the part of that spent in the dungeon.
   */
  supplies(loop: DungeonLoop, material: MaterialInfo): LoopSupply[] {
    const repeat = this.loopRate(loop, material);
    const full = loop.rule ? this.loopRate(loop, material, 1) : repeat;
    const fullClears = loop.rule?.fullClearsPerWeek ?? 0;
    const extraPerHour = (fullClears * Math.max(0, full - repeat)) / HOURS_PER_WEEK;
    const runHours = loop.runMs / HOUR_MS;
    const runsPerHour = paidRunsPerHour(loop.runMs, loop.clearPct, this.d.policy?.dungeonClearsPerDay);
    const found: LoopSupply[] = [];
    if (repeat > 0) {
      const hoursPerCraft = material.perCraft / (repeat * runsPerHour + extraPerHour);
      found.push({ label: loop.name, hoursPerCraft, dungeonHours: hoursPerCraft * runsPerHour * runHours, xpPerHour: loop.loopingXpPerHour });
    }
    if (fullClears > 0 && full > repeat) {
      const runs = material.perCraft / full;
      found.push({ label: `${loop.name}, full clears only`, hoursPerCraft: (runs * HOURS_PER_WEEK) / fullClears, dungeonHours: runs * runHours, xpPerHour: (mean(loop.xpPerRun) + loop.weeklyLump / fullClears) / runHours });
    }
    return found;
  }

  /** Hours per craft at the fastest loop this party clears at least WIN_OK_PCT %. `uncut` reads it as the atlas's own content pays it, with no weekly rule. */
  fastestLoopHours(material: MaterialInfo, compId: string, level: number, uncut?: MaterialInfo): number | undefined {
    let best: number | undefined;
    for (const loop of this.loops.get(`${compId}|${level}`) ?? []) {
      const uncutRate = uncut ? this.loopRate(loop, uncut, 1) : 0;
      const options = uncut ? (uncutRate > 0 ? [(material.perCraft / uncutRate) * (loop.runMs / HOUR_MS)] : []) : this.supplies(loop, material).map(s => s.hoursPerCraft);
      for (const hours of options) if (best === undefined || hours < best) best = hours;
    }
    return best;
  }

  /** `roomsOnly` leaves dungeon runs out, to read a material's rooms apart from a loop that a detune is about to cut. */
  caseFor(material: MaterialInfo, compId: string, level: number, roomsOnly = false): MaterialCase {
    const d = this.d;
    const idleXp = d.idleRoom(compId, level)?.xp ?? 0;
    const hitOf = (xp: number): number => (idleXp > 0 ? Math.max(0, 1 - xp / idleXp) : xp > 0 ? 0 : 1);
    const dropRooms = this.tablesWith.get(material.id);
    const sources: MaterialSource[] = [];
    let beaten = false;
    for (const row of d.at(compId, level)) {
      if (row.table.kind !== 'room' || !dropRooms?.has(row.table.index)) continue;
      beaten = true;
      if (!d.plausiblyWon(row)) continue;
      const rate = this.roomRate(row, material);
      if (!(rate > 0)) continue;
      const hoursPerCraft = material.perCraft / rate;
      const hit = hitOf(row.xp);
      sources.push({ kind: 'room', label: place(row), xpPerHour: row.xp, hoursPerCraft, hit, givenUp: hit * hoursPerCraft });
    }
    for (const loop of roomsOnly ? [] : this.allLoops.get(`${compId}|${level}`) ?? []) {
      const options = this.supplies(loop, material);
      if (options.length === 0) continue;
      beaten = true;
      if (loop.clearPct < WIN_OK_PCT) continue;
      for (const { label, xpPerHour, hoursPerCraft, dungeonHours } of options) {
        const hit = hitOf(xpPerHour);
        sources.push({ kind: 'dungeon', label, xpPerHour, hoursPerCraft, hit, givenUp: hit * dungeonHours });
      }
    }
    const usable = sources.filter(s => s.hoursPerCraft <= USEFUL_CRAFT_HOURS);
    const source = [...(usable.length ? usable : sources)].sort((a, b) => a.givenUp - b.givenUp || a.hoursPerCraft - b.hoursPerCraft)[0];
    return { material, compId, level, source, ...(source ? {} : { why: beaten ? 'lost' as const : dropRooms?.size ? 'gate' as const : 'door' as const }) };
  }
}

/** The grid levels where a recipe using this material is on-level. */
function onLevelGrid(grid: readonly number[], material: MaterialInfo): number[] {
  const levels = grid.filter(l => l >= material.minLevel && l <= material.maxLevel + MATERIAL_ON_LEVEL_SPAN);
  const first = grid.find(l => l >= material.minLevel);
  return first !== undefined && !levels.includes(first) ? [first, ...levels] : levels;
}

function hitBand(hit: number): 'no hit' | 'under the band' | 'in the band' | 'over the band' | 'far over' {
  if (hit < MATERIAL_NO_HIT) return 'no hit';
  if (hit < MATERIAL_BAND_LOW) return 'under the band';
  if (hit <= MATERIAL_BAND_HIGH) return 'in the band';
  return hit <= MATERIAL_FAR_HIT ? 'over the band' : 'far over';
}

function regionOfLevel(d: Data, level: number): number {
  let found = 0;
  for (const region of d.regions) if (regionEntryLevel(d.content, region) <= level) found = region.index;
  return found;
}

interface MaterialSummary {
  material: MaterialInfo;
  levels: number[];
  region: number;
  dungeonOnly: boolean;
  /** Only floor rewards gave it, and the plan's content or weekly rule cut all of them to nothing. A week's full clears still give it. */
  cutToNothing: boolean;
  /** It still drops, far too slowly to count as obtainable. */
  stranded: boolean;
  /** Medians over the reference parties and on-level grid levels, among those with a source. */
  hit: number;
  hours: number;
  givenUp: number;
  cases: MaterialCase[];
  reachable: MaterialCase[];
  fails: boolean;
}

export function materialSummaries(d: Data): { model: MaterialModel; summaries: MaterialSummary[]; skipped: { noSource: MaterialInfo[]; shopSold: MaterialInfo[] } } {
  const model = new MaterialModel(d);
  const refs = MATERIAL_REFERENCE_PARTIES.filter(id => d.has(id));
  const uncut = new Map(buildMaterials(d.baseContent ?? d.content, d.mod).map(m => [m.id, m]));
  const openDungeons = soloEnterableDungeons(d);
  const leftOfFloors = (m: MaterialInfo, factorOf: (dungeonId: string) => number): number => m.floors.reduce((sum, f) => sum + f.chance * f.quantity * factorOf(f.dungeonId), 0);
  const summaries: MaterialSummary[] = [];
  const noSource: MaterialInfo[] = [];
  const shopSold: MaterialInfo[] = [];
  for (const material of model.materials) {
    if (material.shopSold || (material.monsterIds.length === 0 && material.floors.length === 0)) {
      (material.shopSold ? shopSold : noSource).push(material);
      continue;
    }
    const levels = onLevelGrid(d.meta.grid, material);
    const cases = levels.flatMap(level => refs.map(id => model.caseFor(material, id, level)));
    const reachable = cases.filter(c => c.source);
    const dungeonOnly = !model.dropsInRooms(material);
    const hit = median(reachable.map(c => c.source!.hit));
    const givenUp = median(reachable.map(c => c.source!.givenUp));
    const shortVisit = material.bossToken || dungeonOnly;
    const roomCases = reachable.filter(c => c.source!.kind === 'room').map(c => c.source!);
    const dungeonGivenUp = reachable.filter(c => c.source!.kind === 'dungeon').map(c => c.source!.givenUp);
    const farHit = median(roomCases.map(c => c.hit)) > MATERIAL_FAR_HIT && median(roomCases.map(c => c.givenUp)) >= FAR_HIT_VISIT_GIVEN_UP_HOURS;
    const overLine = farHit || (shortVisit ? givenUp > SHORT_VISIT_GIVEN_UP_HOURS : median(dungeonGivenUp) > SHORT_VISIT_GIVEN_UP_HOURS);
    const floorOnly = dungeonOnly && material.monsterIds.length === 0;
    const factorLeft = (dungeonId: string): number => {
      const rule = weeklyRuleFor(d.policy, dungeonId, openDungeons.has(dungeonId));
      return rule && rule.fullClearsPerWeek > 0 ? 1 : goldFactors(rule).rewards;
    };
    const cutToNothing = floorOnly && !(leftOfFloors(material, factorLeft) > 0) && leftOfFloors(uncut.get(material.id) ?? material, () => 1) > 0;
    const hours = median(reachable.map(c => c.source!.hoursPerCraft));
    const stranded = hours > STRANDED_CRAFT_HOURS;
    const fails = material.usedByGear && (overLine || cutToNothing || stranded);
    summaries.push({ material, levels, region: regionOfLevel(d, material.minLevel), dungeonOnly, cutToNothing, stranded, hit, hours, givenUp, cases, reachable, fails });
  }
  return { model, summaries, skipped: { noSource, shopSold } };
}

export function metricI15(d: Data): Metric {
  const { model, summaries, skipped } = materialSummaries(d);
  if (summaries.length === 0) return { id: 'I15', title: 'Material rooms', pass: null, magnitude: 'no crafting material in this snapshot has a drop source', lines: [] };
  const counted = summaries.filter(s => s.material.usedByGear);
  const goldOnly = summaries.filter(s => s.material.savesGoldOnly && s.reachable.length > 0 && !s.dungeonOnly);
  const measured = counted.filter(s => s.reachable.length > 0);
  const failing = counted.filter(s => s.fails);
  const inHitBands = measured.filter(s => !s.dungeonOnly);
  const dungeonOnly = measured.filter(s => s.dungeonOnly);
  const tokens = measured.filter(s => s.material.bossToken);
  const bandCount = (band: string, list: readonly MaterialSummary[] = inHitBands): number => list.filter(s => hitBand(s.hit) === band).length;
  const hours = (value: number): string => (Number.isFinite(value) ? (value < 0.1 ? '<0.1' : value.toFixed(1)) : '-');
  const regionRows = [...new Set(counted.map(s => s.region))].sort((a, b) => a - b).map(r => {
    const here = inHitBands.filter(s => s.region === r);
    const all = counted.filter(s => s.region === r);
    const reached = all.filter(s => s.reachable.length > 0);
    return [`R${r} ${d.regions[r]?.name ?? ''}`.trim(), all.length, bandCount('no hit', here), bandCount('under the band', here), bandCount('in the band', here), bandCount('over the band', here), bandCount('far over', here), here.filter(s => s.material.bossToken).length, all.filter(s => s.dungeonOnly).length, hours(median(reached.map(s => s.hours))), hours(median(reached.map(s => s.givenUp)))];
  });
  const reference = d.has(TYPICAL_PARTY) ? TYPICAL_PARTY : MATERIAL_REFERENCE_PARTIES.find(id => d.has(id)) ?? '';
  const cheapestFor = (s: MaterialSummary): string => {
    const found = s.cases.filter(c => c.compId === reference && c.source);
    return found.length ? found[0].source!.label : '-';
  };
  const materialRow = (s: MaterialSummary): (string | number)[] => [
    s.material.name,
    `R${s.region}`,
    compactLevels(s.levels),
    Number.isInteger(s.material.perCraft) ? s.material.perCraft : s.material.perCraft.toFixed(2),
    s.dungeonOnly ? 'dungeon only' : s.material.bossToken ? 'boss token' : s.material.floors.length ? 'rooms and floors' : 'rooms',
    percent(s.hit),
    hours(s.hours),
    hours(s.givenUp),
    `${s.reachable.length}/${s.cases.length}`,
    s.material.freeOnce ? s.material.freeOnce.toFixed(1) : '-',
    cheapestFor(s),
    s.fails ? 'fails' : '',
  ];
  const materialHeaders = ['material', 'region', 'on-level grid levels', 'per craft', 'source', 'XP hit, median', 'hours per craft', 'XP given up, best-room hours', 'reference cases with a source', 'free once', `cheapest, ${reference}`, ''];
  const allParties = d.meta.comps.filter(playedNormally).map(c => c.id);
  const everyParty = counted.flatMap(s => s.levels.flatMap(level => allParties.map(id => model.caseFor(s.material, id, level))));
  const everyBand = (band: string): string => {
    const reached = everyParty.filter(c => c.source);
    return percent(reached.filter(c => hitBand(c.source!.hit) === band).length / Math.max(1, reached.length));
  };
  const refs = MATERIAL_REFERENCE_PARTIES.filter(id => d.has(id));
  const goingBack = MATERIAL_GOING_BACK.map(offset => {
    const list = measured.flatMap(s => {
      const level = d.meta.grid.find(l => l >= s.material.maxLevel + offset - 2 && l <= s.material.maxLevel + offset + MATERIAL_ON_LEVEL_SPAN);
      return level === undefined ? [] : refs.map(id => model.caseFor(s.material, id, level)).filter(c => c.source);
    });
    return [`${offset} levels above its recipes`, list.length, percent(median(list.map(c => c.source!.hit))), hours(median(list.map(c => c.source!.hoursPerCraft))), hours(median(list.map(c => c.source!.givenUp)))];
  });
  const dungeonCases = counted.flatMap(s => s.cases.filter(c => c.source?.kind === 'dungeon').map(c => ({ s, c })));
  const dungeonRows = counted.filter(s => s.material.floors.length > 0 || s.dungeonOnly).map(s => {
    const here = s.cases.filter(c => c.source?.kind === 'dungeon');
    return [s.material.name, s.dungeonOnly ? 'yes' : 'no', here.length, percent(median(here.map(c => c.source!.hit))), hours(median(here.map(c => c.source!.hoursPerCraft))), hours(median(here.map(c => c.source!.givenUp))), fmt(median(here.map(c => c.source!.xpPerHour))), [...new Set(here.map(c => c.source!.label))].join(', ') || '-'];
  });
  const offBand = (s: MaterialSummary): boolean => hitBand(s.hit) === 'far over' && !s.dungeonOnly;
  const bandsLine = (hits: readonly number[]): string => (['no hit', 'under the band', 'in the band', 'over the band', 'far over'] as const).map(band => `${hits.filter(h => hitBand(h) === band).length} ${band}`).join(', ');
  const roomsOnlyHits = inHitBands.flatMap(s => {
    const cases = s.levels.flatMap(level => refs.map(id => model.caseFor(s.material, id, level, true))).filter(c => c.source);
    return cases.length ? [median(cases.map(c => c.source!.hit))] : [];
  });
  const noSource = everyParty.filter(c => !c.source);
  const noSourceFor = (why: MaterialCase['why']): number => noSource.filter(c => c.why === why).length;
  return {
    id: 'I15',
    title: 'Material rooms',
    pass: measured.length || failing.length ? failing.length === 0 : null,
    short: `${failing.length}/${measured.length} fail, ${bandCount('in the band')} in band, ${bandCount('far over')} far over`,
    values: {
      materials: counted.length, measured: measured.length, failing: failing.length,
      noHit: bandCount('no hit'), underBand: bandCount('under the band'), inBand: bandCount('in the band'), overBand: bandCount('over the band'), farOver: bandCount('far over'),
      bossTokens: tokens.length, dungeonOnly: dungeonOnly.length, savesGoldOnly: goldOnly.length, cutToNothing: counted.filter(s => s.cutToNothing).length, stranded: counted.filter(s => s.stranded).length,
      casesWithNoSource: noSource.length, cases: everyParty.length,
      medianHit: median(inHitBands.map(s => s.hit)), medianHoursPerCraft: median(measured.map(s => s.hours)), medianGivenUp: median(measured.map(s => s.givenUp)),
      dungeonSourceMedianHit: median(dungeonCases.map(x => x.c.source!.hit)), dungeonSourceMedianGivenUp: median(dungeonCases.map(x => x.c.source!.givenUp)), dungeonOnlyMedianGivenUp: median(dungeonOnly.map(s => s.givenUp)),
    },
    magnitude: `${measured.length} crafting materials at about the player's level, cheapest source for ${refs.length} reference parties: ${bandCount('no hit')} no hit, ${bandCount('under the band')} under the ${percent(MATERIAL_BAND_LOW)} to ${percent(MATERIAL_BAND_HIGH)} band, ${bandCount('in the band')} in it, ${bandCount('over the band')} over it, ${bandCount('far over')} over ${percent(MATERIAL_FAR_HIT)} (${inHitBands.filter(s => offBand(s) && s.material.bossToken).length} of those boss tokens), ${dungeonOnly.length} only in dungeons${counted.some(s => s.cutToNothing) ? `, ${counted.filter(s => s.cutToNothing).length} floor-reward materials cut to nothing by this plan` : ''}${counted.some(s => s.stranded) ? `, ${counted.filter(s => s.stranded).length} taking over ${STRANDED_CRAFT_HOURS} hours per craft` : ''}; ${failing.length} fail; median ${hours(median(measured.map(s => s.hours)))} hours per craft, ${hours(median(measured.map(s => s.givenUp)))} hours of best-room XP given up`,
    lines: [
      `For each crafting material a gear recipe needs, at the grid levels where such a recipe is on-level, for ${refs.join(', ')}: the source that gives up the least best-room XP per craft, read from the plan's own snapshot. The XP hit is how much less XP/hr it pays than that party's best non-boss room won at least ${WIN_OK_PCT} %. Each material's figure is the median across those parties and levels.`,
      '',
      `The working band is a hit of ${percent(MATERIAL_BAND_LOW)} to ${percent(MATERIAL_BAND_HIGH)}, and no hit is also fine. Fails if a material's median hit in rooms is over ${percent(MATERIAL_FAR_HIT)}, the far bigger hit ruled out at about the player's own level, and the visit gives up at least ${FAR_HIT_VISIT_GIVEN_UP_HOURS} hours of best-room XP per craft, whatever drops it: a far bigger hit for a few minutes isn't a significant hit. Those ${FAR_HIT_VISIT_GIVEN_UP_HOURS} hours are adjustable. A boss token, a material only dungeons give, or a party whose cheapest source is a dungeon run also fails on over ${SHORT_VISIT_GIVEN_UP_HOURS} hours of best-room XP given up per craft, since repeat clears are heavily detuned. A material only floor rewards give, cut to nothing by the plan, fails too, since dungeon materials must stay obtainable, and so does any material whose median takes over ${STRANDED_CRAFT_HOURS} hours per craft, four weeks, set so that one full clear a week can supply a craft. "Hours per craft" is how long a craft takes to come, and XP given up counts only the time spent in the dungeon, so a material from a week's full clears reads as many hours for little XP given up. The hit bands below read whichever source is cheapest, so a detune moves them without failing anything by itself. Reading rooms alone, with no dungeon runs, the bands are: ${bandsLine(roomsOnlyHits)}. A source slower than ${USEFUL_CRAFT_HOURS} hours per craft is used only if nothing else exists. ${goldOnly.length} materials reach gear only through parts a shop also sells, so farming them just saves gold and they don't count; counting them as well, the bands read: ${bandsLine([...inHitBands, ...goldOnly].map(s => s.hit))}. A material reaching gear through a part no shop sells does count. Ingredients from shops alone: ${skipped.shopSold.length}. Only from quests or first clears: ${skipped.noSource.length}.`,
      '',
      ...table(['region', 'materials', 'no hit', `under ${percent(MATERIAL_BAND_LOW)}`, `in the band`, `${percent(MATERIAL_BAND_HIGH)} to ${percent(MATERIAL_FAR_HIT)}`, `over ${percent(MATERIAL_FAR_HIT)}`, 'of those rows, boss tokens', 'only in dungeons', 'median hours per craft', 'median XP given up, best-room hours'], regionRows),
      '',
      `Across every normally played party, ${everyParty.length} party, level and material cases: ${['no hit', 'under the band', 'in the band', 'over the band', 'far over'].map(band => `${band} ${everyBand(band)}`).join(', ')}, of those with a source. ${noSource.length} cases have none: ${noSourceFor('lost')} lose every room or loop that drops it, ${noSourceFor('gate')} are below every such room's gate, ${noSourceFor('door')} are barred by a dungeon door or have no floor cell.`,
      '',
      'Dungeon-sourced materials, at repeat rate, so a plan that detunes a dungeon moves these. Hit and hours are for the cases where a dungeon is the cheapest source:',
      '',
      ...table(['material', 'only in dungeons', 'cases taking a dungeon', 'XP hit', 'hours per craft', 'XP given up, best-room hours', 'looping XP/hr', 'dungeons'], dungeonRows),
      '',
      'Going back for an old material, the same reference parties, reported only: that costs more, which is the no-backwards rule working:',
      '',
      ...table(['going back', 'cases', 'XP hit, median', 'hours per craft', 'XP given up, best-room hours'], goingBack),
      '',
      'Every material:',
      '',
      ...table(materialHeaders, counted.map(materialRow)),
      ...(summaries.length > counted.length ? ['', 'Materials that only save gold or reach no gear, reported only. "Per craft" is per gear craft, down through the part:', '', ...table(materialHeaders, summaries.filter(s => !s.material.usedByGear).map(materialRow))] : []),
    ],
  };
}

// --- Cheats the atlas can't express ---

export function metricNotSimulated(d?: Data): Metric {
  return {
    id: 'Not simulated',
    title: 'What the atlas can\'t express',
    pass: null,
    short: `${NOT_SIMULATED.length} things`,
    magnitude: `${NOT_SIMULATED.length} things read neither pass nor fail on this card: ${NOT_SIMULATED.map(c => c.family.toLowerCase()).join('; ')}`,
    lines: [
      'These are open questions for any plan, not passes. The harness fights fixed parties through full fights, so it has nothing to measure them with. Test them in the running game before a plan ships.',
      '',
      ...table(['family', 'why this card can\'t see it'], NOT_SIMULATED.map(c => [c.family, c.why])),
      ...(d ? ['', `Skills granted by items, read from this snapshot: ${skillGrantNote(d.content)}`] : []),
    ],
  };
}

// --- Progression ---

/** `stream` is XP/hr on top of the rate, such as weekly quests. */
function simulateDays(d: Data, rate: (level: number) => number, lumps: readonly QuestLump[], stream?: (level: number) => number): Map<number, number> {
  const pending = [...lumps].sort((a, b) => a.availableAt - b.availableAt);
  const reached = new Map<number, number>();
  let level = 1;
  let xp = 0;
  let hours = 0;
  let next = 0;
  while (level < MAX_LEVEL) {
    while (next < pending.length && pending[next].availableAt <= level) xp += pending[next++].xp;
    const need = d.mod.xpForNextLevel(level);
    if (xp >= need) {
      xp -= need;
      level++;
      reached.set(level, hours / DAY_HOURS);
      continue;
    }
    const r = rate(level) + (stream?.(level) ?? 0);
    if (!(r > 0)) break;
    hours += (need - xp) / r;
    xp = 0;
    level++;
    reached.set(level, hours / DAY_HOURS);
  }
  return reached;
}

interface Persona {
  name: string;
  rate: (level: number) => number;
  lumps: readonly QuestLump[];
  weeklies: readonly QuestLump[];
  note?: string;
}

export function metricProgression(d: Data): Metric {
  const everywhere = d.ledger.once;
  const starterQuests = questsWithinRegion(d.ledger, 0);
  const starterWeeklies = repeatablesWithinRegion(d.ledger, 0);
  const allWeeklies = d.ledger.repeatable;
  const fiveComps = d.meta.comps.filter(c => c.members.length === 5 && playedNormally(c) && c.hires === 'none').map(c => c.id);
  const allComps = d.comps('core', 'extended', 'hired').map(c => c.id);
  const loops = dungeonLoops(d).filter(l => l.clearPct >= WIN_OK_PCT);
  const firstClears: QuestLump[] = Object.values(d.content.dungeons as Record<string, any>).filter(x => (x.firstClearXp ?? 0) > 0).map(x => ({
    id: x.id, name: x.name, xp: x.firstClearXp, regionIndex: null, needsRegions: [], requiredLevel: x.entryRequirements?.minLevel ?? 1, availableAt: x.entryRequirements?.minLevel ?? 1, prerequisites: [], repeat: 'once',
  }));

  const best = (ids: readonly string[], filter: (r: Row) => boolean) => (level: number): number => {
    let top = 0;
    for (const id of ids) for (const r of d.at(id, level)) if (filter(r) && r.xp > top) top = r.xp;
    return top;
  };
  const winner = (r: Row): boolean => r.rate.win >= WIN_OK_PCT;
  const typical = makeCurve(d, level => typicalAcross(d, [TYPICAL_PARTY], level));
  const afkRoom = makeCurve(d, level => {
    const rows = d.at(TYPICAL_PARTY, level).filter(r => r.table.kind === 'room' && r.table.zeroXp && r.rate.win >= WIN_OK_PCT);
    return rows.length ? median(rows.map(r => r.xp)) : 0;
  });
  let bossGaps = 0;
  const bossRate = makeCurve(d, level => {
    const refs = [FULL_PARTY, TYPICAL_PARTY];
    const room = Math.max(0, ...refs.flatMap(id => d.at(id, level).filter(r => r.table.kind === 'room' && r.table.boss && winner(r)).map(r => d.bossDayRate(r))));
    const loop = Math.max(0, ...loops.filter(l => l.level === level && refs.includes(l.compId)).map(l => l.xpPerHour + l.weeklyLump / HOURS_PER_WEEK));
    if (!(room > 0 || loop > 0)) bossGaps++;
    const idle = Math.max(0, ...refs.map(id => d.idleRoom(id, level)?.xp ?? 0));
    const value = Math.max(room, loop, idle);
    return value > 0 ? value : typicalAcross(d, [TYPICAL_PARTY], level);
  });
  const personas: Persona[] = [
    { name: 'optimal 5-party', rate: makeCurve(d, best(fiveComps, r => d.isFarmRoom(r.table) && winner(r))), lumps: everywhere, weeklies: allWeeklies },
    { name: `typical on-level party (${TYPICAL_PARTY})`, rate: typical, lumps: everywhere, weeklies: allWeeklies },
    { name: 'solo with hires', rate: makeCurve(d, level => typicalAcross(d, HIRE_IDS, level)), lumps: everywhere, weeklies: allWeeklies },
    { name: `solo + ${SOLO_FILL_HIRES} free hires, best room`, rate: makeCurve(d, best(FILL_IDS, r => d.isFarmRoom(r.table) && winner(r))), lumps: everywhere, weeklies: allWeeklies },
    { name: 'pure solo', rate: makeCurve(d, level => typicalAcross(d, SOLO_IDS, level)), lumps: everywhere, weeklies: allWeeklies },
    { name: 'starter-sitter, any party', rate: makeCurve(d, best(allComps, r => r.table.kind === 'room' && r.table.regionIndex === 0 && winner(r))), lumps: starterQuests, weeklies: starterWeeklies },
    { name: 'AFK half the time in a room the content has at zero XP', rate: (level: number) => (typical(level) + afkRoom(level)) / 2, lumps: everywhere, weeklies: allWeeklies },
    { name: 'boss farmer', rate: bossRate, lumps: [...everywhere, ...firstClears], weeklies: allWeeklies, note: 'First-clear XP counted with quests.' },
  ];
  const col = (reached: Map<number, number>): string[] => TARGET_LEVELS.map(t => {
    const days = reached.get(t);
    return days === undefined ? 'never' : days.toFixed(1);
  });
  const rows = personas.flatMap(p => [
    [p.name, 'no quests', ...col(simulateDays(d, p.rate, []))],
    [p.name, 'quests', ...col(simulateDays(d, p.rate, p.lumps))],
    [p.name, 'quests + weeklies', ...col(simulateDays(d, p.rate, p.lumps, level => repeatableXpPerHour(p.weeklies, level)))],
  ]);
  const sitter = personas.find(p => p.name.startsWith('starter-sitter'))!;
  const typicalDays = simulateDays(d, typical, []).get(MAX_LEVEL);
  const sitterDays = simulateDays(d, sitter.rate, []);
  const sitterL20 = sitterDays.get(20);
  const sitterTop = sitterDays.get(MAX_LEVEL);
  const typicalL20 = simulateDays(d, typical, []).get(20);
  const typicalWeeklies = simulateDays(d, typical, everywhere, level => repeatableXpPerHour(allWeeklies, level)).get(MAX_LEVEL);
  const typicalQuests = simulateDays(d, typical, everywhere).get(MAX_LEVEL);
  const regionRows = d.regions.map(r => {
    const once = d.ledger.once.filter(q => q.regionIndex === r.index);
    const repeat = d.ledger.repeatable.filter(q => q.regionIndex === r.index);
    const entry = regionEntryLevel(d.content, r);
    const nextEntry = d.regions[r.index + 1] ? regionEntryLevel(d.content, d.regions[r.index + 1]) : MAX_LEVEL + 1;
    let curve = 0;
    for (let l = entry; l < nextEntry && l < MAX_LEVEL; l++) curve += d.mod.xpForNextLevel(l);
    const inBand = once.filter(q => q.availableAt < nextEntry).reduce((sum, q) => sum + q.xp, 0);
    const onceXp = once.reduce((sum, q) => sum + q.xp, 0);
    const repeatXp = repeat.reduce((sum, q) => sum + q.xp, 0);
    return [`R${r.index} ${r.name}`, once.length, fmt(onceXp), fmt(inBand), curve > 0 ? `${((100 * inBand) / curve).toFixed(0)} %` : '-', repeat.length, fmt(repeatXp), fmt(repeatXp / 7 / DAY_HOURS)];
  });
  const onceTotal = d.ledger.once.reduce((s, q) => s + q.xp, 0);
  const repeatTotal = d.ledger.repeatable.reduce((s, q) => s + q.xp, 0);
  const weeklyCurve = d.meta.grid.map(level => {
    const weekly = repeatableXpPerHour(allWeeklies, level);
    const rate = typical(level);
    return [level, fmt(weekly), fmt(repeatableXpPerHour(starterWeeklies, level)), fmt(rate), ratio(weekly / rate)];
  });
  return {
    id: 'Progression',
    title: 'Days to level',
    pass: null,
    short: `typical L${MAX_LEVEL} in ${typicalDays?.toFixed(0) ?? 'never'} days, sitter L20 in ${sitterL20?.toFixed(0) ?? 'never'}`,
    values: { typicalDaysToMax: typicalDays ?? NaN, typicalDaysToL20: typicalL20 ?? NaN, typicalDaysToMaxWithQuests: typicalQuests ?? NaN, typicalDaysToMaxWithWeeklies: typicalWeeklies ?? NaN, sitterDaysToL20: sitterL20 ?? NaN, sitterDaysToMax: sitterTop ?? NaN },
    magnitude: `without quests: typical on-level party reaches L${MAX_LEVEL} in ${typicalDays?.toFixed(0) ?? 'never'} days, L20 in ${typicalL20?.toFixed(0) ?? 'never'}; with one-off quests L${MAX_LEVEL} in ${typicalQuests?.toFixed(0) ?? 'never'}, and with every weekly on time ${typicalWeeklies?.toFixed(0) ?? 'never'}; the best starter-sitter reaches L20 in ${sitterL20?.toFixed(0) ?? 'never'}, L${MAX_LEVEL} in ${sitterTop?.toFixed(0) ?? 'never'}`,
    lines: [
      `Cumulative days, simulated level by level with on-level rates interpolated between grid levels; "never" means no room it wins pays anything at some level. The boss farmer takes the best of a boss room, a dungeon loop and its best non-boss room, since nobody would farm a worse one; ${bossGaps} grid levels have no boss room or loop it beats. "Quests" are optimistic, since time spent is free; leaving weeklies out pushed the other way.`,
      '',
      ...table(['persona', '', ...TARGET_LEVELS.map(t => `L${t}`)], rows),
      '',
      `Weekly income, every weekly available at the level done on time, as XP/hr, against the typical party's on-level XP/hr:`,
      '',
      ...table(['level', 'weekly XP/hr equivalent', 'in the starter region', `${TYPICAL_PARTY} on-level XP/hr`, 'weekly / on-level'], weeklyCurve),
      '',
      `Quest XP: ${fmt(onceTotal)} in ${d.ledger.once.length} one-off quests, ${fmt(repeatTotal)} in ${d.ledger.repeatable.length} repeatable quests, ${d.ledger.noXp} quests pay no XP. Starter-sitter quests: ${fmt(starterQuests.reduce((s, q) => s + q.xp, 0))} in ${starterQuests.length}, plus ${starterWeeklies.length} weeklies. First-clear XP across dungeons: ${fmt(firstClears.reduce((s, q) => s + q.xp, 0))}. ${d.ledger.danglingPrerequisites.length} dangling prerequisites, ${d.ledger.cycles.length} cycles.`,
      '',
      ...table(['region', 'one-off quests', 'one-off XP', 'available before the next region', 'share of the XP curve across the region', 'repeatable quests', 'repeatable XP per cycle', 'repeatable XP/hr if done every week'], regionRows),
    ],
  };
}

// --- Auto-retreat exposure ---

function metricRetreat(d: Data): Metric {
  const rooms = d.rows.filter(r => r.table.kind === 'room');
  const exposed = rooms.filter(r => r.rate.skip > 0);
  const wonExposed = exposed.filter(r => r.rate.win >= WIN_OK_PCT);
  const whole = rooms.filter(r => r.rate.reloc);
  const paying = d.meta.tables.filter(t => t.kind === 'room' && !t.zeroXp);
  const payingTiles = paying.reduce((sum, t) => sum + t.tileCount, 0);
  const bordering = paying.reduce((sum, t) => sum + (t.zeroNeighbourTiles ?? 0), 0);
  const { pairs } = bestRoomPairs(d);
  const bestExposed = pairs.filter(p => p.party && p.party.rate.skip > 0).length;
  const soloExposed = new Set(pairs.filter(p => p.solo.rate.skip > 0).map(p => `${p.className}|${p.level}`)).size;
  const atFamily = (family: string): (string | number)[] => {
    const list = rooms.filter(r => r.comp.family === family);
    const skip = list.filter(r => r.rate.skip > 0);
    return [family, list.length, skip.length, skip.filter(r => r.rate.win >= WIN_OK_PCT).length, skip.filter(r => r.rate.reloc).length];
  };
  return {
    id: 'Retreat',
    title: 'Auto-retreat exposure',
    pass: null,
    short: `${wonExposed.length} won cells exposed`,
    values: { roomCells: rooms.length, exposed: exposed.length, wonAndExposed: wonExposed.length, wholeRoomUnder: whole.length, payingRoomsBorderingZero: bordering, payingRooms: payingTiles },
    magnitude: `${exposed.length}/${rooms.length} room cells have a pack under the auto-retreat line, ${wonExposed.length} of them won at least ${WIN_OK_PCT} %; each earns between 0 and its shown rate; ${bordering}/${payingTiles} paying rooms border a room that pays nothing`,
    lines: [
      'Auto-retreat is on by default. A party with a pack under the line leaves the room after three skips in ten fights, at once if the whole room is under it, and holds in its target until a player moves it. The target is the previous room if safe, else the neighbour it wins most. So a party that walked into a risky room from a room with the same table keeps about the shown rate, and one placed next to a room that pays nothing can end up in it, earning nothing around the clock with auto-retreat as the cause. That target rule is a game rule to raise in the plan and design discussion, not a harness result.',
      '',
      ...table(['family', 'room cells', 'with skips', 'won at least 90 %', 'whole room under the line'], [...new Set(rooms.map(r => r.comp.family))].map(atFamily)),
      '',
      `Whole room under the line: ${whole.length} cells. Among I1's best-room picks, ${bestExposed}/${pairs.length} party rooms and ${soloExposed} class + level solo rooms have skips: those pairs compare ranges, and I1 prints the count with such rooms left out.`,
    ],
  };
}

// --- Rendering ---

export interface ScorecardOptions {
  atlas: string;
  out: string;
  baselineCurve?: string;
  activeHours: number;
  reentrySeconds: number;
  jobs?: number;
  /** Fresh fights per cell a verdict leans on; 0 skips them, which suits a quick sweep. */
  topupFights?: number;
  /** Where new fresh samples go, so the atlas is only read. Absent: the atlas's own refine folder, shared between plans. */
  sampleDir?: string;
}

function timeoutLine(d: Data): string {
  const longFights = d.rows.filter(r => r.rate.hz > 0);
  const atCap = d.rows.filter(r => r.rate.to > 0);
  const skipping = d.rows.filter(r => r.rate.skip > 0);
  const refused = d.cells.filter(c => c.ineligible);
  const gated = refused.filter(c => c.ineligible!.startsWith(REACH_REFUSAL));
  const capHours = d.meta.longFightCapMs / HOUR_MS;
  return `${d.rows.length} cells, ${d.rows.reduce((s, r) => s + (r.rate.first?.n ?? r.rate.n), 0)} fights; ${refused.length} more cells are ineligible: ${gated.length} because a member is below the room's level gates, the rest by dungeon entry rules, hires at dungeon entrances, a hire missing on the map or no xp_bonus unlocked. ${longFights.length} cells have fights past the forecast horizon, fought to their end and paid as the game would; ${atCap.length} of them have fights still going at the ${capHours} h cap, which pay nothing. ${skipping.length} cells have packs under the auto-retreat line, ${skipping.filter(r => r.rate.win >= WIN_OK_PCT).length} of them won at least ${WIN_OK_PCT} %: each of those earns between 0 and its shown rate, and tables print it as a range.`;
}

function noiseLine(d: Data): string {
  const { refine } = d.meta;
  const nearLine = refine ? `${refine.cells.length} near-line cells (read ${refine.band[0]} to ${refine.band[1]} % won) use a fresh sample of ${refine.fights} fights` : 'This atlas has no near-line pass';
  const { fights, rounds, simulatedCells, leftOver } = d.resample;
  if (!(fights > 0)) return `${nearLine}. Verdict picks were not re-sampled for this run, so verdicts near a line can move with the seed.`;
  const total = rounds.reduce((a, b) => a + b, 0);
  const second = d.secondLook;
  return `${nearLine}. Cells a verdict leaned on, re-sampled at ${fights} fights before counting: ${total} over ${rounds.length} rounds (${simulatedCells} not sampled by an earlier plan).${leftOver ? ` ${leftOver} more were still leaned on when the rounds or the limit of ${RESAMPLE_CELL_LIMIT} ran out, and count on their first read.` : ''} A second look, read by I6 and I8b only and never written to rates.jsonl: ${second.reread} cells at ${second.rereadFights} fights, ${second.confirmed} at ${second.confirmFights} (${second.simulatedCells} simulated for this run).${second.leftOver ? ` ${second.leftOver} flagged cells over the limit of ${CONFIRM_CELL_LIMIT} count on what they read before.` : ''}`;
}

/** What a sound rule wouldn't do but a broken one might, printed where nobody can miss it. */
export function sanityWarnings(d: Data, metrics: readonly Metric[]): string[] {
  const warnings: string[] = [];
  const won = d.rows.filter(r => r.table.kind === 'room' && !r.table.zeroXp && r.rate.win >= WIN_OK_PCT);
  const unpaid = won.filter(r => r.rate.xpf.every(x => x === 0));
  if (won.length && unpaid.length / won.length > UNPAID_WARNING_SHARE) warnings.push(`The plan pays nothing in ${unpaid.length} of the ${won.length} cells won in rooms whose content pays XP. That looks like a broken plan, not a rule.`);
  const blank = metrics.filter(m => m.pass === null && !UNSCORED_METRICS.includes(m.id));
  if (blank.length) warnings.push(`${blank.map(m => m.id).join(', ')} read n/a: nothing was measured, which is not a pass. Either the atlas lacks those compositions or the plan pays too little to compare.`);
  if (d.plan) {
    const stacked = Math.max(2, maxOf(d.cells.map(c => c.xpMult)));
    const paid = xpBonusProbe(d.plan, d.mod, d.meta.rewardMultiplier, stacked, d.planState);
    if (paid < stacked * (1 - NOISE_TOLERANCE)) warnings.push(`On the same fight, a member holding an XP multiplier of ${stacked} earns ${ratio(paid)} under this plan. xp_bonus, stacked or not, is a designed perk no plan may cap, and dropping it can read as an improvement.`);
    if (paysLostFights(d.plan, d.mod, d.meta.rewardMultiplier, d.planState)) warnings.push('This plan pays on a lost fight, which the game doesn\'t. I8b reads what that does to the rooms a party loses, but only compares best rooms, so read those rows too.');
  }
  const efficiency = metrics.find(m => m.id === 'I7')?.values;
  if (efficiency && efficiency.spreadGroups > 0 && !(efficiency.killRateCorrelation >= FLAT_PAY_CORRELATION)) warnings.push(`Within a room, level and party size, kill rate hardly orders XP/hr (rank correlation ${Number.isFinite(efficiency.killRateCorrelation) ? efficiency.killRateCorrelation.toFixed(2) : 'none'}). I7 can't fail pay that ignores what the party does; whether a flat spread is allowed is a design choice.`);
  const xpOnlyRules = xpOnlyDungeonRules(d);
  if (xpOnlyRules.length) warnings.push(`This plan's dungeon rule cuts repeat XP in ${xpOnlyRules.join(', ')} but leaves coin and floor rewards in full, which is what an unset repeatCoinFactor and repeatRewardFactor mean. Unless a retuneContent cut takes their place, that gold is still there, and I16 reads it.`);
  warnings.push(...goldWarnings(d));
  if (d.baseContent) {
    const before = questXpTotals(d.baseContent);
    const after = questXpTotals(d.content);
    const cut = (Object.keys(before) as (keyof typeof before)[]).filter(key => after[key] < before[key]);
    if (cut.length) warnings.push(`This plan cuts ${cut.map(key => `${key} from ${fmt(before[key])} to ${fmt(after[key])}`).join(', ')}. First clears and weekly quests are meant to stay, so unless this is meant, levelling is being slowed where no verdict looks.`);
  }
  return warnings;
}

function questXpTotals(content: XpSnapshot): { 'first-clear XP': number; 'weekly quest XP': number; 'one-off quest XP': number } {
  const quests = Object.values(content.quests ?? {}) as any[];
  const questXp = (keep: (q: any) => boolean): number => quests.filter(keep).reduce((sum, q) => sum + (q.rewards ?? []).filter((r: any) => r.kind === 'xp').reduce((total: number, r: any) => total + (r.amount ?? 0), 0), 0);
  return {
    'first-clear XP': (Object.values(content.dungeons) as any[]).reduce((sum, x) => sum + (x.firstClearXp ?? 0), 0),
    'weekly quest XP': questXp(q => (q.repeat ?? 'once') !== 'once'),
    'one-off quest XP': questXp(q => (q.repeat ?? 'once') === 'once'),
  };
}

/** What evaluatePlan leaves in plan.json. */
interface PlanInfo {
  id: string;
  title?: string;
  describe: string;
  params?: Record<string, number>;
  overrides?: Record<string, number>;
  planPath?: string;
  snapshot: string;
  statePath?: string;
}

export async function loadData(options: ScorecardOptions): Promise<Data> {
  const atlas = resolve(options.atlas);
  const out = resolve(options.out);
  const meta = readMeta(atlas);
  const cells = readCells(atlas);
  const planInfo = JSON.parse(readFileSync(join(out, PLAN_FILE), 'utf8')) as PlanInfo;
  const snapshotPath = planInfo.snapshot && existsSync(planInfo.snapshot) ? planInfo.snapshot : join(atlas, SNAPSHOT_FILE);
  const { content } = readSnapshot(snapshotPath);
  const { regions } = buildRegions(content);
  const mod: any = await import('../../../shared/src/index.js');
  const plan = planInfo.planPath ? await loadPlan(planInfo.planPath, planInfo.overrides) : undefined;
  const curve = options.baselineCurve ? (JSON.parse(readFileSync(options.baselineCurve, 'utf8')) as Record<string, Record<string, number>>) : null;
  const data = new Data(meta, cells, readRates(out), content, regions, buildQuestLedger(content, regions), mod, plan, options.activeHours, options.reentrySeconds * 1000, curve, readPlanState(planInfo.statePath));
  if (snapshotPath !== join(atlas, SNAPSHOT_FILE)) data.baseContent = readSnapshot(join(atlas, SNAPSHOT_FILE)).content;
  return data;
}

export function allMetrics(d: Data): Metric[] {
  return [metricI1, metricLiteral, metricI1b, metricI2, metricI3, metricI4, metricI5, metricI6, metricI7, metricI8, metricI8b, metricI9, metricI10, metricI16, metricI11, metricI12, metricI13, metricI14, metricI15, metricGold, metricProgression, metricRetreat, metricNotSimulated].map(metric => metric(d));
}

function verdict(pass: boolean | null): string {
  if (pass === null) return 'n/a';
  return pass ? 'PASS' : 'FAIL';
}

function verdictCount(metrics: readonly Metric[]): string {
  const scored = metrics.filter(m => m.pass !== null);
  return `${scored.filter(m => !m.pass).length} of ${scored.length} scored metrics fail.`;
}

function verdictTable(metrics: readonly Metric[]): string[] {
  return table(['metric', 'verdict', 'magnitude'], metrics.map(m => [`${m.id} ${m.title}`, verdict(m.pass), m.magnitude]));
}

/** The card's own facts and verdict table, stamped with the card it came from, so nobody relays figures from an older run. */
export function renderSummary(d: Data, planId: string, metrics: readonly Metric[], cardSha1: string): string {
  return [
    `# XP scorecard summary: ${planId}`,
    '',
    `Generated from scorecard.md, sha1 ${cardSha1}. Anything that disagrees with this file is out of date.`,
    '',
    `Atlas: ${d.meta.tables.length} tables, ${d.meta.comps.length} compositions, seed ${d.meta.seed}. ${timeoutLine(d)}`,
    '',
    noiseLine(d),
    '',
    ...coverageNotes(d).flatMap(note => [`**Coverage:** ${note}`, '']),
    ...sanityWarnings(d, metrics).flatMap(w => [`**WARNING: ${w}**`, '']),
    verdictCount(metrics),
    '',
    ...verdictTable(metrics),
    '',
  ].join('\n');
}

export function renderMarkdown(d: Data, planId: string, describe: string, metrics: readonly Metric[]): string {
  const { meta } = d;
  return [
    `# XP scorecard: ${planId}`,
    '',
    describe,
    '',
    `Atlas: engine ${meta.engineRef}, snapshot sha1 ${meta.snapshotSha1}, ${meta.tables.length} tables, ${meta.comps.length} compositions (${meta.families.join(', ')}), ${meta.fightsPerCell} fights per cell, seed ${meta.seed}. Pause ${meta.pauseMs} ms, auto-retreat at ${meta.autoRetreatBelowPct} % costing ${meta.retreatMs} ms. ${timeoutLine(d)}`,
    '',
    noiseLine(d),
    '',
    ...coverageNotes(d).flatMap(note => [`**Coverage:** ${note}`, '']),
    ...sanityWarnings(d, metrics).flatMap(w => [`**WARNING: ${w}**`, '']),
    verdictCount(metrics),
    '',
    ...verdictTable(metrics),
    '',
    ...metrics.flatMap(m => [`## ${m.id} ${m.title}: ${verdict(m.pass)}`, '', m.magnitude, '', ...m.lines, '']),
    '## Modelling assumptions',
    '',
    ...MODEL_ASSUMPTIONS.map(a => `- ${a}`),
    ...meta.log.map(l => `- Atlas note: ${l}`),
    '',
  ].join('\n');
}

/**
 * The not yet re-sampled cells a verdict leans on: the rooms picked for every pair within reach of its line, the rooms that
 * could really be the best one if their first read came in low, and, for a pair that fails, the rooms that could rescue it.
 */
export function verdictCells(d: Data): Set<number> {
  const ids = new Set<number>();
  const add = (r: Row | undefined): void => {
    if (r && !r.rate.first) ids.add(r.cell.id);
  };
  for (const p of bestRoomPairs(d).pairs) {
    if (p.group !== ARCHER_HIRED_KNIGHT && !(p.ratio < RESAMPLE_MARGIN)) continue;
    add(p.party);
    add(p.solo);
    p.soloRooms.filter(r => r.rate.xp[0] >= p.soloXp / UNDER_READ).forEach(add);
    if (failsBeyondNoise(p)) p.partyRooms.filter(r => r.rate.xp[p.member] >= (p.soloXp * (1 - NOISE_TOLERANCE)) / UNDER_READ).forEach(add);
  }
  for (const a of additionRows(d)) {
    if (!(a.ratio < RESAMPLE_MARGIN)) continue;
    add(a.beforeRow);
    add(a.afterRow);
    a.beforeRooms.filter(r => r.rate.xp[a.beforeMember] >= a.before / UNDER_READ).forEach(add);
    if (a.ratio < 1 - NOISE_TOLERANCE) a.afterRooms.filter(r => r.rate.xp[a.afterMember] >= (a.before * (1 - NOISE_TOLERANCE)) / UNDER_READ).forEach(add);
  }
  for (const p of backwardsPairs(d).pairs) {
    if (!(p.ratio > 1 / RESAMPLE_MARGIN)) continue;
    add(p.low);
    add(p.ref);
    p.lowRooms.filter(r => r.xp >= p.low.xp / UNDER_READ).forEach(add);
    if (p.ratio > 1 + NOISE_TOLERANCE) p.refRooms.filter(r => r.xp >= p.low.xp / (1 + NOISE_TOLERANCE) / UNDER_READ).forEach(add);
  }
  for (const p of starterPairs(d)) {
    if (!(p.ratio > 1 / RESAMPLE_MARGIN)) continue;
    add(p.starter);
    medianRows(p.journey).forEach(add);
  }
  for (const a of starterAnchors(d)) {
    if (!a.sitter || !(a.sitter.xp > a.journeyMedian / RESAMPLE_MARGIN)) continue;
    add(a.sitter);
    medianRows(a.journey).forEach(add);
  }
  for (const r of monotoneResults(d)) {
    for (const i of r.near) {
      add(i.low);
      add(i.high);
    }
  }
  for (const c of variantCells(d).cells) {
    if (!FLAGGED_KINDS.includes(c.kind)) continue;
    add(c.row);
    add(c.normal);
  }
  for (const x of farmRows(d).filter(row => row.idle)) {
    const threshold = (x.idleXp * FARM_PASS_RATIO) / RESAMPLE_MARGIN;
    if (x.boss && x.bossXp > threshold) {
      add(x.boss);
      add(x.idle);
    }
    if (x.dungeon && x.dungeon.xpPerHour > threshold) {
      x.dungeon.floors.forEach(add);
      add(x.idle);
    }
  }
  if (d.has(FULL_PARTY)) {
    for (const r of soloShares(d)) {
      SOLO_IDS.forEach((id, i) => {
        if (!(r.shares[i] > 1 / RESAMPLE_MARGIN)) return;
        medianRows(d.onLevel(id, r.level)).forEach(add);
        medianRows(d.onLevel(FULL_PARTY, r.level)).forEach(add);
      });
    }
  }
  return ids;
}

async function resampleVerdictCells(d: Data, options: ScorecardOptions, planInfo: PlanInfo): Promise<void> {
  const fights = options.topupFights ?? 0;
  if (!(fights > 0) || !planInfo.planPath) return;
  const jobs = options.jobs ?? 1;
  const run = { atlas: resolve(options.atlas), plan: planInfo.planPath, snapshot: planInfo.snapshot, statePath: planInfo.statePath, jobs, params: planInfo.overrides };
  const extra = options.sampleDir ? join(resolve(options.sampleDir), `f${fights}`) : undefined;
  const log: ResampleLog = { fights, rounds: [], simulatedCells: 0, leftOver: 0 };
  d.resample = log;
  let budget = RESAMPLE_CELL_LIMIT;
  for (let round = 0; round < RESAMPLE_ROUNDS && budget > 0; round++) {
    const ids = [...verdictCells(d)].slice(0, budget);
    if (ids.length === 0) break;
    log.simulatedCells += await ensureSampled(run.atlas, ids, fights, jobs, undefined, extra);
    d.absorb(await evaluateSampled(run, resolve(options.out), ids, fights, extra));
    log.rounds.push(ids.length);
    budget -= ids.length;
  }
  log.leftOver = verdictCells(d).size;
}

/** Cells to read again at the fresh-sample size: I6's faster parties not yet fresh on both sides, and I8b's flagged picks. */
export function rereadCells(d: Data): number[] {
  const ids = new Set<number>();
  const add = (r: Row): void => {
    if (d.sampleSize(r) === 0) ids.add(r.cell.id);
  };
  for (const c of variantCells(d).cells) {
    if (c.kind !== 'faster party') continue;
    add(c.row);
    add(c.normal);
  }
  for (const p of losingPairs(d)) {
    if (p.ratio <= 1 + NOISE_TOLERANCE) continue;
    add(p.lost);
    add(p.won);
  }
  return [...ids];
}

/** Flagged variants a bigger sample could still clear, nearest the line first. */
export function confirmCells(d: Data): number[] {
  const flagged = variantCells(d).cells.map(c => ({ c, read: finalRead(d, c) })).filter(x => FLAGGED_KINDS.includes(x.read.kind) && x.read.ratio < CONFIRM_MARGIN).sort((a, b) => a.read.ratio - b.read.ratio);
  return [...new Set(flagged.flatMap(x => [x.c.row.cell.id, x.c.normal.cell.id]))];
}

async function runSecondLook(d: Data, options: ScorecardOptions, planInfo: PlanInfo): Promise<void> {
  const fights = options.topupFights ?? 0;
  if (!(fights > 0) || !planInfo.planPath) return;
  const out = resolve(options.out);
  const jobs = options.jobs ?? 1;
  const run = { atlas: resolve(options.atlas), plan: planInfo.planPath, snapshot: planInfo.snapshot, statePath: planInfo.statePath, jobs, params: planInfo.overrides };
  const log: SecondLookLog = { reread: 0, rereadFights: fights, confirmed: 0, confirmFights: CONFIRM_FIGHTS, simulatedCells: 0, leftOver: 0 };
  d.secondLook = log;
  const read = async (ids: readonly number[], size: number): Promise<void> => {
    const dir = join(out, SECOND_LOOK_DIR, `f${size}`);
    log.simulatedCells += await ensureSampled(run.atlas, ids, size, jobs, undefined, dir);
    d.absorbSecond(await evaluateSampled(run, out, ids, size, dir), size);
  };
  for (let round = 0; round < SECOND_LOOK_ROUNDS; round++) {
    const ids = rereadCells(d);
    if (ids.length === 0) break;
    await read(ids, fights);
    log.reread += ids.length;
  }
  const flagged = confirmCells(d);
  const ids = flagged.slice(0, CONFIRM_CELL_LIMIT);
  log.leftOver = flagged.length - ids.length;
  if (ids.length) await read(ids, CONFIRM_FIGHTS);
  log.confirmed = ids.length;
}

/** I16's cases near its line: their floors, and every room that could really be the yardstick. */
export function goldLookCells(d: Data): number[] {
  const ids = new Set<number>();
  const add = (r: Row): void => {
    if (!r.rate.first && !d.goldSecond.has(r.cell.id)) ids.add(r.cell.id);
  };
  for (const c of soloGoldCases(d)) {
    const line = 1 + NOISE_TOLERANCE;
    if (!(c.ratio > line / RESAMPLE_MARGIN && c.ratio < line * RESAMPLE_MARGIN)) continue;
    c.gold.loop.floors.forEach(add);
    d.at(c.gold.loop.compId, c.gold.loop.level).filter(r => r.table.kind === 'room' && notBossRoom(r) && Math.min(d.coinPerHour(r), d.atlasCoinPerHour(r)) >= c.roomCoin / UNDER_READ).forEach(add);
  }
  return [...ids];
}

async function runGoldLook(d: Data, options: ScorecardOptions, planInfo: PlanInfo): Promise<void> {
  const fights = options.topupFights ?? 0;
  if (!(fights > 0) || !planInfo.planPath) return;
  const out = resolve(options.out);
  const jobs = options.jobs ?? 1;
  const run = { atlas: resolve(options.atlas), plan: planInfo.planPath, snapshot: planInfo.snapshot, statePath: planInfo.statePath, jobs, params: planInfo.overrides };
  const dir = join(out, SECOND_LOOK_DIR, `f${fights}`);
  d.goldLook.fights = fights;
  for (let round = 0; round < SECOND_LOOK_ROUNDS; round++) {
    const ids = goldLookCells(d);
    if (ids.length === 0) break;
    d.goldLook.simulatedCells += await ensureSampled(run.atlas, ids, fights, jobs, undefined, dir);
    for (const [id, rate] of await evaluateSampled(run, out, ids, fights, dir)) d.goldSecond.set(id, rate);
    d.goldLook.cells += ids.length;
  }
}

/** What `leaderboard` reads. Non-finite values read null, which JSON would write anyway. */
function cardJson(d: Data, planInfo: PlanInfo, title: string, metrics: readonly Metric[]): unknown {
  return {
    plan: planInfo.id,
    title,
    describe: planInfo.describe,
    params: planInfo.params ?? {},
    overrides: planInfo.overrides ?? {},
    resample: d.resample,
    secondLook: d.secondLook,
    warnings: sanityWarnings(d, metrics),
    coverage: coverageNotes(d),
    notSimulated: NOT_SIMULATED.map(c => c.family),
    metrics: metrics.map(m => ({ id: m.id, title: m.title, pass: m.pass, scored: !UNSCORED_METRICS.includes(m.id), magnitude: m.magnitude, short: m.short ?? m.magnitude, values: m.values ?? {} })),
  };
}

export async function renderScorecardFiles(options: ScorecardOptions): Promise<string[]> {
  const out = resolve(options.out);
  const data = await loadData(options);
  const planInfo = JSON.parse(readFileSync(join(out, PLAN_FILE), 'utf8')) as PlanInfo;
  await resampleVerdictCells(data, options, planInfo);
  writeRates(out, data.rawRates());
  await runSecondLook(data, options, planInfo);
  await runGoldLook(data, options, planInfo);
  const metrics = allMetrics(data);
  const title = planInfo.title ?? planTitle(planInfo.id, planInfo.overrides);
  const md = renderMarkdown(data, title, planInfo.describe, metrics);
  const mdPath = join(out, 'scorecard.md');
  const jsonPath = join(out, 'scorecard.json');
  const summaryPath = join(out, 'summary.md');
  const curvePath = join(out, 'curve.json');
  writeFileSync(mdPath, md);
  writeFileSync(summaryPath, renderSummary(data, title, metrics, createHash('sha1').update(md).digest('hex')));
  writeFileSync(jsonPath, JSON.stringify(cardJson(data, planInfo, title, metrics), null, 2));
  writeFileSync(curvePath, JSON.stringify(buildCurve(data), null, 2));
  return [mdPath, summaryPath, jsonPath, curvePath, join(out, RATES_FILE)];
}

// --- Compare two runs ---

export interface RunRef {
  atlas: string;
  out: string;
}

interface KeyedRate {
  table: XpTable;
  comp: XpComp;
  level: number;
  rate: CellRate;
}

function keyedRates(ref: RunRef): Map<string, KeyedRate> {
  const meta = readMeta(resolve(ref.atlas));
  const cells = readCells(resolve(ref.atlas));
  const map = new Map<string, KeyedRate>();
  for (const rate of readRates(resolve(ref.out))) {
    const cell = cells[rate.c];
    const comp = meta.comps[cell.comp];
    const t = meta.tables[cell.table];
    map.set(`${t.key}|${comp.id}|${cell.level}`, { table: t, comp, level: cell.level, rate });
  }
  return map;
}

/** Cell by cell over the cells both runs have. */
export function compareRuns(a: RunRef, b: RunRef, labelA: string, labelB: string): string {
  const ra = keyedRates(a);
  const rb = keyedRates(b);
  const pairs: { key: string; x: KeyedRate; y: KeyedRate; ratio: number; winDelta: number; timeRatio: number }[] = [];
  for (const [key, x] of ra) {
    const y = rb.get(key);
    if (!y) continue;
    const xa = mean(x.rate.xp);
    const ya = mean(y.rate.xp);
    pairs.push({ key, x, y, ratio: xa > 0 ? ya / xa : NaN, winDelta: y.rate.win - x.rate.win, timeRatio: x.rate.ms > 0 ? y.rate.ms / x.rate.ms : NaN });
  }
  const finite = (xs: number[]): number[] => xs.filter(Number.isFinite);
  const comps = [...new Set(pairs.map(p => p.x.comp.id))];
  const regions = [...new Set(pairs.map(p => p.x.table.regionIndex))].sort((p, q) => p - q);
  const onLevel = pairs.filter(p => p.x.table.kind === 'room' && Math.abs(p.x.table.roomLevel - p.x.level) <= ON_LEVEL_BAND);
  const flips = pairs.filter(p => (p.x.rate.win >= WIN_OK_PCT) !== (p.y.rate.win >= WIN_OK_PCT));
  return [
    `# ${labelB} against ${labelA}`,
    '',
    `${pairs.length} cells in common. ${labelB} over ${labelA}: XP/hr median ${ratio(median(finite(pairs.map(p => p.ratio))))}, fight time median ${ratio(median(finite(pairs.map(p => p.timeRatio))))}. ${flips.length} cells cross the ${WIN_OK_PCT} % win line (${flips.filter(p => p.y.rate.win >= WIN_OK_PCT).length} up, ${flips.filter(p => p.y.rate.win < WIN_OK_PCT).length} down).`,
    '',
    'By composition, on-level rooms:',
    '',
    ...table(['party', 'cells', 'XP/hr ratio median', 'p10', 'p90', 'fight time ratio', 'win pct points'], comps.map(id => {
      const list = onLevel.filter(p => p.x.comp.id === id);
      const rs = finite(list.map(p => p.ratio));
      return [id, list.length, ratio(median(rs)), ratio(quantile(rs, 0.1)), ratio(quantile(rs, 0.9)), ratio(median(finite(list.map(p => p.timeRatio)))), median(list.map(p => p.winDelta)).toFixed(1)];
    })),
    '',
    'By region, on-level rooms:',
    '',
    ...table(['region', 'cells', 'XP/hr ratio median', 'p10', 'p90'], regions.map(r => {
      const rs = finite(onLevel.filter(p => p.x.table.regionIndex === r).map(p => p.ratio));
      return [`R${r}`, rs.length, ratio(median(rs)), ratio(quantile(rs, 0.1)), ratio(quantile(rs, 0.9))];
    })),
    '',
  ].join('\n');
}

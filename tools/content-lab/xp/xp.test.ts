import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyBattleManager } from '../../../server/src/game/PartyBattleManager.js';
import { ServerBattleTimer } from '../../../server/src/game/ServerBattleTimer.js';
import * as shared from '../../../shared/src/index.js';
import { loadNewEngine } from '../engines.js';
import { buildRegions, chooseLoadout, humanSeats } from '../policy.js';
import { hashSeed, makeRng } from '../sim.js';
import { dungeonRefusal } from './atlas.js';
import { ALL_FAMILIES, ARCHER_HIRED_KNIGHT, CORE_BAND, DEFAULT_SEAT_PREFIX, DUO_FILL_HIRES, MAGE_BARD_PARTIES, SOLO_FILL_HIRES, STALL_BAND, XP_BONUS_PREFIX, buildComps } from './comps.js';
import { assertPayoutsAgree, assertPlanPays, readRates, writeRates } from './evaluate.js';
import { createEvaluator, monsterInfoOf } from './evaluator.js';
import type { EvaluatorEnv } from './evaluator.js';
import { runFight } from './fight.js';
import { annotateTables, computeReach, memberReaches } from './gates.js';
import { FightGold, applyGoldFactors, dropShare, expectedSplitCoin, floorRewardValue, goldFactors, goldStops, itemSaleValue, loopRunGold, monsterDropValue } from './gold.js';
import { compareLayouts, coverOfStops, effectiveNumber, layoutSpread } from './layouts.js';
import type { SpreadRow } from './layouts.js';
import { readCard, readCards, renderLeaderboard } from './leaderboard.js';
import { buildMaterials, encounterDropTables, expectedPack } from './materials.js';
import type { FightView, MemberView, MonsterGroup, MonsterInfo, PayoutContext, XpPlan } from './plan.js';
import { MAX_WEEKLY_FULL_CLEARS, applyParamOverrides, assertBossPolicy, assertParamsReachPolicy, assertRewardsOnlyChange, assertWeeklyRule, loadPlan, parseParamFlags, planBossPolicy, planTitle, xpRulesOf } from './plan.js';
import baseline from './plans/baseline.js';
import { definePlan, fightPot, fightXpInput, growingPotShare, memberXp, partyLevelSpread, powerShare, shippedXp, weeklyRuleForSoloDungeons, weightedBodies } from './plans/lib.js';
import { buildQuestLedger, questsWithinRegion, repeatableXpPerHour, repeatablesWithinRegion } from './quests.js';
import { PartyBuilder, gearRegionIndex, strongestHires } from './party.js';
import { GOLD_FILE, RATES_FILE, goldLine, rateLine } from './rates-file.js';
import { cellFile, sampleDir, sampleFile } from './refine.js';
import { applyRework, changeSummary, loadRework, renderChangeSummary } from './rework.js';
import { RowWriter, forEachRow } from './rows.js';
import { Data, NOT_SIMULATED, applyWeeklyRule, bestRoomPairs, bossHoursXp, classifyVariant, confirmCells, coverageNotes, gearShareOfRewards, gearWithNoSource, goldLookCells, literalCases, literalFeasibility, loopHoursXp, losingPairs, median, metricI1, metricI10, metricI11, metricI12, metricI13, metricI14, metricI15, metricI1b, metricI2, metricI3, metricI5, metricI6, metricI7, metricI8, metricI8b, metricGold, metricI16, metricI9, metricLiteral, metricNotSimulated, metricProgression, midGameRegion, paidRunsPerHour, paysLostFights, quantile, reachReading, renderSummary, rereadCells, robustReach, safeRatio, sanityWarnings, shareCurve, skillGrantNote, skillGrants, soloGoldCases, soloLayoutPairs, soloPlayability, spearman, verdictCells, weeklyExcessXp, weeklyRuleFor, xpBonusProbe } from './scorecard.js';
import { buildTables, fightsPerStratum } from './tables.js';
import { RESULT_TIMEOUT, RESULT_VICTORY } from './types.js';
import type { AtlasMeta, CellGold, CellRate, FightRow, XpCell, XpSnapshot, XpTable } from './types.js';

const mod: any = shared;

function seedContent(): XpSnapshot {
  return {
    monsters: mod.SEED_MONSTERS,
    items: {},
    zones: mod.SEED_ZONES,
    encounters: mod.SEED_ENCOUNTERS,
    sets: {},
    shops: {},
    henchmen: {},
    dungeons: {},
    skills: mod.SEED_SKILLS,
    skillSlotSchedules: mod.SEED_SKILL_SLOT_SCHEDULES,
    world: { defaultMapId: '', maps: [], tiles: [] },
  };
}

describe('row format', () => {
  it('round-trips rows across read buffer boundaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-rows-'));
    const path = join(dir, 'rows.bin');
    const count = 300_000;
    const writer = new RowWriter(path);
    for (let i = 0; i < count; i++) {
      writer.write({
        cell: i,
        encounter: i % 7 === 0 ? 0xffff : i % 500,
        result: i % 4,
        deaths: i % 6,
        realMs: 1800 * i,
        damage: i / 4,
        minHp: (i % 11) / 10,
        pastHorizon: i % 3 === 0,
        groups: i % 5 === 0 ? [] : [i % 200, 2, 1, (i + 1) % 200, 0, 3],
      });
    }
    writer.close();
    let seen = 0;
    let mismatches = 0;
    forEachRow(path, (row: FightRow) => {
      const groupsOk = row.groups.length === (seen % 5 === 0 ? 0 : 6);
      const fieldsOk = row.cell === seen && row.encounter === (seen % 7 === 0 ? 0xffff : seen % 500) && row.result === seen % 4 && row.realMs === 1800 * seen && row.pastHorizon === (seen % 3 === 0);
      const closeOk = Math.abs(row.damage - seen / 4) < 1 && Math.abs(row.minHp - Math.min(1, (seen % 11) / 10)) < 1e-3;
      if (!groupsOk || !fieldsOk || !closeOk) mismatches++;
      seen++;
    });
    expect(mismatches).toBe(0);
    expect(seen).toBe(count);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a file from an older format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-rows-'));
    const path = join(dir, 'rows.bin');
    writeFileSync(path, 'XPR2');
    expect(() => forEachRow(path, () => {})).toThrow(/rebuild the atlas/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops where the visitor says', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-rows-'));
    const path = join(dir, 'rows.bin');
    const writer = new RowWriter(path);
    for (let i = 0; i < 10; i++) writer.write({ cell: i, encounter: 0, result: 0, deaths: 0, realMs: 1, damage: 0, minHp: 1, pastHorizon: false, groups: [] });
    writer.close();
    const seen: number[] = [];
    forEachRow(path, row => {
      seen.push(row.cell);
      return row.cell === 3 ? false : undefined;
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('compositions', () => {
  const comps = buildComps(ALL_FAMILIES);

  it('covers every class subset exactly once between core and extended', () => {
    const ids = new Set(comps.filter(c => c.family === 'core' || c.family === 'extended').filter(c => c.hires === 'none' && !c.id.includes('x')).map(c => c.id));
    expect(ids.size).toBe(31);
  });

  it('names the Archer + hired Knight case in core, at every level', () => {
    const hired = comps.find(c => c.id === ARCHER_HIRED_KNIGHT)!;
    expect(hired.family).toBe('core');
    expect(hired.hires).toEqual({ className: 'Knight' });
    expect(hired.band[1]).toBeGreaterThan(STALL_BAND[1]);
  });

  it('gives every stall variant a reference that exists', () => {
    const ids = new Set(comps.map(c => c.id));
    for (const c of comps.filter(x => x.reference)) expect(ids.has(c.reference!)).toBe(true);
  });

  it('keeps carried friends below their carrier', () => {
    for (const c of comps.filter(x => x.family === 'carry')) {
      const carriers = c.members.filter(m => m.role === 'carrier');
      const friends = c.members.filter(m => m.role === 'friend');
      expect(carriers.length).toBeGreaterThan(0);
      expect(friends.length).toBeGreaterThan(0);
      expect(friends.every(f => f.levelOffset < 0)).toBe(true);
    }
  });
});

describe('retuneContent guard', () => {
  const snapshot = (): XpSnapshot => ({
    ...seedContent(),
    monsters: { a: { id: 'a', xp: 1, hp: 5, damage: 3, goldMin: 2, goldMax: 4, drops: [{ itemId: 'x', chance: 0.1 }] } },
    items: { x: { id: 'x', name: 'X', value: 10, attack: 3 } },
    dungeons: { d: { id: 'd', name: 'D', firstClearXp: 9, firstClearGold: 7, firstClearRewards: [{ itemId: 'x', chance: 1 }], entryRequirements: { minLevel: 2 }, floors: [{ xpFactor: 0.5, coinFactor: 0.5, encounterTable: [{ encounterId: 'e', weight: 1 }], rewards: [{ itemId: 'x', chance: 0.5, minQty: 1, maxQty: 2 }] }] } },
    quests: { q: { id: 'q', rewards: [{ kind: 'xp', amount: 10 }, { kind: 'gold', amount: 3 }] } },
  } as unknown as XpSnapshot);

  it('allows XP changes', () => {
    const after = snapshot();
    after.monsters.a.xp = 99;
    after.quests!.q.rewards[0].amount = 500;
    expect(() => assertRewardsOnlyChange(snapshot(), after)).not.toThrow();
  });

  it('allows gold and reward changes, which fights never read', () => {
    const after: any = snapshot();
    after.monsters.a.goldMin = 0;
    after.monsters.a.goldMax = 1;
    after.dungeons.d.floors[0].rewards[0].chance = 0;
    after.dungeons.d.floors[0].rewards[0].minQty = 2;
    after.dungeons.d.floors[0].rewards[0].maxQty = 3;
    after.items.x.value = 0;
    expect(() => assertRewardsOnlyChange(snapshot(), after)).not.toThrow();
  });

  it('refuses a plan removing a monster\'s coin roll, which the game would pay as NaN', () => {
    for (const field of ['goldMin', 'goldMax']) {
      const after: any = snapshot();
      delete after.monsters.a[field];
      expect(() => assertRewardsOnlyChange(snapshot(), after)).toThrow(field);
    }
    const unwritten: any = snapshot();
    delete unwritten.monsters.a.goldMin;
    delete unwritten.monsters.a.goldMax;
    expect(() => assertRewardsOnlyChange(unwritten, JSON.parse(JSON.stringify(unwritten)))).not.toThrow();
  });

  describe('a shop buying back for more than it sells', () => {
    const sold = (): XpSnapshot => ({ ...snapshot(), shops: { s1: { id: 's1', inventory: [{ itemId: 'x', price: 20 }] }, s2: { id: 's2', inventory: [{ itemId: 'x', price: 15 }] } } } as unknown as XpSnapshot);

    it('refuses a value raised over the item\'s lowest price, which is gold from nothing', () => {
      const after: any = sold();
      after.items.x.value = 16;
      expect(() => assertRewardsOnlyChange(sold(), after)).toThrow(/lowest shop price 15/);
    });

    it('allows a raise up to that price, and any value for an item no shop sells', () => {
      const after: any = sold();
      after.items.x.value = 15;
      expect(() => assertRewardsOnlyChange(sold(), after)).not.toThrow();
      const unsold: any = snapshot();
      unsold.items.x.value = 99999;
      expect(() => assertRewardsOnlyChange(snapshot(), unsold)).not.toThrow();
    });

    it('leaves content already written over its price alone, and lets a plan cut it', () => {
      const written = (value: number): any => {
        const s: any = sold();
        s.items.x.value = value;
        return s;
      };
      expect(() => assertRewardsOnlyChange(written(50), written(50))).not.toThrow();
      expect(() => assertRewardsOnlyChange(written(50), written(40))).not.toThrow();
      expect(() => assertRewardsOnlyChange(written(50), written(51))).toThrow(/lowest shop price/);
    });
  });

  it.each([
    ['HP', (s: any) => { s.monsters.a.hp = 6; }],
    ['monster damage', (s: any) => { s.monsters.a.damage = 4; }],
    ['monster drops', (s: any) => { s.monsters.a.drops[0].chance = 0.2; }],
    ['quest gold', (s: any) => { s.quests.q.rewards[1].amount = 4; }],
    ['a removed monster', (s: any) => { delete s.monsters.a; }],
    ['an added item', (s: any) => { s.items.y = { id: 'y' }; }],
    ['another section', (s: any) => { s.shops = { x: { id: 'x' } }; }],
    ['NaN XP', (s: any) => { s.monsters.a.xp = NaN; }],
    ['negative XP', (s: any) => { s.monsters.a.xp = -1; }],
    ['a quest paying infinite XP', (s: any) => { s.quests.q.rewards[0].amount = Infinity; }],
    ['item stats', (s: any) => { s.items.x.attack = 4; }],
    ['a negative item value', (s: any) => { s.items.x.value = -1; }],
    ['half a gold of item value', (s: any) => { s.items.x.value = 1.5; }],
    ['half a gold of coin', (s: any) => { s.monsters.a.goldMin = 1.5; }],
    ['goldMin over goldMax', (s: any) => { s.monsters.a.goldMin = 5; }],
    ['negative coin', (s: any) => { s.monsters.a.goldMax = -1; }],
    ['a floor reward chance over 1', (s: any) => { s.dungeons.d.floors[0].rewards[0].chance = 1.5; }],
    ['a NaN floor reward chance', (s: any) => { s.dungeons.d.floors[0].rewards[0].chance = NaN; }],
    ['half a floor reward', (s: any) => { s.dungeons.d.floors[0].rewards[0].maxQty = 1.5; }],
    ['a floor reward moved to another item', (s: any) => { s.dungeons.d.floors[0].rewards[0].itemId = 'y'; }],
    ['an added floor reward', (s: any) => { s.dungeons.d.floors[0].rewards.push({ itemId: 'x', chance: 1 }); }],
    ['a floor reward\'s class restriction', (s: any) => { s.dungeons.d.floors[0].rewards[0].classRestriction = ['Knight']; }],
    ['a floor\'s encounters', (s: any) => { s.dungeons.d.floors[0].encounterTable = []; }],
    ['a floor\'s XP factor, which the atlas holds', (s: any) => { s.dungeons.d.floors[0].xpFactor = 0.6; }],
    ['a floor\'s coin factor, which the atlas holds', (s: any) => { s.dungeons.d.floors[0].coinFactor = 0.6; }],
    ['first-clear gold, which stays', (s: any) => { s.dungeons.d.firstClearGold = 1; }],
    ['first-clear rewards, which stay', (s: any) => { s.dungeons.d.firstClearRewards = []; }],
    ['a dungeon door', (s: any) => { s.dungeons.d.entryRequirements.minLevel = 3; }],
  ])('refuses %s', (_name, change) => {
    const after = snapshot();
    change(after);
    expect(() => assertRewardsOnlyChange(snapshot(), after)).toThrow();
  });
});

interface FakeFight {
  monsters: any[];
  humans: { level: number; className?: string; equippedSkills?: unknown[] }[];
  hires?: { className?: string; level?: number }[];
  starterZone?: boolean;
  floor?: { xpFactor?: number; coinFactor?: number };
  getMonster?: (id: string) => unknown;
  getItem?: (id: string) => unknown;
}

/** PartyBattleManager.payVictory itself, on a stub manager: what each human is handed, in member order. */
function realPayVictory(fight: FakeFight): { xp: number; gold: number; items: string[] }[] {
  const paid: { xp: number; gold: number; items: string[] }[] = [];
  const humans = fight.humans.map((h, i) => ({ username: `m${i}`, isHenchman: false, className: 'Knight', equippedSkills: [], ...h }));
  const hires = (fight.hires ?? []).map((h, i) => ({ username: `hire${i}`, isHenchman: true, className: 'Knight', level: 1, equippedSkills: [], ...h }));
  const sessions = new Map(humans.map((h, i) => [h.username, {
    isAway: () => false,
    handleVictory: (rewards: { xp: number; gold: number; items: string[] }) => {
      paid[i] = rewards;
    },
    recordKills: () => {},
    quests: { applyKill: () => {} },
  }]));
  const manager = Object.create(PartyBattleManager.prototype);
  manager.getSession = (username: string) => sessions.get(username);
  manager.floorOfRun = () => fight.floor;
  manager.handleDungeonFloorCleared = () => {};
  manager.content = {
    getMonster: fight.getMonster ?? (() => undefined),
    getItem: fight.getItem ?? (() => undefined),
    getQuestCatalog: () => ({}),
    getAllZones: () => ({ z: { id: 'z', starterZone: fight.starterZone } }),
  };
  const entry = { partyId: 'p', serverParty: { tile: { id: 't', zone: 'z' } }, ...(fight.floor ? { dungeonRun: {} } : {}) };
  manager.payVictory(entry, { players: [...humans, ...hires], monsters: fight.monsters });
  return paid;
}

interface XpCase {
  defs: any[];
  standing: boolean[];
  levels: number[];
  hires: number;
  bonus: number;
  starterZone?: boolean;
  floor?: { xpFactor?: number };
}

function realXp(c: XpCase): number[] {
  const monsters = c.defs.map((def, i) => ({ ...mod.createMonsterInstance(def), currentHp: c.standing[i] ? 1 : 0 }));
  const xpBonus = c.bonus ? [{ passiveEffects: [{ kind: 'xp_bonus', flatValue: c.bonus }] }] : [];
  return realPayVictory({
    monsters,
    humans: c.levels.map((level, i) => ({ level, equippedSkills: i === 0 ? xpBonus : [] })),
    hires: Array.from({ length: c.hires }, () => ({})),
    starterZone: c.starterZone,
    floor: c.floor,
  }).map(r => r.xp);
}

function baselineXp(c: XpCase): number[] {
  const groups: MonsterGroup[] = c.defs.map((def, i) => ({ def: monsterInfoOf(mod, def.id, def), killed: c.standing[i] ? 0 : 1, standing: c.standing[i] ? 1 : 0 }));
  const members: MemberView[] = c.levels.map((level, index) => ({ index, className: 'Knight', level, role: 'member' }));
  const table = { kind: c.floor ? 'floor' : 'room', starterZone: !!c.starterZone, ...(c.floor ? { floorXpFactor: c.floor.xpFactor } : {}) } as unknown as XpTable;
  const ctx: PayoutContext = {
    party: { compId: 'x', family: 'core', members, hires: Array.from({ length: c.hires }, (_, i) => `h${i}`), hireDetails: [], shareCount: members.length + c.hires, xpMultiplier: 1 + c.bonus },
    table,
    rewardMultiplier: mod.COMBAT_PACE.rewardMultiplier,
    pauseMs: 1800,
    params: {},
    rules: xpRulesOf(mod),
  };
  const fight: FightView = { result: 'victory', won: true, realMs: 1, partyDamage: 1, minHpFrac: 1, deaths: 0, pastHorizon: false, encounterId: null, monsters: groups };
  return members.map(m => baseline.payout(fight, m, ctx));
}

const FLOOR_FACTORS = [undefined, 0, 0.1, 0.5, 1, 1.5, NaN];

describe('baseline plan', () => {
  const mob = (id: string, level: number | undefined, extra: Record<string, unknown> = {}): any => ({ id, name: id, hp: 200, damage: 20, damageType: 'physical', xp: 1000, level, ...extra });

  it('reproduces PartyBattleManager.payVictory on random fights, ceil included', () => {
    const rng = makeRng(hashSeed('baseline-parity'));
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    for (let trial = 0; trial < 3000; trial++) {
      const count = int(1, 9);
      const defs = Array.from({ length: count }, (_, i) => {
        const passive = rng() < 0.15;
        return mob(`m${i}`, rng() < 0.85 ? int(1, 60) : undefined, {
          xp: rng() < 0.1 ? 0 : int(1, 5000),
          hp: rng() < 0.1 ? 1 : int(2, 5000),
          damage: rng() < 0.15 ? int(0, 1) : int(2, 500),
          ...(rng() < 0.2 ? { skills: [{ skillId: 'zap' }] } : {}),
          ...(passive ? { passive: true } : {}),
        });
      });
      const standing = defs.map(d => !!d.passive || rng() < 0.1);
      const humans = int(1, 5);
      const onFloor = rng() < 0.3;
      const xpCase: XpCase = {
        defs,
        standing,
        levels: Array.from({ length: humans }, () => int(1, 60)),
        hires: int(0, 5 - humans),
        bonus: rng() < 0.3 ? 0.05 * int(1, 3) : 0,
        starterZone: rng() < 0.4,
        ...(onFloor ? { floor: { xpFactor: FLOOR_FACTORS[int(0, FLOOR_FACTORS.length - 1)] } } : {}),
      };
      expect(baselineXp(xpCase)).toEqual(realXp(xpCase));
    }
  });

  it.each([
    ['a monster far below the member', { defs: [mob('a', 10)], levels: [30] }],
    ['a monster over the highest human, paying the challenge bonus', { defs: [mob('a', 40)], levels: [30, 20] }],
    ['a harmless monster over the party', { defs: [mob('a', 40, { damage: 0 })], levels: [30] }],
    ['a carried friend paid as the carrier is', { defs: [mob('a', 32)], levels: [30, 5] }],
    ['a hire as a full body', { defs: [mob('a', 30)], levels: [30], hires: 1 }],
    ['a lone player in a starter zone', { defs: [mob('a', 3)], levels: [3], starterZone: true }],
    ['a party in a starter zone', { defs: [mob('a', 3)], levels: [3, 3], starterZone: true }],
    ['a lone player with a hire in a starter zone', { defs: [mob('a', 3)], levels: [3], hires: 1, starterZone: true }],
    ['a floor\'s XP factor', { defs: [mob('a', 30), mob('b', 30, { xp: 3 })], levels: [30], floor: { xpFactor: 0.25 } }],
    ['a floor in a starter zone, which keeps the party share', { defs: [mob('a', 3)], levels: [3], starterZone: true, floor: {} }],
    ['an invalid floor factor, paying in full', { defs: [mob('a', 30)], levels: [30], floor: { xpFactor: 1.5 } }],
    ['an xp_bonus', { defs: [mob('a', 30)], levels: [30, 30], bonus: 0.1 }],
  ])('matches payVictory on %s', (_name, partial) => {
    const xpCase: XpCase = { standing: partial.defs.map(() => false), hires: 0, bonus: 0, ...partial } as XpCase;
    expect(baselineXp(xpCase)).toEqual(realXp(xpCase));
    expect(realXp(xpCase).every(xp => xp > 0)).toBe(true);
  });

  it('hands fightXp what payVictory does', () => {
    const def = mob('a', 30);
    const ctx = { party: { members: [{ level: 30 }, { level: 12 }], shareCount: 3, xpMultiplier: 1.1 }, table: { kind: 'floor', starterZone: true, floorXpFactor: 0.5 }, rewardMultiplier: 1.8 } as unknown as PayoutContext;
    const fight = { monsters: [{ def: monsterInfoOf(mod, 'a', def), killed: 1, standing: 1 }] } as unknown as FightView;
    const input = fightXpInput(fight, { index: 1, className: 'Knight', level: 12, role: 'member' }, ctx);
    expect(input).toMatchObject({ memberLevel: 12, topHumanLevel: 30, bodies: 3, starterZone: false, floorXpFactor: 0.5, xpBonus: 1.1, rewardMultiplier: 1.8 });
    expect(input.monsters).toHaveLength(2);
  });

  it('pays nothing on a defeat', () => {
    const ctx = { party: { members: [], shareCount: 1, xpMultiplier: 1 }, table: {}, rewardMultiplier: 1.8, rules: xpRulesOf(mod) } as unknown as PayoutContext;
    const fight = { won: false, monsters: [] } as unknown as FightView;
    expect(baseline.payout(fight, { index: 0, className: 'Knight', level: 1, role: 'member' }, ctx)).toBe(0);
  });
});

describe('fight runner', () => {
  it('matches the content lab engine fight for the same seed', async () => {
    const engine = await loadNewEngine();
    const content = seedContent();
    const zoneId = Object.keys(content.zones)[0];
    const table = (content.zones[zoneId].encounterTable ?? []).slice(0, 1);
    const level = 5;
    const players = humanSeats(['Knight', 'Priest'], false).map(spec => engine.buildHuman({ ...spec, level, equipment: {}, skillIds: chooseLoadout(content, spec.className, level) }, content));
    const xpTable = { zoneId, strata: [] } as unknown as XpTable;
    const monsterIndex = new Map(Object.keys(content.monsters).map((id, i) => [id, i]));
    const kit = { mod, content, monsterIndex };
    for (let i = 0; i < 20; i++) {
      const seed = hashSeed(`runner|${i}`);
      const theirs = engine.fight({ players, table, zoneId, content, xpMultiplier: 1, humanCount: 2, hireCount: 0, memberLevel: level, rng: makeRng(seed) });
      const ours = runFight(kit, players, xpTable, table[0]?.encounterId ?? null, makeRng(seed));
      expect(ours.realMs).toBe(theirs.ms);
      expect(ours.result === 0).toBe(theirs.result === 'victory');
      expect(ours.groups.length).toBeGreaterThan(0);
    }
  });
});

describe('long fights', () => {
  const table = { zoneId: 'z', strata: [] } as unknown as XpTable;
  const capMs = 4 * 3_600_000;
  const stubEngine = (endAtEngineMs: number | null, horizonEngineMs: number): any => ({
    ...mod,
    createEncounter: () => [],
    defaultHorizonMs: () => horizonEngineMs,
    createPartyCombatState: () => ({ elapsedMs: 0, finished: false, result: null, players: [{ currentHp: 1 }], monsters: [], minPartyHpFrac: 1 }),
    processCombatStep(state: any, step: number) {
      state.elapsedMs += step;
      if (endAtEngineMs !== null && state.elapsedMs >= endAtEngineMs) {
        state.finished = true;
        state.result = 'victory';
      }
      return { events: [] };
    },
  });
  const run = (engine: any): ReturnType<typeof runFight> => runFight({ mod: engine, content: { monsters: {}, zones: {}, encounters: {} } as unknown as XpSnapshot, monsterIndex: new Map() }, [], table, null, makeRng(1));

  it('flags nothing for a fight that ends by the horizon, even on it', () => {
    expect(run(stubEngine(60_000, 120_000)).pastHorizon).toBe(false);
    expect(run(stubEngine(120_000, 120_000)).pastHorizon).toBe(false);
  });

  it('fights on past the horizon, as the game does, and flags it', () => {
    const outcome = run(stubEngine(180_000, 120_000));
    expect(outcome.result).toBe(RESULT_VICTORY);
    expect(outcome.pastHorizon).toBe(true);
    expect(outcome.realMs).toBe(mod.paceRealMs(mod.COMBAT_PACE, 180_000));
  });

  it('gives up at the cap', () => {
    const outcome = run(stubEngine(null, 120_000));
    expect(outcome.result).toBe(RESULT_TIMEOUT);
    expect(outcome.pastHorizon).toBe(true);
    expect(Math.abs(outcome.realMs - capMs)).toBeLessThanOrEqual(mod.paceRealMs(mod.COMBAT_PACE, mod.COMBAT_STEP_MS));
  });

  it('wins a real engine fight that outlasts the forecast horizon', () => {
    const fighter = { username: 'hero', maxHp: 100000, baseDamage: 1, playerDamageType: 'physical', gridPosition: 5, className: 'Knight', level: 1, equippedSkills: [] };
    const against = (hp: number): ReturnType<typeof runFight> => {
      const slab = { id: 'slab', name: 'Slab', maxHp: hp, currentHp: hp, damage: 0, damageType: 'physical', xp: 1, gridPosition: 4 };
      const engine = { ...mod, createEncounter: () => [slab] };
      return runFight({ mod: engine, content: { monsters: {}, zones: {}, encounters: {} } as unknown as XpSnapshot, monsterIndex: new Map([['slab', 0]]) }, [fighter as any], table, null, makeRng(2));
    };
    const horizonReal = mod.paceRealMs(mod.COMBAT_PACE, mod.FORECAST_HORIZON_WITHOUT_ENRAGE_MS);
    const short = against(100);
    expect(short.pastHorizon).toBe(false);
    const outcome = against(Math.ceil((100 * 1.5 * horizonReal) / short.realMs));
    expect(outcome.result).toBe(RESULT_VICTORY);
    expect(outcome.pastHorizon).toBe(true);
    expect(outcome.realMs).toBeGreaterThan(horizonReal);
    expect(outcome.realMs).toBeLessThan(capMs);
  });
});

describe('evaluator', () => {
  const comp = buildComps(['core']).find(c => c.id === 'A')!;
  const room = { index: 0, key: 'room|0', kind: 'room', label: 'R0', boss: false, strata: [{ encounterId: 'e', share: 1, boss: false }] } as unknown as XpTable;
  const meta = { monsters: ['m'], encounters: ['e'], comps: [comp], tables: [room], pauseMs: 1800, retreatMs: 6040, autoRetreatBelowPct: 25, rewardMultiplier: 1.8 } as unknown as AtlasMeta;
  const cells: XpCell[] = [{ id: 0, table: 0, comp: 0, level: 5, hires: [], xpMult: 1 }, { id: 1, table: 0, comp: 0, level: 6, hires: [], xpMult: 1 }];
  const env = (plan: XpPlan, state?: unknown): EvaluatorEnv => ({ meta, cells, content: { monsters: { m: { id: 'm', xp: 10, hp: 5, level: 5 } } } as unknown as XpSnapshot, plan, state, mod });
  const pays = (xp: number): XpPlan => ({ id: 'p', describe: '', payout: f => (f.won ? xp : 0) });

  function writeRows(rows: { cell: number; result: number; realMs: number; pastHorizon: boolean }[]): { path: string; done: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'xp-eval-'));
    const path = join(dir, 'rows.bin');
    const writer = new RowWriter(path);
    for (const r of rows) writer.write({ ...r, encounter: 0, deaths: 0, damage: 1, minHp: 1, groups: [0, 1, 0] });
    writer.close();
    return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  function rates(plan: XpPlan, rows: Parameters<typeof writeRows>[0], state?: unknown, maxRows?: number): CellRate[] {
    const { path, done } = writeRows(rows);
    const out: CellRate[] = [];
    try {
      createEvaluator(env(plan, state))(path, rate => out.push(rate), maxRows);
    } finally {
      done();
    }
    return out;
  }

  const win = (cell = 0): { cell: number; result: number; realMs: number; pastHorizon: boolean } => ({ cell, result: RESULT_VICTORY, realMs: 10000, pastHorizon: false });

  it.each([
    ['NaN', NaN],
    ['a negative', -1],
    ['Infinity', Infinity],
    ['a string', '5' as unknown as number],
    ['nothing', undefined as unknown as number],
  ])('stops on %s payout', (_name, xp) => {
    expect(() => rates(pays(xp), [win()])).toThrow(/finite number/);
  });

  it('pays a long win, and the forecast still scores it as not won', () => {
    const [rate] = rates(pays(100), Array.from({ length: 4 }, () => ({ cell: 0, result: RESULT_VICTORY, realMs: 3_600_000, pastHorizon: true })));
    expect(rate.win).toBe(100);
    expect(rate.fwin).toBe(0);
    expect(rate.hz).toBe(100);
    expect(rate.skip).toBe(1);
    expect(rate.reloc).toBe(1);
    expect(rate.raw[0]).toBeCloseTo((100 / (3_600_000 + 1800)) * 3_600_000, 1);
    expect(rate.xp).toEqual(rate.raw);
  });

  it('skips nothing for wins inside the horizon', () => {
    const [rate] = rates(pays(100), [win(), win(), win(), win()]);
    expect(rate.fwin).toBe(100);
    expect(rate.hz).toBe(0);
    expect(rate.skip).toBe(0);
  });

  it('hands payout what prepare returned', () => {
    const plan: XpPlan = { id: 'p', describe: '', payout: (_f, _m, c) => (c.state as { xp: number }).xp };
    expect(rates(plan, [win()], { xp: 7 })[0].xpf).toEqual([7]);
  });

  it('leaves out the cell a row limit stops inside', () => {
    const rows = [win(0), win(0), win(1), win(1)];
    expect(rates(pays(1), rows, undefined, 3).map(r => r.c)).toEqual([0]);
    expect(rates(pays(1), rows, undefined, 4).map(r => r.c)).toEqual([0, 1]);
  });

  it('refuses a plan that pays nothing anywhere', () => {
    expect(() => assertPlanPays('p', rates(pays(0), [win()]))).toThrow(/paid nothing/);
    expect(() => assertPlanPays('p', rates(pays(1), [win()]))).not.toThrow();
  });

  it('refuses a plan whose payout reads state the workers never get', () => {
    const fromRetune = new Map<string, number>();
    const stateful: XpPlan = { id: 'p', describe: '', payout: () => fromRetune.get('xp') ?? 3 };
    const rows = [win(0), win(0)];
    const onWorker = rates(stateful, rows);
    fromRetune.set('xp', 9);
    const onMain = rates(stateful, rows);
    const byCell = (list: CellRate[]): Map<number, CellRate> => new Map(list.map(r => [r.c, r]));
    expect(() => assertPayoutsAgree(stateful, byCell(onMain), byCell(onWorker))).toThrow(/ctx.state/);
    expect(() => assertPayoutsAgree(stateful, byCell(onMain), byCell(onMain))).not.toThrow();
  });
});

describe('game pacing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const party = (): any => ({ hasDestination: false, enterBattle: () => {}, exitBattle: () => {}, moveToNextTile: () => false });
  const fighter = (damage: number, hp: number): any => ({
    username: 'hero', maxHp: hp, baseDamage: damage, playerDamageType: 'physical', gridPosition: 5, className: 'Knight', level: 1, equippedSkills: [],
  });
  const monster = (hp: number, damage: number): any => ({ id: 'dummy', name: 'Dummy', maxHp: hp, currentHp: hp, damage, damageType: 'physical', xp: 1, gridPosition: 4 });

  function cycle(players: any[], monsters: any[], result: 'victory' | 'defeat'): number {
    const combats: any[] = [];
    const starts: number[] = [];
    const ends: { at: number; result: string }[] = [];
    const timer = new ServerBattleTimer(party(), () => {
      const state = mod.createPartyCombatState(players, monsters, { pace: mod.COMBAT_PACE });
      combats.push(state);
      return state;
    }, {
      onBattleStart: () => starts.push(Date.now()),
      onBattleEnd: (r: string) => ends.push({ at: Date.now(), result: r }),
    } as any);
    timer.start();
    vi.advanceTimersByTime(3 * 60 * 1000);
    timer.destroy();
    expect(ends[0].result).toBe(result);
    expect(starts.length).toBeGreaterThan(1);
    const fightMs = mod.paceRealMs(mod.COMBAT_PACE, combats[0].elapsedMs);
    expect(ends[0].at - starts[0]).toBe(fightMs + mod.KILL_BEAT_MS);
    return starts[1] - starts[0] - fightMs;
  }

  it('waits the same after a victory and a defeat', () => {
    const pause = mod.KILL_BEAT_MS + mod.RESULT_PAUSE + mod.MOVE_DURATION;
    expect(cycle([fighter(100000, 100000)], [monster(5, 0)], 'victory')).toBe(pause);
    expect(cycle([fighter(0, 1)], [monster(1000000, 1000)], 'defeat')).toBe(pause);
  });

  it('skips the kill beat on a retreat', () => {
    const starts: number[] = [];
    const timer = new ServerBattleTimer(party(), () => mod.createPartyCombatState([fighter(1, 1000000)], [monster(1000000, 1)], { pace: mod.COMBAT_PACE }), { onBattleStart: () => starts.push(Date.now()) } as any);
    timer.start();
    timer.scheduleRetreat(timer.battleId, mod.RUN_AVAILABLE_MS, 'away');
    vi.advanceTimersByTime(mod.RUN_AVAILABLE_MS + 5000);
    timer.destroy();
    const realStep = mod.paceRealMs(mod.COMBAT_PACE, mod.COMBAT_STEP_MS);
    expect(starts[1] - starts[0]).toBeLessThanOrEqual(mod.RUN_AVAILABLE_MS + realStep + mod.RESULT_PAUSE + mod.MOVE_DURATION);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(mod.RUN_AVAILABLE_MS + mod.RESULT_PAUSE + mod.MOVE_DURATION);
  });
});

function worldFixture(): XpSnapshot {
  const monsters: Record<string, any> = {
    low: { id: 'low', xp: 5, hp: 10, damage: 1, level: 4 },
    high: { id: 'high', xp: 50, hp: 10, damage: 1, level: 20 },
    wall: { id: 'wall', xp: 0, hp: 10, damage: 0, passive: true },
    boss: { id: 'boss', xp: 500, hp: 10, damage: 1, level: 20, tier: 'boss' },
    nothing: { id: 'nothing', xp: 0, hp: 1, damage: 0, level: 4 },
  };
  const encounter = (id: string, monsterId: string, count = 1): any => ({ id, type: 'explicit', placements: Array.from({ length: count }, (_, i) => ({ monsterId, gridPosition: i })) });
  return {
    monsters,
    items: {},
    zones: {
      a: { id: 'a', displayName: 'A', levelRange: [1, 5], encounterTable: [{ encounterId: 'e_low', weight: 3 }, { encounterId: 'e_nothing', weight: 1 }] },
      b: { id: 'b', displayName: 'B', levelRange: [18, 22], encounterTable: [{ encounterId: 'e_high', weight: 1 }] },
    },
    encounters: { e_low: encounter('e_low', 'low', 2), e_high: encounter('e_high', 'high'), e_boss: encounter('e_boss', 'boss'), e_nothing: encounter('e_nothing', 'nothing'), e_wall: encounter('e_wall', 'wall') },
    sets: {},
    shops: {},
    henchmen: {},
    dungeons: {
      d: { id: 'd', name: 'D', floors: [{ floorNumber: 1, encounterTable: [{ encounterId: 'e_high', weight: 1 }] }, { floorNumber: 2, xpFactor: 0.5, coinFactor: 0.25, encounterTable: [{ encounterId: 'e_boss', weight: 1 }] }], entryRequirements: { minLevel: 18 } },
    },
    skills: {},
    skillSlotSchedules: {},
    tileTypes: { land: { id: 'land', traversable: true }, sea: { id: 'sea', traversable: false } },
    quests: {
      q1: { id: 'q1', name: 'Q1', rewards: [{ kind: 'xp', amount: 100 }], requiredLevel: 2 },
      q2: { id: 'q2', name: 'Q2', rewards: [{ kind: 'xp', amount: 200 }], requiredLevel: 3, prerequisiteQuestIds: ['q1'] },
      q3: { id: 'q3', name: 'Q3', rewards: [{ kind: 'xp', amount: 900 }], requiredLevel: 1, prerequisiteQuestIds: ['q2'] },
      weekly: { id: 'weekly', name: 'W', rewards: [{ kind: 'xp', amount: 40 }], repeat: 'weekly' },
      goldOnly: { id: 'goldOnly', name: 'G', rewards: [{ kind: 'gold', amount: 40 }] },
    },
    npcs: { n1: { id: 'n1', questIds: ['q1', 'q2', 'weekly', 'goldOnly'] }, n2: { id: 'n2', questIds: ['q3'] } },
    world: {
      defaultMapId: 'm1',
      maps: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }],
      tiles: [
        { id: 't1', mapId: 'm1', zone: 'a', type: 'land', npcId: 'n1' },
        { id: 't2', mapId: 'm1', zone: 'a', type: 'land' },
        { id: 't3', mapId: 'm1', zone: 'a', type: 'land', name: 'Wall room', encounterTable: [{ encounterId: 'e_wall', weight: 1 }] },
        { id: 't4', mapId: 'm1', zone: 'a', type: 'sea' },
        { id: 't5', mapId: 'm2', zone: 'b', type: 'land', npcId: 'n2', dungeonId: 'd' },
        { id: 't6', mapId: 'm2', zone: 'b', type: 'land', encounterTable: [{ encounterId: 'e_boss', weight: 1 }] },
      ],
    },
  } as unknown as XpSnapshot;
}

describe('tables', () => {
  const content = worldFixture();
  (content.zones.b as { starterZone?: boolean }).starterZone = true;
  const { regions, zoneRegion } = buildRegions(content);
  const { tables } = buildTables(content, mod, zoneRegion, regions);
  const byKey = (fragment: string): XpTable => tables.find(t => t.key.includes(fragment))!;

  it('groups rooms by distinct table and skips untraversable ones', () => {
    const zoneTable = byKey('room|a|e_low');
    expect(zoneTable.tileCount).toBe(2);
    expect(zoneTable.npcTiles).toBe(1);
    expect(zoneTable.override).toBe(false);
    expect(tables.filter(t => t.kind === 'room').reduce((s, t) => s + t.tileCount, 0)).toBe(5);
  });

  it('takes the room level from the authored monsters, else the zone midpoint', () => {
    expect(byKey('room|a|e_low').roomLevel).toBe(4);
    const wall = byKey('room|a|e_wall');
    expect(wall.roomLevel).toBe(3);
    expect(wall.roomLevelSource).toBe('zone');
    expect(wall.zeroXp).toBe(true);
    expect(wall.override).toBe(true);
  });

  it('flags boss rooms and dungeon floors', () => {
    const bossRoom = byKey('room|b|e_boss');
    expect(bossRoom.boss).toBe(true);
    expect(bossRoom.bossShare).toBe(1);
    const floor = byKey('floor|d|1');
    expect(floor.kind).toBe('floor');
    expect(floor.floorXpFactor).toBe(0.5);
    expect(floor.floorCoinFactor).toBe(0.25);
    expect(floor.regionIndex).toBe(1);
    expect(byKey('floor|d|0').floorXpFactor).toBeUndefined();
  });

  it('marks starter-zone rooms, and never a floor whose entrance stands in one', () => {
    expect(byKey('room|b|e_high').starterZone).toBe(true);
    expect(byKey('room|a|e_low').starterZone).toBe(false);
    expect(byKey('floor|d|0').starterZone).toBe(false);
  });

  it('keeps the stratified fight count of runCell', () => {
    expect(fightsPerStratum(1, 24)).toBe(24);
    expect(fightsPerStratum(0.75, 24)).toBe(18);
    expect(fightsPerStratum(0.05, 24)).toBe(3);
  });
});

describe('quests', () => {
  const content = worldFixture();
  const { regions } = buildRegions(content);
  const ledger = buildQuestLedger(content, regions);

  it('splits one-off and repeatable XP and drops quests without XP', () => {
    expect(ledger.once.map(q => q.id).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(ledger.repeatable.map(q => q.id)).toEqual(['weekly']);
    expect(ledger.noXp).toBe(1);
  });

  it('dates a quest by its level, its prerequisites and its region', () => {
    const at = (id: string): number => ledger.once.find(q => q.id === id)!.availableAt;
    expect(at('q1')).toBe(2);
    expect(at('q2')).toBe(3);
    expect(at('q3')).toBe(18);
    expect(ledger.once.find(q => q.id === 'q3')!.regionIndex).toBe(1);
  });

  it('gives a sitter only quests whose chain stays in their region', () => {
    expect(questsWithinRegion(ledger, 0).map(q => q.id).sort()).toEqual(['q1', 'q2']);
    expect(questsWithinRegion(ledger, 1).map(q => q.id)).toEqual([]);
  });

  it('takes the lowest region for a quest several NPCs list, and a sitter needs every region it names', () => {
    const shared = worldFixture();
    shared.npcs!.n2.questIds = ['q3', 'q1'];
    const { regions: sharedRegions } = buildRegions(shared);
    const twoGivers = buildQuestLedger(shared, sharedRegions);
    expect(twoGivers.once.find(q => q.id === 'q1')!.regionIndex).toBe(0);
    expect(twoGivers.once.find(q => q.id === 'q1')!.needsRegions).toEqual([0, 1]);
    expect(questsWithinRegion(twoGivers, 0).map(q => q.id)).toEqual([]);
  });
});

describe('gear by level', () => {
  it('takes the last region at or below the level, else the first', () => {
    const midpoints = [3, 8, 13];
    expect(gearRegionIndex(1, midpoints)).toBe(0);
    expect(gearRegionIndex(3, midpoints)).toBe(0);
    expect(gearRegionIndex(7, midpoints)).toBe(0);
    expect(gearRegionIndex(8, midpoints)).toBe(1);
    expect(gearRegionIndex(60, midpoints)).toBe(2);
  });
});

describe('statistics', () => {
  it('computes quantiles and rank correlation', () => {
    expect(median([1, 2, 3, 100])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
  });
});

function partyFixture(): XpSnapshot {
  const hire = (id: string, className: string, level: number): any => ({ id, name: id, className, level, maxHp: 50, baseDamage: 5, skillIds: [], description: '', emoji: '' });
  return {
    ...worldFixture(),
    skills: { ...mod.SEED_SKILLS, test_bonus: { id: 'test_bonus', name: 'Bonus', className: 'Bard', type: 'passive', unlockLevel: 30, passiveEffects: [{ kind: 'xp_bonus', flatValue: 0.2 }] } },
    skillSlotSchedules: mod.SEED_SKILL_SLOT_SCHEDULES,
    shops: { s: { id: 's', name: 'S', inventory: [], henchmanIds: ['hk', 'hp', 'hm', 'ha'] } },
    henchmen: { hk: hire('hk', 'Knight', 6), hp: hire('hp', 'Priest', 4), hm: hire('hm', 'Mage', 8), ha: hire('ha', 'Archer', 2) },
    world: { ...worldFixture().world, tiles: worldFixture().world.tiles.map(t => (t.id === 't1' ? { ...t, shopId: 's' } : t)) },
  } as unknown as XpSnapshot;
}

describe('party variants', () => {
  const comps = buildComps(ALL_FAMILIES);
  const compOf = (id: string): any => comps.find(c => c.id === id)!;

  const builder = async (): Promise<{ build: (id: string, level: number) => any }> => {
    const content = partyFixture();
    const engine = await loadNewEngine();
    const { regions } = buildRegions(content);
    const parties = new PartyBuilder(content, regions, engine);
    return { build: (id, level) => parties.build(compOf(id), level, regions[0]) };
  };

  it('seats a hired Knight in front when placed and in the first free seat by default', async () => {
    const { build } = await builder();
    const seat = (id: string, className: string): number => build(id, 5).players.find((p: any) => p.className === className).gridPosition;
    expect(seat(ARCHER_HIRED_KNIGHT, 'Knight')).toBe(5);
    expect(seat(`${DEFAULT_SEAT_PREFIX}${ARCHER_HIRED_KNIGHT}`, 'Archer')).toBe(4);
    expect(seat(`${DEFAULT_SEAT_PREFIX}${ARCHER_HIRED_KNIGHT}`, 'Knight')).toBe(0);
    expect(seat(`${DEFAULT_SEAT_PREFIX}A`, 'Archer')).toBe(4);
    expect(seat('A', 'Archer')).toBe(5);
  });

  it('stacks xp_bonus per Bard and refuses a party that has none unlocked', async () => {
    const { build } = await builder();
    expect(build(`${XP_BONUS_PREFIX}Bx5`, 30).xpMult).toBeCloseTo(2);
    expect(build(`${XP_BONUS_PREFIX}K+A+P+M+B`, 30).xpMult).toBeCloseTo(1.2);
    expect(build(`${XP_BONUS_PREFIX}Bx5`, 10).unavailable).toBeDefined();
    expect(build('Bx5', 30).xpMult).toBe(1);
  });

  it('fills a party with the strongest hires, tank and healer first', async () => {
    const { build } = await builder();
    const solo = build(`A+h${SOLO_FILL_HIRES}`, 3);
    expect(solo.hires).toEqual(['hk', 'hp', 'hm', 'ha']);
    expect(new Set(solo.players.map((p: any) => p.gridPosition)).size).toBe(5);
    expect(build(`K+P+h${DUO_FILL_HIRES}`, 3).hires).toEqual(['hm', 'hk', 'hp']);
    expect(strongestHires([{ id: 'a', className: 'Mage', level: 9 }, { id: 'b', className: 'Knight', level: 1 }], 1, ['Archer']).map(h => h.id)).toEqual(['b']);
  });

  it('takes no hire over the level limit, as the server\'s roster leaves one out', async () => {
    const { build } = await builder();
    expect(build(`A+h${SOLO_FILL_HIRES}`, 1).hires).toEqual(['hk', 'hp', 'ha']);
    expect(build(`K+P+h${DUO_FILL_HIRES}`, 1).hires).toEqual(['hk', 'hp', 'ha']);
    const content = partyFixture();
    const engine = await loadNewEngine();
    const { regions } = buildRegions(content);
    const roster = (humanLevel: number, hireLevel: number): number => {
      const manager = Object.create(PartyBattleManager.prototype);
      manager.entries = new Map([['p', { members: new Set(['u']) }]]);
      manager.getSession = () => ({ hasCharacter: () => true, getCombatInfo: (gridPosition: number) => ({ username: 'u', level: humanLevel, className: 'Archer', isHenchman: false, gridPosition, equippedSkills: [] }) });
      manager.getGridPosition = () => 4;
      manager.getPartyHenchmen = () => [{ instanceId: 'i', henchmanId: 'hk', gridPosition: 5 }];
      manager.content = { getHenchman: () => ({ ...content.henchmen.hk, level: hireLevel }), getAllSkills: () => ({}), getSkill: () => undefined };
      return manager.buildPartyCombatants('p').filter((p: any) => p.isHenchman).length;
    };
    for (const [humanLevel, hireLevel] of [[5, 6], [5, 10], [5, 11], [1, 7], [20, 3]]) {
      const limited = { ...content, henchmen: { ...content.henchmen, hk: { ...content.henchmen.hk, level: hireLevel } } } as XpSnapshot;
      const party = new PartyBuilder(limited, regions, engine).build(compOf(ARCHER_HIRED_KNIGHT), humanLevel, regions[0]);
      expect(party.hires.length).toBe(roster(humanLevel, hireLevel));
      expect(!!party.unavailable).toBe(roster(humanLevel, hireLevel) === 0);
    }
  });

  it('gives extended the same band as core', () => {
    expect(compOf('K+M').band).toEqual(CORE_BAND);
    expect(compOf('Bx5').band).toEqual(CORE_BAND);
    expect(compOf('Px3').band).toEqual(CORE_BAND);
  });
});

function gatedWorld(): XpSnapshot {
  const monsters: Record<string, any> = {
    low: { id: 'low', xp: 5, hp: 10, damage: 1, level: 2 },
    high: { id: 'high', xp: 50, hp: 10, damage: 1, level: 20 },
    none: { id: 'none', xp: 0, hp: 1, damage: 0, level: 2 },
  };
  const encounter = (id: string, monsterId: string): any => ({ id, type: 'explicit', placements: [{ monsterId, gridPosition: 0 }] });
  const tile = (id: string, col: number, zone: string, extra: Record<string, unknown> = {}): any => ({ id, mapId: 'm1', col, row: 0, zone, type: 'land', ...extra });
  return {
    monsters,
    items: {},
    zones: {
      town: { id: 'town', displayName: 'Town', levelRange: [1, 3], encounterTable: [{ encounterId: 'e_none', weight: 1 }] },
      a: { id: 'a', displayName: 'A', levelRange: [1, 5], encounterTable: [{ encounterId: 'e_low', weight: 1 }] },
      b: { id: 'b', displayName: 'B', levelRange: [18, 22], encounterTable: [{ encounterId: 'e_high', weight: 1 }] },
      c: { id: 'c', displayName: 'C', levelRange: [30, 32], encounterTable: [{ encounterId: 'e_high', weight: 1 }] },
    },
    encounters: { e_low: encounter('e_low', 'low'), e_high: encounter('e_high', 'high'), e_none: encounter('e_none', 'none') },
    sets: {},
    shops: {},
    henchmen: {},
    dungeons: {},
    skills: {},
    skillSlotSchedules: {},
    tileTypes: { land: { id: 'land', traversable: true }, sea: { id: 'sea', traversable: false } },
    quests: { gate: { id: 'gate', name: 'Gate', requiredLevel: 8, rewards: [] } },
    npcs: { keeper: { id: 'keeper', questIds: ['gate'] } },
    world: {
      defaultMapId: 'm1',
      startTile: { col: 0, row: 0 },
      maps: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }],
      tiles: [
        tile('start', 0, 'town', { npcId: 'keeper', transitions: [{ mapId: 'm2', tileId: 'far', entryRequirements: { requiredQuestIds: ['gate'] } }] }),
        tile('open', 1, 'a'),
        tile('walled', 2, 'b', { entryRequirements: { minLevel: 5 } }),
        { ...tile('far', 0, 'c'), mapId: 'm2' },
        { ...tile('island', 9, 'c'), mapId: 'm2', encounterTable: [{ encounterId: 'e_low', weight: 1 }] },
      ],
    },
  } as unknown as XpSnapshot;
}

describe('room gates', () => {
  const content = gatedWorld();

  it('finds the lowest member level per room, through room gates and quest gates', () => {
    const reach = computeReach(content, mod, 60)!;
    expect(reach.tileLevel.get('start')).toBe(1);
    expect(reach.tileLevel.get('open')).toBe(1);
    expect(reach.tileLevel.get('walled')).toBe(5);
    expect(reach.tileLevel.get('far')).toBe(8);
    expect(reach.tileLevel.has('island')).toBe(false);
  });

  it('gates tables by their easiest room and counts paying rooms beside a zero-XP room', () => {
    const { regions, zoneRegion } = buildRegions(content);
    const built = buildTables(content, mod, zoneRegion, regions);
    annotateTables(built.tables, built.tileKeys, content, mod, 60);
    const byZone = (zone: string, entry: string): XpTable => built.tables.find(t => t.zoneId === zone && t.strata.some(s => s.encounterId === entry))!;
    expect(byZone('a', 'e_low').reachLevel).toBe(1);
    expect(byZone('a', 'e_low').zeroNeighbourTiles).toBe(1);
    expect(byZone('b', 'e_high').reachLevel).toBe(5);
    expect(byZone('b', 'e_high').zeroNeighbourTiles).toBe(0);
    expect(byZone('c', 'e_high').reachLevel).toBe(8);
    expect(byZone('c', 'e_low').reachLevel).toBeNull();
    expect(memberReaches(byZone('b', 'e_high'), 4)).toBe(false);
    expect(memberReaches(byZone('b', 'e_high'), 5)).toBe(true);
    expect(memberReaches(byZone('c', 'e_low'), 60)).toBe(false);
  });

  it('leaves tables ungated without a start tile', () => {
    expect(computeReach(worldFixture(), mod, 60)).toBeNull();
  });
});

describe('the literal case', () => {
  const noSplit: XpPlan = { id: 'x', describe: '', payout: (f, m, c) => (f.won ? memberXp(f.monsters, m.level, c) * c.rewardMultiplier : 0) };
  const bonusPlan = (b: number): XpPlan => ({ id: 'x', describe: '', payout: (f, m, c) => (noSplit.payout(f, m, c) * (1 + b * (c.party.shareCount - 1))) / c.party.shareCount });
  const worst = (plan: XpPlan): number => Math.min(...literalCases(plan, mod, 1800, 1.8).map(x => x.ratio));

  it('pays baseline a little more than solo, by the party share, and no split more', () => {
    expect(worst(baseline)).toBeCloseTo((2 * mod.PARTY_XP_SHARE[2] * 6.8) / 11.8, 1);
    expect(worst(baseline)).toBeGreaterThan(1);
    expect(worst(noSplit)).toBeCloseTo((2 * 6.8) / 11.8, 2);
  });

  it('needs a per-extra bonus over 0.735 to pass', () => {
    expect(worst(bonusPlan(0.73))).toBeLessThan(1);
    expect(worst(bonusPlan(0.74))).toBeGreaterThan(1);
  });

  it('reports the kill-speed multiple of a share curve', () => {
    const curve = shareCurve(bonusPlan(0.2), mod, 1.8);
    expect(curve[0].humanShare).toBeCloseTo(0.6, 3);
    expect(curve[3].hireShare).toBeCloseTo(1.8 / 5, 3);
  });
});

describe('what the literal case takes', () => {
  const flat = (share: (bodies: number) => number): XpPlan => ({
    id: 'x',
    describe: '',
    payout: (f, _m, c) => (f.won ? f.monsters.reduce((s, g) => s + g.def.xp * (g.killed + g.standing), 0) * share(c.party.shareCount) : 0),
  });

  it('puts the flat share at the pause alone', () => {
    const need = literalFeasibility(1800);
    expect(need.share).toBeCloseTo(11800 / 6800 / 2, 6);
    expect(need.bonus).toBeCloseTo(0.735, 3);
    expect(need.beta).toBeCloseTo(0.205, 3);
    expect(literalFeasibility(0).share).toBe(1);
  });

  it('agrees with the plan run on the fights, on both sides of the line', () => {
    const { share } = literalFeasibility(1800);
    const worst = (s: number): number => Math.min(...literalCases(flat(n => (n === 1 ? 1 : s)), mod, 1800, 1.8).map(c => c.ratio));
    expect(worst(share - 0.001)).toBeLessThan(1);
    expect(worst(share + 0.001)).toBeGreaterThan(1);
  });

  it('passes a split near the sketch only with pay for the bigger pack', () => {
    const packPay: XpPlan = {
      id: 'x',
      describe: '',
      payout: (f, _m, c) => {
        const mobs = f.monsters.reduce((s, g) => s + g.killed + g.standing, 0);
        return f.won ? 100 * mobs ** 1.5 * (c.party.shareCount === 1 ? 1 : 0.625) : 0;
      },
    };
    expect(Math.min(...literalCases(packPay, mod, 1800, 1.8).map(c => c.ratio))).toBeGreaterThan(1);
    const flatSketch = flat(n => (n === 1 ? 1 : 0.625));
    expect(Math.min(...literalCases(flatSketch, mod, 1800, 1.8).map(c => c.ratio))).toBeLessThan(1);
  });

  it('stops on a payout that breaks on a table it has not seen', () => {
    const plan: XpPlan = { id: 'x', describe: '', payout: () => NaN };
    expect(() => literalCases(plan, mod, 1800, 1.8)).toThrow(/synthetic/);
  });
});

describe('boss policy', () => {
  const split = { share: 1, ms: 10000, win: 1, xpf: [100], restMs: 0, restXpf: [0] };
  const fightsPerDay = (24 * 3_600_000) / 11800;

  it('changes nothing when every kill is paid', () => {
    expect(bossHoursXp(split, 0, { bounty: () => 1 }, 1800, 24, 500)).toBeCloseTo(fightsPerDay * 100, 3);
  });

  it('pays the idle rate during a respawn, on top of the kills', () => {
    const xp = bossHoursXp(split, 0, { respawnMs: 6 * 3_600_000 }, 1800, 24, 500);
    expect(xp).toBeCloseTo(4 * 100 + (24 - (4 * 11.8) / 3600) * 500, 3);
  });

  it('keeps fighting the rest of the table when only part of it is a boss', () => {
    const mixed = { share: 0.25, ms: 10000, win: 1, xpf: [100], restMs: 4000, restXpf: [10] };
    const unlimited = ((24 * 3_600_000) / (0.25 * 11800 + 0.75 * 5800));
    expect(bossHoursXp(mixed, 0, { bounty: () => 1 }, 1800, 24, 99999)).toBeCloseTo(unlimited * (0.25 * 100 + 0.75 * 10), 3);
    expect(bossHoursXp(mixed, 0, { bounty: i => (i === 0 ? 1 : 0) }, 1800, 24, 99999)).toBeLessThan(unlimited * 0.75 * 10 + 200);
  });

  it('models a dungeon cap as one paid clear and idle for the rest', () => {
    expect(loopHoursXp({ runMs: 3_600_000, clearPct: 100, xpPerRun: 1000 }, undefined, 2, 100)).toBeCloseTo(2000);
    expect(loopHoursXp({ runMs: 3_600_000, clearPct: 100, xpPerRun: 1000 }, 1, 2, 100)).toBeCloseTo(1100);
    expect(loopHoursXp({ runMs: 3_600_000, clearPct: 100, xpPerRun: 1000 }, 1, 24, 100)).toBeCloseTo(1000 + 23 * 100);
  });
});

describe('stall variants', () => {
  const normal = { xp: 100, ms: 20000, kph: 100, win: 100 };

  it('counts longer fights, lost wins and fewer kills, and not a faster party or noise', () => {
    expect(classifyVariant({ xp: 104, ms: 40000, kph: 50, win: 100 }, normal)).toBe('not above');
    expect(classifyVariant({ xp: 120, ms: 40000, kph: 50, win: 100 }, normal)).toBe('stalling');
    expect(classifyVariant({ xp: 120, ms: 8000, kph: 90, win: 60 }, normal)).toBe('lose fast');
    expect(classifyVariant({ xp: 120, ms: 15000, kph: 90, win: 100 }, normal)).toBe('fewer kills');
    expect(classifyVariant({ xp: 120, ms: 15000, kph: 130, win: 100 }, normal)).toBe('faster party');
  });
});

interface MiniCell {
  table: number;
  comp: string;
  level: number;
  win: number;
  xp: number[];
  hires?: string[];
  /** Figures from a fresh sample of this many fights. */
  fresh?: number;
  ms?: number;
  xpf?: number[];
  st?: CellRate['st'];
  xpMult?: number;
  kph?: number;
  g?: CellGold;
  /** A cell the door refuses: it has no rate. */
  ineligible?: string;
  skip?: number;
}

interface MiniOptions {
  henchmen?: Record<string, any>;
  grid?: number[];
  /** Room level and region per table. */
  rooms?: [number, number][];
  plan?: XpPlan;
  /** Whole tables after the rooms, such as dungeon floors. */
  extraTables?: Partial<XpTable>[];
  content?: Record<string, unknown>;
  ledger?: Partial<ReturnType<typeof buildQuestLedger>>;
  encounters?: string[];
}

function miniRate(c: MiniCell, id: number): CellRate {
  return {
    c: id, n: c.fresh ?? 24, win: c.win, loss: 100 - c.win, stale: 0, to: 0, hz: 0, fwin: c.win, ms: c.ms ?? 5000, winMs: c.ms ?? 5000, hp: 1, deaths: 0, kills: 1, dmg: 1, kph: c.kph ?? 100, skip: c.skip ?? 0, reloc: 0, xp: c.xp, raw: c.xp, xpf: c.xpf ?? c.xp, st: c.st ?? [],
    ...(c.fresh ? { first: { n: 24, win: c.win, ms: c.ms ?? 5000, kph: c.kph ?? 100, xp: c.xp } } : {}),
    ...(c.g ? { g: c.g } : {}),
  };
}

function miniData(cellsIn: MiniCell[], options: MiniOptions = {}): Data {
  const compIds = [...new Set(cellsIn.map(c => c.comp))];
  const all = buildComps(ALL_FAMILIES);
  const comps = compIds.map(id => all.find(c => c.id === id)!);
  const room = (index: number, roomLevel: number, regionIndex: number): XpTable => ({ index, key: `room|${index}`, kind: 'room', label: `R${index}`, zoneId: 'z', zoneName: 'Z', regionId: 'r', regionName: 'R', regionIndex, zoneLevelRange: [1, 60], roomLevel, roomLevelSource: 'authored', entries: [], strata: [], tileCount: 1, npcTiles: 0, shopTiles: 0, dungeonTiles: 0, tileTypes: {}, zeroXp: false, starterZone: false, boss: false, bossShare: 0, override: false, fallback: false });
  const rooms = options.rooms ?? [[5, 0], [9, 0]];
  const tables = rooms.map(([level, region], i) => room(i, level, region));
  for (const extra of options.extraTables ?? []) tables.push({ ...room(tables.length, extra.roomLevel ?? 5, extra.regionIndex ?? 0), ...extra, index: tables.length });
  const meta = { grid: options.grid ?? [5], tables, comps, encounters: options.encounters ?? [], pauseMs: 1800, rewardMultiplier: 1.8, longFightCapMs: 4 * 3_600_000, seed: 1, families: [] } as unknown as AtlasMeta;
  const cells: XpCell[] = cellsIn.map((c, id) => ({ id, table: c.table, comp: compIds.indexOf(c.comp), level: c.level, hires: c.hires ?? [], xpMult: c.xpMult ?? 1, ...(c.ineligible ? { ineligible: c.ineligible } : {}) }));
  const content = { henchmen: options.henchmen ?? {}, dungeons: {}, monsters: {}, skills: {}, items: {}, shops: {}, encounters: {}, recipes: {}, ...options.content } as unknown as XpSnapshot;
  return new Data(meta, cells, cellsIn.map(miniRate).filter(rate => !cellsIn[rate.c].ineligible), content, [], { once: [], repeatable: [], noXp: 0, danglingPrerequisites: [], cycles: [], ...options.ledger }, mod, options.plan, 2, 15000, null);
}

describe('best room against best room', () => {
  it('passes a party that earns less in the same room but more in a harder one', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'A', level: 5, win: 20, xp: [10] },
      { table: 0, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 100, xp: [60], hires: ['low'] },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 95, xp: [150], hires: ['low'] },
    ], { henchmen: { low: { level: 5 } } });
    const [pair] = bestRoomPairs(d).pairs;
    expect(pair.ratio).toBeCloseTo(1.5);
    expect(pair.reach).toBe(4);
    expect(pair.party!.table.index).toBe(1);
    expect(pair.solo.table.index).toBe(0);
  });

  it('fails a party whose best room still pays under solo\'s', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 95, xp: [90], hires: ['low'] },
    ], { henchmen: { low: { level: 5 } } });
    expect(bestRoomPairs(d).pairs[0].ratio).toBeCloseTo(0.9);
  });

  it('reports hire-carried cells apart from the verdict', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 95, xp: [300], hires: ['big'] },
    ], { henchmen: { big: { level: 16 } } });
    const { pairs, carried } = bestRoomPairs(d);
    expect(pairs).toEqual([]);
    expect(carried[0].ratio).toBeCloseTo(3);
  });

  it('counts a party that wins nothing as under', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'K+A', level: 5, win: 50, xp: [10, 10] },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [50] },
    ]);
    const pairs = bestRoomPairs(d).pairs.filter(p => p.comp.id === 'K+A');
    expect(pairs.map(p => p.ratio)).toEqual([0, 0]);
  });
});

describe('noise in the verdicts', () => {
  const hires = { hires: ['low'] };
  const henchmen = { henchmen: { low: { level: 5 } } };

  it('reads a first sample as it stands and a fresh one as its interval', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 90, xp: [1] },
      { table: 1, comp: 'A', level: 5, win: 89, xp: [1] },
      { table: 0, comp: 'K', level: 5, win: 89, xp: [1], fresh: 400 },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [1], fresh: 400 },
      { table: 0, comp: 'P', level: 5, win: 90, xp: [1], fresh: 400 },
      { table: 1, comp: 'P', level: 5, win: 85, xp: [1], fresh: 400 },
    ]);
    const at = (table: number, comp: string): { clear: boolean; plausible: boolean } => {
      const r = d.get(table, comp, 5)!;
      return { clear: d.clearlyWon(r), plausible: d.plausiblyWon(r) };
    };
    expect(at(0, 'A')).toEqual({ clear: true, plausible: true });
    expect(at(1, 'A')).toEqual({ clear: false, plausible: false });
    expect(at(0, 'K')).toEqual({ clear: false, plausible: true });
    expect(at(1, 'K')).toEqual({ clear: true, plausible: true });
    expect(at(0, 'P')).toEqual({ clear: false, plausible: true });
    expect(at(1, 'P')).toEqual({ clear: false, plausible: false });
  });

  it('lets a party claim a room on the line, and not hold it against the party when solo sits there', () => {
    const onLine = 89;
    const party = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 0, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 100, xp: [60], fresh: 400, ...hires },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: onLine, xp: [150], fresh: 400, ...hires },
    ], henchmen);
    expect(bestRoomPairs(party).pairs[0].ratio).toBeCloseTo(1.5);
    const solo = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 1, comp: 'A', level: 5, win: onLine, xp: [400], fresh: 400 },
      { table: 0, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 100, xp: [120], fresh: 400, ...hires },
    ], henchmen);
    expect(bestRoomPairs(solo).pairs[0].ratio).toBeCloseTo(1.2);
  });

  it('asks for a fresh sample of the picks near the line, once', () => {
    const near = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K+A', level: 5, win: 100, xp: [10, 110] },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [50] },
    ]);
    const ids = verdictCells(near);
    expect(ids.has(near.get(0, 'A', 5)!.cell.id)).toBe(true);
    expect(ids.has(near.get(1, 'K+A', 5)!.cell.id)).toBe(true);
    near.absorb(new Map([[near.get(0, 'A', 5)!.cell.id, miniRate({ table: 0, comp: 'A', level: 5, win: 100, xp: [90], fresh: 400 }, near.get(0, 'A', 5)!.cell.id)]]));
    expect(verdictCells(near).has(near.get(0, 'A', 5)!.cell.id)).toBe(false);
  });

  it('leaves a pair far above its line alone', () => {
    const far = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 100, xp: [500], ...hires },
    ], henchmen);
    expect(verdictCells(far).has(far.get(0, 'A', 5)!.cell.id)).toBe(true);
    const k = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K+A', level: 5, win: 100, xp: [500, 500] },
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
    ]);
    expect(verdictCells(k).size).toBe(0);
  });

  it('also samples a room a low first read could be hiding, when the pair fails', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 0, comp: 'K+A', level: 5, win: 100, xp: [90, 90], fresh: 400 },
      { table: 1, comp: 'K+A', level: 5, win: 100, xp: [80, 80] },
    ], { rooms: [[5, 0], [9, 0], [12, 0]] });
    expect(verdictCells(d).has(d.get(1, 'K+A', 5)!.cell.id)).toBe(true);
    const clear = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 0, comp: 'K+A', level: 5, win: 100, xp: [90, 90], fresh: 400 },
      { table: 1, comp: 'K+A', level: 5, win: 100, xp: [60, 60] },
    ], { rooms: [[5, 0], [9, 0], [12, 0]] });
    expect(verdictCells(clear).has(clear.get(1, 'K+A', 5)!.cell.id)).toBe(false);
  });

  it('absorbs a fresh sample, keeps the first read and re-picks the room', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'A', level: 5, win: 100, xp: [120] },
    ]);
    expect(bestRoomPairs(d).pairs).toEqual([]);
    const id = d.get(1, 'A', 5)!.cell.id;
    d.absorb(new Map([[id, { ...miniRate({ table: 1, comp: 'A', level: 5, win: 80, xp: [90] }, id), n: 400 }]]));
    const row = d.get(1, 'A', 5)!;
    expect(row.xp).toBe(90);
    expect(row.rate.first).toEqual({ n: 24, win: 100, ms: 5000, kph: 100, xp: [120] });
    expect(d.plausiblyWon(row)).toBe(false);
    expect(d.rawRates().find(r => r.c === id)!.first!.win).toBe(100);
  });

  it('fails I1 only beyond the tolerance, and leaves the literal case to its own line', () => {
    const cellsAt = (party: number): MiniCell[] => [
      { table: 0, comp: 'A', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 1, comp: ARCHER_HIRED_KNIGHT, level: 5, win: 100, xp: [party], fresh: 400, ...hires },
    ];
    expect(metricI1(miniData(cellsAt(96), henchmen)).pass).toBe(true);
    expect(metricI1(miniData(cellsAt(94), henchmen)).pass).toBe(false);
  });

  it('gives I2 the same tolerance', () => {
    const cellsAt = (low: number): MiniCell[] => [
      { table: 0, comp: 'A', level: 20, win: 100, xp: [low] },
      { table: 1, comp: 'A', level: 20, win: 100, xp: [100] },
    ];
    const options = { grid: [20], rooms: [[10, 0], [20, 1]] as [number, number][] };
    expect(metricI2(miniData(cellsAt(103), options)).pass).toBe(true);
    expect(metricI2(miniData(cellsAt(106), options)).pass).toBe(false);
  });

  it('gives I3 the same tolerance', () => {
    const cellsAt = (low: number): MiniCell[] => [
      { table: 0, comp: 'A', level: 20, win: 100, xp: [low] },
      { table: 1, comp: 'A', level: 20, win: 100, xp: [100] },
    ];
    const options = { grid: [20], rooms: [[10, 0], [20, 1]] as [number, number][] };
    expect(metricI3(miniData(cellsAt(103), options)).pass).toBe(true);
    expect(metricI3(miniData(cellsAt(106), options)).pass).toBe(false);
  });

  it('gives I12 the same tolerance', () => {
    const cellsAt = (solo: number): MiniCell[] => [
      { table: 0, comp: 'K', level: 5, win: 100, xp: [solo] },
      { table: 0, comp: 'K+A+P+M+B', level: 5, win: 100, xp: [100, 100, 100, 100, 100] },
    ];
    expect(metricI12(miniData(cellsAt(103))).pass).toBe(true);
    expect(metricI12(miniData(cellsAt(106))).pass).toBe(false);
  });

  it('lets I8 dip by less than the tolerance on the way up', () => {
    const cellsAt = (plusTwo: number): MiniCell[] => [
      { table: 0, comp: 'A', level: 20, win: 100, xp: [100] },
      { table: 1, comp: 'A', level: 20, win: 100, xp: [120] },
      { table: 2, comp: 'A', level: 20, win: 100, xp: [plusTwo] },
    ];
    const options = { grid: [20], rooms: [[20, 0], [21, 0], [22, 0]] as [number, number][] };
    expect(metricI8(miniData(cellsAt(130), options)).pass).toBe(true);
    expect(metricI8(miniData(cellsAt(117), options)).pass).toBe(true);
    expect(metricI8(miniData(cellsAt(110), options)).pass).toBe(false);
  });

  it('scores the literal case on its own line, and says what it takes', () => {
    const baselineCard = metricLiteral(miniData([{ table: 0, comp: 'A', level: 5, win: 100, xp: [1] }], { plan: baseline }));
    expect(baselineCard.pass).toBe(true);
    expect(baselineCard.magnitude).toContain('0.868');
    expect(baselineCard.magnitude).toContain(`${mod.PARTY_XP_SHARE[2].toFixed(3)} human`);
    expect(baselineCard.lines.join('\n')).toContain('by construction');
  });
});

describe('a broken plan', () => {
  const cell = (xp: number): MiniCell => ({ table: 0, comp: 'A', level: 5, win: 100, xp: [xp] });
  const metric = (id: string, pass: boolean | null) => ({ id, title: id, pass, magnitude: 'm', lines: [] });

  it('refuses rates that hold anything but finite numbers', () => {
    expect(() => miniData([{ table: 0, comp: 'A', level: 5, win: 100, xp: [null as unknown as number] }])).toThrow(/finite/);
  });

  it('warns when a plan pays almost nothing', () => {
    const d = miniData([cell(0), { ...cell(0), table: 1 }, { ...cell(5), comp: 'K' }]);
    expect(sanityWarnings(d, []).join()).toContain('broken plan');
    expect(sanityWarnings(miniData([cell(5)]), [])).toEqual([]);
  });

  it('warns when a scored metric measured nothing', () => {
    const warnings = sanityWarnings(miniData([cell(5)]), [metric('I1', null), metric('I2', true), metric('Progression', null)]);
    expect(warnings.join()).toContain('I1 read n/a');
    expect(warnings.join()).not.toContain('Progression');
  });

  it('stamps the summary with its card and counts verdicts', () => {
    const summary = renderSummary(miniData([cell(5)]), 'x', [metric('I1', false), metric('I2', true), metric('Progression', null)], 'abc123');
    expect(summary).toContain('abc123');
    expect(summary).toContain('1 of 2 scored metrics fail');
  });
});

describe('boss rooms under a policy', () => {
  const plan: XpPlan = { id: 'x', describe: '', payout: () => 0, bossPolicy: { respawnMs: 6 * 3_600_000 } };
  const build = (policy: XpPlan | undefined): Data => {
    const all = buildComps(ALL_FAMILIES);
    const comps = [all.find(c => c.id === 'A')!];
    const table = (index: number, boss: boolean): XpTable => ({ index, key: `room|${index}`, kind: 'room', label: `R${index}`, zoneId: 'z', zoneName: 'Z', regionId: 'r', regionName: 'R', regionIndex: 0, zoneLevelRange: [1, 60], roomLevel: 5, roomLevelSource: 'authored', entries: [], strata: [], tileCount: 1, npcTiles: 0, shopTiles: 0, dungeonTiles: 0, tileTypes: {}, zeroXp: false, starterZone: false, boss, bossShare: boss ? 1 : 0, override: false, fallback: false });
    const meta = { grid: [5], tables: [table(0, false), table(1, true)], comps, pauseMs: 1800, rewardMultiplier: 1.8 } as unknown as AtlasMeta;
    const cells: XpCell[] = [0, 1].map(id => ({ id, table: id, comp: 0, level: 5, hires: [], xpMult: 1 }));
    const rate = (c: number, xp: number, bs?: CellRate['bs']): CellRate => ({ c, n: 24, win: 100, loss: 0, stale: 0, to: 0, hz: 0, fwin: 100, ms: 10000, winMs: 10000, hp: 1, deaths: 0, kills: 1, dmg: 1, kph: 100, skip: 0, reloc: 0, xp: [xp], raw: [xp], xpf: [100], st: [], ...(bs ? { bs } : {}) });
    const content = { henchmen: {}, dungeons: {}, monsters: {}, skills: {} } as unknown as XpSnapshot;
    const rates = [rate(0, 1000), rate(1, 30508, { share: 1, ms: 10000, win: 1, xpf: [100], restMs: 0, restXpf: [0] })];
    return new Data(meta, cells, rates, content, [], { once: [], repeatable: [], noXp: 0, danglingPrerequisites: [], cycles: [] }, mod, policy, 2, 15000, null);
  };

  it('leaves the rate alone without a policy', () => {
    const d = build(undefined);
    expect(d.get(1, 'A', 5)!.xp).toBe(30508);
    expect(d.bossDayRate(d.get(1, 'A', 5)!)).toBe(30508);
  });

  it('shows what the room pays to room comparisons, and idle plus the bonus for a day around the boss', () => {
    const d = build(plan);
    expect(d.get(1, 'A', 5)!.xp).toBeCloseTo((4 * 100) / 24, 3);
    expect(d.bossDayRate(d.get(1, 'A', 5)!)).toBeCloseTo((4 * 100 + (24 - (4 * 11.8) / 3600) * 1000) / 24, 3);
    expect(d.get(0, 'A', 5)!.xp).toBe(1000);
  });
});

describe('weekly income', () => {
  const content = worldFixture();
  const { regions } = buildRegions(content);
  const ledger = buildQuestLedger(content, regions);

  it('spreads a weekly over its week from the level it opens', () => {
    expect(repeatableXpPerHour(ledger.repeatable, 1)).toBeCloseTo(40 / 168);
    expect(repeatableXpPerHour([{ ...ledger.repeatable[0], availableAt: 20 }], 19)).toBe(0);
    expect(repeatablesWithinRegion(ledger, 0).map(q => q.id)).toEqual(['weekly']);
    expect(repeatablesWithinRegion(ledger, 1)).toEqual([]);
  });
});

describe('plan helpers', () => {
  const member: MemberView = { index: 0, className: 'Knight', level: 20, role: 'member' };
  const hire = { id: 'h', className: 'Knight' as const, level: 35 };
  const ctxOf = (table: Record<string, unknown> = { kind: 'room' }): PayoutContext => ({
    party: { compId: 'x', family: 'core', members: [member, { ...member, index: 1, level: 12 }], hires: ['h'], hireDetails: [hire], shareCount: 3, xpMultiplier: 1 },
    table,
    rewardMultiplier: 1.8,
    pauseMs: 1800,
    params: {},
    rules: xpRulesOf(mod),
  } as unknown as PayoutContext);
  const mob = (level: number, extra: Record<string, unknown> = {}) => monsterInfoOf(mod, 'b', { id: 'b', name: 'B', xp: 1000, hp: 100, damage: 10, level, ...extra });
  const fight = (won: boolean, level = 20): FightView => ({ result: won ? 'victory' : 'defeat', won, realMs: 1, partyDamage: 1, minHpFrac: 1, deaths: 0, pastHorizon: false, encounterId: null, monsters: [{ def: mob(level), killed: won ? 1 : 0, standing: won ? 0 : 1 }] });

  it('counts every monster present, by the game\'s level gap and floor factor', () => {
    const gap = mod.levelGapXpFactor(5, 20, 20, false);
    expect(memberXp([{ def: mob(5), killed: 1, standing: 1 }], 20, ctxOf())).toBeCloseTo(2000 * gap);
    expect(memberXp([{ def: mob(5), killed: 1, standing: 0 }], 20, ctxOf({ kind: 'floor', floorXpFactor: 0.5 }))).toBeCloseTo(500 * gap);
    const derived = monsterInfoOf(mod, 'd', { id: 'd', name: 'D', xp: 1000, hp: 100, damage: 10 });
    expect(derived.authored).toBe(false);
    expect(memberXp([{ def: derived, killed: 1, standing: 0 }], 20, ctxOf())).toBe(1000);
    expect(fightPot(fight(true), member, ctxOf())).toBeCloseTo(1800);
  });

  it('pays the shipped rule on a win and nothing on a loss', () => {
    expect(shippedXp(fight(true), member, ctxOf())).toBe(mod.fightXp({ monsters: [mob(20)], memberLevel: 20, topHumanLevel: 20, bodies: 3, starterZone: false, xpBonus: 1, rewardMultiplier: 1.8 }));
    const plan = definePlan({ id: 'p', describe: '', victory: () => 7 });
    expect(plan.payout(fight(true), member, ctxOf())).toBe(7);
    expect(plan.payout(fight(false), member, ctxOf())).toBe(0);
  });

  it('gives plans the share curves, hire weight and level spread', () => {
    expect(growingPotShare(1, 0.25)).toBe(1);
    expect(growingPotShare(3, 0.25)).toBeCloseTo(0.5);
    expect(powerShare(1, 0.74)).toBe(1);
    expect(powerShare(2, 1)).toBe(0.5);
    expect(weightedBodies(ctxOf(), 0.5)).toBe(2.5);
    expect(partyLevelSpread(ctxOf())).toBe(23);
  });

  it('scopes a weekly rule to dungeons one player can enter', () => {
    const rule = weeklyRuleForSoloDungeons(0.1);
    expect(rule('d', true)).toEqual({ fullClearsPerWeek: 1, repeatFactor: 0.1 });
    expect(rule('d', false)).toBeUndefined();
  });
});

describe('plan params', () => {
  it('reads key=value flags as numbers', () => {
    expect(parseParamFlags(['b=0.25', 'c=2'])).toEqual({ b: 0.25, c: 2 });
    expect(() => parseParamFlags(['b'])).toThrow(/key=number/);
    expect(() => parseParamFlags(['b=x'])).toThrow(/key=number/);
    expect(() => parseParamFlags(['=2'])).toThrow(/key=number/);
    expect(() => parseParamFlags(['b='])).toThrow(/key=number/);
  });

  it('sets them on the plan\'s own object, and refuses a typo', () => {
    const params = { b: 0.2 };
    const plan: XpPlan = { id: 'p', describe: '', params, payout: () => 0 };
    applyParamOverrides(plan, { b: 0.5 });
    expect(params.b).toBe(0.5);
    expect(() => applyParamOverrides(plan, { c: 1 })).toThrow(/no param c/);
    expect(() => applyParamOverrides({ id: 'q', describe: '', payout: () => 0 }, { c: 1 })).toThrow(/no param c/);
  });

  it('names the values in the title', () => {
    expect(planTitle('p', {})).toBe('p');
    expect(planTitle('p', undefined)).toBe('p');
    expect(planTitle('p', { c: 2, b: 0.25 })).toBe('p (b=0.25, c=2)');
  });

  it('applies them when a plan loads, from any path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-plan-'));
    try {
      const path = join(dir, 'plan.mjs');
      writeFileSync(path, 'const plan = { id: "outside", describe: "", params: { b: 1 }, payout: (_f, _m, c) => c.params.b }; export default plan;');
      const plan = await loadPlan(path, { b: 3 });
      expect(plan.id).toBe('outside');
      expect(plan.params).toEqual({ b: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the evaluator tells a plan', () => {
  const comp = buildComps(['core']).find(c => c.id === 'A+hires')!;
  const floor = { index: 0, key: 'floor|0', kind: 'floor', label: 'F', boss: true, starterZone: false, floorXpFactor: 0.5, strata: [{ encounterId: 'e', share: 1, boss: true }] } as unknown as XpTable;
  const meta = { monsters: ['b'], encounters: ['e'], comps: [comp], tables: [floor], pauseMs: 1800, retreatMs: 6040, autoRetreatBelowPct: 25, rewardMultiplier: 1.8 } as unknown as AtlasMeta;
  const cells: XpCell[] = [{ id: 0, table: 0, comp: 0, level: 5, hires: ['h'], xpMult: 1 }];
  const content = { monsters: { b: { id: 'b', xp: 1000, hp: 5, level: 5, tier: 'boss' } }, henchmen: { h: { id: 'h', className: 'Priest', level: 9 } } } as unknown as XpSnapshot;

  function evaluate(plan: XpPlan, result: number): CellRate {
    const dir = mkdtempSync(join(tmpdir(), 'xp-ctx-'));
    try {
      const path = join(dir, 'rows.bin');
      const writer = new RowWriter(path);
      writer.write({ cell: 0, encounter: 0, result, realMs: 1000, pastHorizon: false, deaths: 0, damage: 1, minHp: 1, groups: [0, 0, 1] });
      writer.close();
      const out: CellRate[] = [];
      createEvaluator({ meta, cells, content, plan, mod })(path, rate => out.push(rate));
      return out[0];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('hands payout the pause and the hires\' classes and levels', () => {
    let seen: PayoutContext | undefined;
    evaluate({ id: 'p', describe: '', payout: (_f, _m, c) => {
      seen = c;
      return 1;
    } }, RESULT_VICTORY);
    expect(seen!.pauseMs).toBe(1800);
    expect(seen!.party.hireDetails).toEqual([{ id: 'h', className: 'Priest', level: 9 }]);
    expect(seen!.table.floorXpFactor).toBe(0.5);
    expect(seen!.rules.fightXp).toBe(mod.fightXp);
  });

  it('hands payout each monster as createMonsterInstance makes it', () => {
    let def: MonsterInfo | undefined;
    evaluate({ id: 'p', describe: '', payout: f => {
      def = { ...f.monsters[0].def };
      return 1;
    } }, RESULT_VICTORY);
    const instance = mod.createMonsterInstance(content.monsters.b);
    expect(def).toMatchObject({ xp: 1000, maxHp: instance.maxHp, damage: instance.damage, level: instance.level, levelSource: 'authored', authored: true, tier: 'boss' });
  });

  it('pays the baseline nothing on a timeout', () => {
    expect(evaluate(baseline, RESULT_TIMEOUT).xpf).toEqual([0]);
    expect(evaluate(baseline, RESULT_VICTORY).xpf[0]).toBeGreaterThan(0);
  });
});

describe('xp_bonus is a perk', () => {
  const room = { rooms: [[5, 0]] as [number, number][] };

  it('leaves I6 alone, stacked or not, and says so', () => {
    const d = miniData([
      { table: 0, comp: 'Bx5', level: 5, win: 100, xp: [100, 100, 100, 100, 100] },
      { table: 0, comp: 'I:Bx5', level: 5, win: 100, xp: [300, 300, 300, 300, 300], xpMult: 3 },
      { table: 0, comp: 'U:K', level: 5, win: 100, xp: [10] },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [10] },
    ], room);
    const metric = metricI6(d);
    expect(metric.pass).toBe(true);
    expect(metric.magnitude).not.toContain('stacked');
    expect(metric.lines.join('\n')).toContain('never count');
  });

  it('takes I7 pairs holding it out of the verdict, and reports them apart', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], kph: 300 },
      { table: 0, comp: 'I:B', level: 5, win: 100, xp: [400], kph: 100, xpMult: 3 },
      { table: 0, comp: 'A', level: 5, win: 100, xp: [120], kph: 200 },
    ], room);
    const metric = metricI7(d);
    expect(metric.values!.inverted).toBe(1);
    expect(metric.values!.pairs).toBe(1);
    expect(metric.values!.bonusPairs).toBe(2);
    expect(metric.values!.bonusInverted).toBe(2);
    const fine = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], kph: 300 },
      { table: 0, comp: 'I:B', level: 5, win: 100, xp: [400], kph: 100, xpMult: 3 },
      { table: 0, comp: 'A', level: 5, win: 100, xp: [90], kph: 200 },
    ], room);
    expect(metricI7(fine).pass).toBe(true);
    expect(metricI7(fine).magnitude).toContain('reported apart');
  });

  it('lets I1b score a Bard wearing it, and rescues a default addition that lowers pay', () => {
    const cells = (withPerk: number): MiniCell[] => [
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'K+B', level: 5, win: 100, xp: [50, 50] },
      { table: 0, comp: 'I:K+B', level: 5, win: 100, xp: [withPerk, withPerk], xpMult: 2 },
    ];
    expect(metricI1b(miniData(cells(120), room)).pass).toBe(true);
    expect(metricI1b(miniData(cells(120), room)).values!.rescuedByBonus).toBe(1);
    expect(metricI1b(miniData(cells(60), room)).pass).toBe(false);
  });

  it('skips a Bard wearing it where the atlas has no such cell', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'K+B', level: 5, win: 100, xp: [50, 50] },
      { table: 0, comp: 'I:K+B', level: 30, win: 100, xp: [300, 300], xpMult: 2 },
    ], { ...room, grid: [5, 30] });
    expect(metricI1b(d).values!.bonusPairs).toBe(0);
    expect(metricI1b(d).pass).toBe(false);
  });
});

describe('weak solo, strong together', () => {
  const plainWon = (_d: Data, r: { rate: CellRate }): boolean => r.rate.win >= 90;

  it('reads best room against best room for every layout, not the same room', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'K+P', level: 5, win: 100, xp: [60, 60] },
      { table: 1, comp: 'K+P', level: 5, win: 100, xp: [150, 150] },
      { table: 0, comp: 'K+A', level: 5, win: 100, xp: [70, 70] },
    ]);
    const pairs = soloLayoutPairs(d, plainWon, plainWon);
    expect(pairs.map(p => [p.comp.id, p.ratio])).toEqual([['K+P', 1.5], ['K+A', 0.7]]);
    const metric = metricI12(d);
    expect(metric.title).toBe('Weak solo, strong together');
    expect(metric.pass).toBe(false);
    expect(metric.values!.outEarnedBeyondNoise).toBe(1);
  });

  it('counts a layout that wins nothing as out-earned, and skips one with no cells at that level', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'K+P', level: 5, win: 40, xp: [60, 60] },
    ]);
    expect(soloLayoutPairs(d, plainWon, plainWon)[0].ratio).toBe(0);
    const bonus = miniData([{ table: 0, comp: 'B', level: 5, win: 100, xp: [100] }, { table: 0, comp: 'I:Bx5', level: 30, win: 100, xp: [1, 1, 1, 1, 1] }], { grid: [5, 30] });
    expect(soloLayoutPairs(bonus, plainWon, plainWon)).toEqual([]);
  });

  it('reports the levels a class alone has no on-level room it wins', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K', level: 20, win: 100, xp: [100] },
      { table: 1, comp: 'K+P', level: 20, win: 100, xp: [300, 300] },
    ], { grid: [5, 20], rooms: [[5, 0], [2, 0]] });
    expect(metricI12(d).magnitude).toContain('Knight L20');
    expect(metricI12(d).values!.classLevelsWithNoOnLevelRoom).toBe(1);
  });
});

describe('robust reach', () => {
  const rooms: [number, number][] = [[5, 0], [6, 0], [7, 0], [8, 0], [12, 0], [13, 0], [30, 1], [31, 1]];
  const wins = (tables: number[], level: number, comp = 'Bx5'): MiniCell[] => tables.map(table => ({ table, comp, level, win: 100, xp: [1, 1, 1, 1, 1] }));

  it('ignores a soft room far above a gap', () => {
    const d = miniData(wins([0, 1, 2, 3, 6, 7], 10), { grid: [10], rooms });
    expect(robustReach(d, 'Bx5', 10)).toBe(8);
  });

  it('is null when even the lowest rooms aren\'t won', () => {
    expect(robustReach(miniData(wins([6, 7], 10), { grid: [10], rooms }), 'Bx5', 10)).toBeNull();
  });

  it('scores five Bards per level with and without the perk, and judges nothing', () => {
    const d = miniData([
      ...wins([0, 1, 2, 3], 7),
      ...[0, 1, 2, 3].map(table => ({ table, comp: 'I:Bx5', level: 7, win: 100, xp: [2, 2, 2, 2, 2], xpMult: 2 })),
      ...wins([0, 1, 2, 3], 7, 'K+A+P+M+B').map(c => ({ ...c, xp: [3, 3, 3, 3, 3] })),
    ], { grid: [7], rooms });
    const metric = metricI13(d);
    expect(metric.pass).toBeNull();
    expect(metric.values!.pairs).toBe(4);
    expect(metric.values!.ledWithoutBonus).toBe(0);
    expect(metric.values!.ledWithBonus).toBe(0);
    expect(metric.lines.join('\n')).toContain('never a failure');
  });
});

describe('layout variety helpers', () => {
  it('counts an even lead as that many layouts', () => {
    expect(effectiveNumber([5, 5])).toBe(2);
    expect(effectiveNumber([10])).toBe(1);
    expect(effectiveNumber([])).toBe(0);
  });

  it('covers stops greedily', () => {
    expect(coverOfStops([['a', 'b'], ['a'], ['c']])).toEqual(['a', 'c']);
    expect(coverOfStops([])).toEqual([]);
  });

  it('compares two layouts over the rooms both win', () => {
    const mine = new Map([['r1', 100], ['r2', 100], ['r3', 100]]);
    const other = new Map([['r1', 120], ['r2', 105]]);
    const compared = compareLayouts(mine, other, 0.1);
    expect(compared.shared).toBe(2);
    expect(compared.worseShare).toBe(0.5);
    expect(compared.extraShare).toBeCloseTo(1 / 3);
  });

  function grid(value: (layout: number, room: number) => number): SpreadRow[] {
    const rows: SpreadRow[] = [];
    for (let layout = 0; layout < 4; layout++) {
      for (let room = 0; room < 8; room++) rows.push({ y: value(layout, room), room, level: 10, region: room % 2, layout: `l${layout}` });
    }
    return rows;
  }

  it('puts a layout simply better everywhere in the first term', () => {
    const shares = layoutSpread(grid((layout, room) => layout + room * 0.1));
    expect(shares.layout).toBeCloseTo(1, 5);
    expect(shares.layoutByRoom).toBeCloseTo(0, 5);
  });

  it('puts a layout that suits particular rooms in the room term', () => {
    const shares = layoutSpread(grid((layout, room) => (room === layout ? 1 : 0)));
    expect(shares.layoutByRoom + shares.layoutByRegion).toBeGreaterThan(0.95);
    const favoured = shares.favour.get('l2|2')!;
    expect(favoured.effect).toBeGreaterThan(0.5);
    expect(shares.favour.get('l2|3')!.effect).toBeLessThan(0);
  });
});

describe('layouts have different purposes', () => {
  const levels = [10, 12, 14, 16, 18, 20, 23, 26, 30];
  const rooms: [number, number][] = [[10, 0], ...levels.map((l, i): [number, number] => [l, 1 + (i % 2)])];
  const layouts = ['K+P', 'K+A', 'A+P'];
  const rotating = (table: number, comp: string): number => (layouts.indexOf(comp) === (table - 1) % 3 ? 100 : 50);
  const cell = (table: number, comp: string, xp: number): MiniCell => ({ table, comp, level: levels[Math.max(0, table - 1)], win: 100, xp: [xp, xp] });
  const worldCells = (pay: (table: number, comp: string) => number): MiniCell[] => layouts.flatMap(comp => rooms.map((_, table) => cell(table, comp, pay(table, comp))));
  const options = { grid: levels, rooms };

  it('puts the first third of regions in the early game', () => {
    expect(midGameRegion(12)).toBe(4);
    expect(midGameRegion(3)).toBe(1);
    expect(midGameRegion(1)).toBe(1);
  });

  it('passes parties taking turns, and states its numbers', () => {
    const metric = metricI14(miniData(worldCells(rotating), options));
    expect(metric.pass).toBe(true);
    expect(metric.values!.midGameRegion).toBe(1);
    expect(metric.values!.topLeadShare).toBeCloseTo(1 / 3);
    const text = metric.lines.join('\n');
    expect(text).toContain('75 %');
    expect(text).toContain('80 %');
    expect(text).toContain('under 3 rooms');
    expect(text).toContain('Moving it by one region');
  });

  it('fails one layout leading nearly everywhere', () => {
    const metric = metricI14(miniData(worldCells((_t, comp) => (comp === 'K+P' ? 100 : 50)), options));
    expect(metric.pass).toBe(false);
    expect(metric.values!.topLeadShare).toBe(1);
  });

  it('only reports the early regions', () => {
    const early = (table: number, comp: string): number => (table === 0 ? (comp === 'K+P' ? 100 : 10) : rotating(table, comp));
    expect(metricI14(miniData(worldCells(early), options)).pass).toBe(true);
  });

  it('fails a party with no purpose from the mid game on, and leaves solos out of that test', () => {
    const noPurpose = (table: number, comp: string): number => (comp === 'A+P' ? 1 : rotating(table, comp) === 100 || table % 2 === 0 ? 100 : 60);
    const withSolo: MiniCell[] = [...worldCells(noPurpose), ...rooms.map((_, table) => ({ table, comp: 'K', level: levels[Math.max(0, table - 1)], win: 100, xp: [1] }))];
    const metric = metricI14(miniData(withSolo, options));
    expect(metric.values!.layoutsWithNoPurpose).toBe(1);
    expect(metric.pass).toBe(false);
  });

  it('counts a party that wins nothing from the mid game on as having no purpose', () => {
    const earlyOnly = worldCells(rotating).filter(c => !(c.comp === 'A+P' && c.table > 0));
    expect(metricI14(miniData(earlyOnly, options)).values!.layoutsWithNoPurpose).toBe(1);
  });

  it('counts a Bard party\'s two loadouts as one layout', () => {
    const cells: MiniCell[] = [
      ...levels.map((level, i) => ({ table: i + 1, comp: 'K+B', level, win: 100, xp: [50, 50] })),
      ...levels.map((level, i) => ({ table: i + 1, comp: 'I:K+B', level, win: 100, xp: [100, 100], xpMult: 2 })),
      ...levels.map((level, i) => ({ table: i + 1, comp: 'K+P', level, win: 100, xp: [90, 90] })),
    ];
    const metric = metricI14(miniData(cells, options));
    expect(metric.values!.topLeadShare).toBe(1);
    expect(metric.magnitude).toContain('K+B leads');
    expect(metric.lines.join('\n')).not.toContain('I:K+B');
  });
});

describe('material rooms', () => {
  const content = {
    items: {
      raw: { id: 'raw', name: 'Raw Stuff' },
      token: { id: 'token', name: 'Token' },
      deep: { id: 'deep', name: 'Deep Stuff' },
      part: { id: 'part', name: 'Part' },
      filler: { id: 'filler', name: 'Filler' },
      bought: { id: 'bought', name: 'Bought' },
      blade: { id: 'blade', name: 'Blade', equipSlot: 'mainhand' },
    },
    recipes: {
      r1: { id: 'r1', requiredLevel: 5, ingredients: [{ itemId: 'raw', quantity: 2 }, { itemId: 'token', quantity: 1 }, { itemId: 'deep', quantity: 2 }, { itemId: 'bought', quantity: 1 }], result: { itemId: 'blade', quantity: 1 } },
      r2: { id: 'r2', requiredLevel: 5, ingredients: [{ itemId: 'filler', quantity: 3 }], result: { itemId: 'part', quantity: 1 } },
    },
    monsters: {
      mob: { id: 'mob', name: 'Mob', xp: 10, hp: 10, level: 5, tier: 'trash', drops: [{ itemId: 'raw', chance: 0.5 }, { itemId: 'filler', chance: 0.5 }] },
      boss: { id: 'boss', name: 'Boss', xp: 10, hp: 10, level: 5, tier: 'boss', drops: [{ itemId: 'token', chance: 1 }] },
    },
    encounters: {
      e1: { id: 'e1', type: 'explicit', placements: [{ monsterId: 'mob' }, { monsterId: 'mob' }] },
      e2: { id: 'e2', type: 'explicit', placements: [{ monsterId: 'boss' }] },
    },
    dungeons: { dd: { id: 'dd', name: 'Deep Door', floors: [{ rewards: [{ itemId: 'deep', chance: 1, minQty: 1, maxQty: 3 }], encounterTable: [] }] } },
    shops: { s: { id: 's', name: 'Shop', inventory: [{ itemId: 'bought', price: 1 }] } },
    quests: { q: { id: 'q', repeat: 'once', rewards: [{ kind: 'item', itemId: 'token', quantity: 2 }] } },
    henchmen: {},
    skills: {},
  };

  it('walks an encounter\'s rolls, trimming to the room cap as the engine does', () => {
    const monsters = { a: {}, b: {} };
    expect(expectedPack({ type: 'explicit', placements: [{ monsterId: 'a' }, { monsterId: 'a' }, { monsterId: 'gone' }] }, monsters)).toEqual(new Map([['a', 2]]));
    expect(expectedPack({ type: 'random', monsterPool: [{ monsterId: 'a', min: 1, max: 3 }] }, monsters).get('a')).toBeCloseTo(2);
    const trimmed = expectedPack({ type: 'random', roomMax: 2, monsterPool: [{ monsterId: 'a', min: 2, max: 2 }, { monsterId: 'b', min: 1, max: 1 }] }, monsters);
    expect(trimmed.get('a')).toBe(1);
    expect(trimmed.get('b')).toBe(1);
    expect(expectedPack(undefined, monsters).size).toBe(0);
  });

  it('applies the paced drop chance per monster present', () => {
    const [e1] = encounterDropTables(content as unknown as XpSnapshot, mod, ['e1'], 1.8);
    expect(e1.get('raw')).toBeCloseTo(1);
  });

  it('reads materials from the snapshot it is given', () => {
    const materials = buildMaterials(content as unknown as XpSnapshot, mod);
    const of = (id: string) => materials.find(m => m.id === id)!;
    expect(materials.map(m => m.id).sort()).toEqual(['bought', 'deep', 'filler', 'raw', 'token']);
    expect(of('raw').usedByGear).toBe(true);
    expect(of('raw').perCraft).toBe(2);
    expect(of('filler').usedByGear).toBe(false);
    expect(of('token').bossToken).toBe(true);
    expect(of('token').freeOnce).toBe(2);
    expect(of('deep').floors[0].quantity).toBe(2);
    expect(of('bought').shopSold).toBe(true);
  });

  function atHit(roomXp: number, floorXpf: number, tokenXp = 100, drops: Record<string, unknown> = content.monsters, roomMs = 2000): Data {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [roomXp], st: [[0, 1, 24, 100, roomMs]] },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [tokenXp], st: [[1, 1, 24, 100, 2000]] },
      { table: 3, comp: 'K', level: 5, win: 100, xp: [floorXpf], xpf: [floorXpf], ms: 2000 },
    ], {
      rooms: [[5, 0], [5, 0], [5, 0]],
      encounters: ['e1', 'e2'],
      extraTables: [{ kind: 'floor', dungeonId: 'dd', dungeonName: 'Deep Door', floorIndex: 0, roomLevel: 5 }],
      content: { ...content, monsters: drops },
    });
    d.meta.tables[1].strata = [{ encounterId: 'e1', share: 1, boss: false }];
    d.meta.tables[2].strata = [{ encounterId: 'e2', share: 1, boss: true }];
    return d;
  }

  it('passes a hit in the band or no hit, and fails a far bigger one, with numbers stated', () => {
    expect(metricI15(atHit(80, 100)).pass).toBe(true);
    expect(metricI15(atHit(100, 100)).pass).toBe(true);
    const far = metricI15(atHit(40, 100, 100, content.monsters, 3_600_000));
    expect(far.pass).toBe(false);
    expect(far.values!.failing).toBe(1);
    expect(far.lines.join('\n')).toContain('10 % to 30 %');
    expect(far.lines.join('\n')).toContain('over 50 %');
  });

  it('scores a detuned dungeon on XP given up, and shows it moved', () => {
    const paying = metricI15(atHit(100, 100));
    const detuned = metricI15(atHit(100, 0.0001));
    expect(detuned.values!.dungeonSourceMedianHit).toBeGreaterThan(paying.values!.dungeonSourceMedianHit);
    expect(detuned.pass).toBe(true);
    expect(detuned.values!.dungeonOnly).toBe(1);
  });

  it('holds a boss token to the same short-visit line', () => {
    const token = metricI15(atHit(100, 100, 1));
    expect(token.values!.bossTokens).toBe(1);
    expect(token.pass).toBe(true);
  });

  it('doesn\'t fail a room material because a detuned dungeon became its cheapest source', () => {
    const both = { ...content, dungeons: { dd: { id: 'dd', name: 'Deep Door', floors: [{ rewards: [{ itemId: 'raw', chance: 1, minQty: 20, maxQty: 20 }, { itemId: 'deep', chance: 1 }], encounterTable: [] }] } } };
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [80], st: [[0, 1, 24, 100, 200000]] },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [0.01], xpf: [0.01], ms: 2000 },
    ], { rooms: [[5, 0], [5, 0]], encounters: ['e1'], extraTables: [{ kind: 'floor', dungeonId: 'dd', dungeonName: 'Deep Door', floorIndex: 0, roomLevel: 5 }], content: both });
    d.meta.tables[1].strata = [{ encounterId: 'e1', share: 1, boss: false }];
    const metric = metricI15(d);
    expect(metric.values!.farOver).toBe(1);
    expect(metric.pass).toBe(true);
  });

  it('follows the snapshot when a plan moves a drop', () => {
    const moved = { ...content.monsters, mob: { ...content.monsters.mob, drops: [] }, boss: { ...content.monsters.boss, drops: [{ itemId: 'raw', chance: 1 }] } };
    const metric = metricI15(atHit(40, 100, 100, moved, 3_600_000));
    expect(metric.values!.failing).toBe(0);
  });
});

describe('boss and dungeon farming', () => {
  const dungeon = { id: 'dd', name: 'Door', firstClearXp: 5000, floors: [], entryRequirements: { minLevel: 5 } };
  const world = (loopPay: number, extra: Partial<MiniOptions> = {}): Data => miniData([
    { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
    { table: 1, comp: 'K', level: 5, win: 100, xp: [loopPay], xpf: [loopPay], ms: 3_000_000 },
  ], { rooms: [[5, 0]], extraTables: [{ kind: 'floor', dungeonId: 'dd', dungeonName: 'Door', floorIndex: 0, roomLevel: 5 }], content: { dungeons: { dd: dungeon } }, ...extra });

  it('fails a solo loop over the class\'s best solo room, and only beyond the tolerance', () => {
    expect(metricI10(world(83)).values!.soloLoopsOverBeyondNoise).toBe(0);
    expect(metricI10(world(83)).pass).toBe(true);
    const over = metricI10(world(90));
    expect(over.values!.soloLoopsOverBeyondNoise).toBe(1);
    expect(over.values!.soloDungeons).toBe(1);
    expect(over.values!.soloLoopCases).toBe(1);
    expect(over.pass).toBe(false);
  });

  it('never counts a weekly against the verdict, and reports it as days of idle', () => {
    const quests = { w: { id: 'w', name: 'Boss weekly', repeat: 'weekly', objectives: [{ kind: 'kill', monsterId: 'b' }], rewards: [] } };
    const monsters = { b: { id: 'b', name: 'B', tier: 'boss', level: 5 } };
    const ledger = { repeatable: [{ id: 'w', name: 'Boss weekly', xp: 2_400_000, regionIndex: 0, needsRegions: [], requiredLevel: 5, availableAt: 5, prerequisites: [], repeat: 'weekly' }] };
    const metric = metricI10(world(10, { content: { dungeons: { dd: dungeon }, quests, monsters }, ledger }));
    expect(metric.pass).toBe(true);
    expect(metric.values!.premiumP90WithBossWeeklies).toBeGreaterThan(100);
    const text = metric.lines.join('\n');
    expect(text).toContain('Boss weekly');
    expect(text).toContain('Days of idle XP');
    expect(text).toContain('1000.0');
  });

  it('reads a weekly rule: a lump and a repeat rate', () => {
    expect(applyWeeklyRule(1000, { fullClearsPerWeek: 1, repeatFactor: 0.1 })).toEqual({ repeat: 100, lump: 900 });
    expect(applyWeeklyRule(1000, undefined)).toEqual({ repeat: 1000, lump: 0 });
    expect(weeklyRuleFor({ dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.5 } }, 'd', false)).toEqual({ fullClearsPerWeek: 1, repeatFactor: 0.5 });
    expect(weeklyRuleFor({ dungeonWeekly: weeklyRuleForSoloDungeons(0.5) }, 'd', false)).toBeUndefined();
    expect(weeklyRuleFor(undefined, 'd', true)).toBeUndefined();
  });

  it('lets a plan detune repeat clears, with loop and premium numbers moving and the lump apart', () => {
    const plan: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.05 } } };
    const loud = metricI10(world(1000));
    const detuned = metricI10(world(1000, { plan }));
    expect(loud.pass).toBe(false);
    expect(detuned.pass).toBe(true);
    expect(detuned.values!.worstSoloLoop).toBeCloseTo(loud.values!.worstSoloLoop * 0.05);
    expect(detuned.lines.join('\n')).toContain('weekly dungeon rule');
    expect(detuned.values!.premiumP90WithWeeklyFullClears).toBeGreaterThan(detuned.values!.premiumP90);
  });

  it('can scope the rule to dungeons one player can enter', () => {
    const scoped: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: weeklyRuleForSoloDungeons(0.05) } };
    expect(metricI10(world(1000, { plan: scoped })).pass).toBe(true);
    const party = miniData([
      { table: 0, comp: 'K+P', level: 5, win: 100, xp: [100, 100] },
      { table: 1, comp: 'K+P', level: 5, win: 100, xp: [1000, 1000], xpf: [1000, 1000], ms: 3_000_000 },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
    ], { rooms: [[5, 0]], extraTables: [{ kind: 'floor', dungeonId: 'dd', dungeonName: 'Door', floorIndex: 0, roomLevel: 5 }], content: { dungeons: { dd: dungeon } }, plan: scoped });
    expect(metricI10(party).values!.worstLoop).toBeGreaterThan(5);
  });
});

describe('other scorecard wording', () => {
  it('calls the reference parties examples in I11', () => {
    const metric = metricI11(miniData([{ table: 0, comp: 'K+A+P+M+B', level: 5, win: 100, xp: [1, 1, 1, 1, 1] }]));
    expect(metric.lines.join('\n')).toContain('not the party the game should push players towards');
  });

  it('reports the cheats it can\'t express as not simulated, neither pass nor fail', () => {
    const metric = metricNotSimulated();
    expect(metric.pass).toBeNull();
    for (const family of ['Leaving or joining before the kill', 'Padding with the weakest hires', 'Lockouts across rooms', 'A lone player left behind a party door', 'Dungeon runs that stop early, for XP']) {
      expect(NOT_SIMULATED.map(c => c.family)).toContain(family);
      expect(metric.lines.join('\n')).toContain(family);
    }
    expect(sanityWarnings(miniData([{ table: 0, comp: 'A', level: 5, win: 100, xp: [5] }]), [metric])).toEqual([]);
  });
});

describe('nothing over nothing', () => {
  it('reads as zero, not NaN, so no ratio test passes it by accident', () => {
    expect(safeRatio(0, 0)).toBe(0);
    expect(safeRatio(5, 0)).toBe(Infinity);
    expect(safeRatio(5, 10)).toBe(0.5);
  });

  it('fails I1 when a party and solo both pay nothing', () => {
    const d = miniData([
      { table: 0, comp: 'A', level: 5, win: 100, xp: [0] },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [50] },
      { table: 1, comp: 'K+A', level: 5, win: 100, xp: [100, 0] },
    ]);
    const pairs = bestRoomPairs(d).pairs.filter(p => p.className === 'Archer');
    expect(pairs[0].ratio).toBe(0);
    expect(metricI1(d).pass).toBe(false);
    expect(quantile([Infinity, Infinity], 0.5)).toBe(Infinity);
  });
});

describe('solo stays playable', () => {
  const party = (xp: number): MiniCell => ({ table: 0, comp: 'K+P', level: 5, win: 100, xp: [xp, xp] });

  it('passes a weak solo earning a fair share', () => {
    const d = miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [20] }, party(100)]);
    expect(soloPlayability(d)[0].share).toBeCloseTo(0.2);
    expect(metricI12(d).pass).toBe(true);
  });

  it('fails a solo paid almost nothing, though every comparison passes', () => {
    const metric = metricI12(miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [1] }, party(100)]));
    expect(metric.pass).toBe(false);
    expect(metric.values!.outEarnedBeyondNoise).toBe(0);
    expect(metric.values!.classLevelsUnderSoloFloor).toBe(1);
    expect(metric.magnitude).toContain('Knight L5');
  });

  it('fails a class that wins no paying room alone, and a solo paid nothing, instead of reading n/a', () => {
    const lost = metricI12(miniData([{ table: 0, comp: 'K', level: 5, win: 10, xp: [1] }, party(100)]));
    expect(lost.pass).toBe(false);
    expect(lost.values!.classLevelsWithNoRoomAlone).toBe(1);
    const unpaid = metricI12(miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [0] }, party(100)]));
    expect(unpaid.pass).toBe(false);
  });

  it('reports a lone player with free hires against human parties', () => {
    const metric = metricI12(miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [20] },
      party(100),
      { table: 0, comp: 'K+h4', level: 5, win: 100, xp: [97], hires: ['a', 'b', 'c', 'd'] },
    ]));
    expect(metric.values!.loneWithHiresPairs).toBe(1);
    expect(metric.values!.loneWithHiresWithinNoise).toBe(1);
    expect(metric.lines.join('\n')).toContain('free hires');
  });
});

describe('losing doesn\'t pay', () => {
  const cells = (win: number, xp: number): MiniCell[] => [
    { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
    { table: 1, comp: 'K', level: 5, win, xp: [xp] },
  ];

  it('fails a room the party mostly loses paying more than its best room won', () => {
    const metric = metricI8b(miniData(cells(30, 200)));
    expect(metric.pass).toBe(false);
    expect(metric.values!.worstRatio).toBe(2);
  });

  it('leaves a room won half the time or more to the challenge it is', () => {
    const lostRoom: MiniCell = { table: 2, comp: 'K', level: 5, win: 10, xp: [5] };
    expect(metricI8b(miniData([...cells(60, 200), lostRoom], { rooms: [[5, 0], [9, 0], [12, 0]] })).pass).toBe(true);
    expect(metricI8b(miniData(cells(30, 103))).pass).toBe(true);
  });

  it('asks a second look of a flagged pick, and reads it', () => {
    const d = miniData(cells(30, 200));
    const lost = d.get(1, 'K', 5)!;
    const won = d.get(0, 'K', 5)!;
    expect(rereadCells(d).sort()).toEqual([won.cell.id, lost.cell.id].sort());
    d.absorbSecond(new Map([[lost.cell.id, miniRate({ table: 1, comp: 'K', level: 5, win: 55, xp: [200] }, lost.cell.id)]]), 400);
    expect(losingPairs(d)).toEqual([]);
    expect(d.rawRates().find(r => r.c === lost.cell.id)!.win).toBe(30);
  });
});

describe('stalling reads the biggest sample', () => {
  const flagged = (xp: number): MiniCell[] => [
    { table: 0, comp: 'K', level: 5, win: 100, xp: [100], ms: 5000, fresh: 400 },
    { table: 0, comp: 'U:K', level: 5, win: 100, xp: [xp], ms: 9000, fresh: 400 },
  ];
  const opts = { rooms: [[5, 0]] as [number, number][] };

  it('says a flagged cell isn\'t confirmed until a big sample holds it, and clears one that falls back', () => {
    const d = miniData(flagged(106), opts);
    const variant = d.get(0, 'U:K', 5)!;
    const normal = d.get(0, 'K', 5)!;
    expect(confirmCells(d).sort()).toEqual([normal.cell.id, variant.cell.id].sort());
    expect(metricI6(d).pass).toBe(false);
    expect(metricI6(d).values!.notConfirmed).toBe(1);
    const fresh = (id: number, xp: number, table: number, comp: string): [number, CellRate] => [id, miniRate({ table, comp, level: 5, win: 100, xp: [xp], ms: comp === 'K' ? 5000 : 9000 }, id)];
    d.absorbSecond(new Map([fresh(variant.cell.id, 102, 0, 'U:K'), fresh(normal.cell.id, 100, 0, 'K')]), 6000);
    expect(metricI6(d).pass).toBe(true);
    expect(metricI6(d).values!.flaggedOnFreshSample).toBe(1);
    expect(d.rawRates().find(r => r.c === variant.cell.id)!.xp).toEqual([106]);
  });

  it('counts one that holds, and needs no bigger sample for one far over the line', () => {
    const d = miniData(flagged(106), opts);
    const variant = d.get(0, 'U:K', 5)!;
    const normal = d.get(0, 'K', 5)!;
    const fresh = (id: number, xp: number, comp: string): [number, CellRate] => [id, miniRate({ table: 0, comp, level: 5, win: 100, xp: [xp], ms: comp === 'K' ? 5000 : 9000 }, id)];
    d.absorbSecond(new Map([fresh(variant.cell.id, 106, 'U:K'), fresh(normal.cell.id, 100, 'K')]), 6000);
    const metric = metricI6(d);
    expect(metric.pass).toBe(false);
    expect(metric.values!.notConfirmed).toBe(0);
    expect(metric.magnitude).toContain('6000 fights a side');
    const far = miniData(flagged(200), opts);
    expect(confirmCells(far)).toEqual([]);
    expect(metricI6(far).values!.notConfirmed).toBe(0);
  });

  it('asks for a fresh read of a faster party before counting it, and recounts it', () => {
    const cells: MiniCell[] = [
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], ms: 5000, kph: 100 },
      { table: 0, comp: 'S:K+P', level: 5, win: 100, xp: [120, 120], ms: 4000, kph: 130 },
      { table: 0, comp: 'K+P', level: 5, win: 100, xp: [100, 100], ms: 5000, kph: 100 },
    ];
    const d = miniData(cells, opts);
    expect(metricI6(d).values!.fasterParties).toBe(1);
    const row = d.get(0, 'S:K+P', 5)!;
    const normal = d.get(0, 'K+P', 5)!;
    expect(rereadCells(d).sort()).toEqual([row.cell.id, normal.cell.id].sort());
    d.absorbSecond(new Map([
      [row.cell.id, miniRate({ table: 0, comp: 'S:K+P', level: 5, win: 100, xp: [102, 102], ms: 4000, kph: 130 }, row.cell.id)],
      [normal.cell.id, miniRate({ table: 0, comp: 'K+P', level: 5, win: 100, xp: [100, 100], ms: 5000, kph: 100 }, normal.cell.id)],
    ]), 400);
    expect(metricI6(d).values!.fasterParties).toBe(0);
    expect(metricI6(d).values!.fasterBeforeSecondLook).toBe(1);
  });
});

describe('xp_bonus pairs in I7', () => {
  const room = { rooms: [[5, 0]] as [number, number][] };

  it('keeps a pair where only the faster party holds it in the verdict', () => {
    const d = miniData([
      { table: 0, comp: 'I:B', level: 5, win: 100, xp: [100], kph: 300, xpMult: 2 },
      { table: 0, comp: 'A', level: 5, win: 100, xp: [120], kph: 100 },
    ], room);
    const metric = metricI7(d);
    expect(metric.values!.pairs).toBe(1);
    expect(metric.values!.inverted).toBe(1);
    expect(metric.values!.bonusPairs).toBe(0);
    expect(metric.lines.join('\n')).toContain('either party holds it would read 0/0');
  });
});

describe('power-levelling', () => {
  const carry = (friendXp: number): MiniCell[] => [
    { table: 0, comp: 'K', level: 10, win: 100, xp: [50] },
    { table: 0, comp: 'K+P+M', level: 10, win: 100, xp: [100, 100, 100] },
    { table: 0, comp: 'C1+1:-10', level: 20, win: 100, xp: [50, friendXp] },
  ];
  const options = { grid: [10, 20], rooms: [[10, 0]] as [number, number][] };

  it('needs a carried friend faster than an on-level party, not just solo', () => {
    expect(metricI9(miniData(carry(300), options)).pass).toBe(true);
    const slow = metricI9(miniData(carry(70), options));
    expect(slow.values!.speedupOverSolo).toBeGreaterThan(1);
    expect(slow.values!.speedupOverParty).toBeLessThan(1);
    expect(slow.pass).toBe(false);
  });

  it('flags a carrier earning little, without failing it', () => {
    const cells = carry(300);
    cells[2] = { ...cells[2], xp: [1, 300] };
    const metric = metricI9(miniData(cells, options));
    expect(metric.pass).toBe(true);
    expect(metric.magnitude).toContain('flag');
  });
});

describe('zero rooms and the room floor', () => {
  const rooms: [number, number][] = [[5, 1], [5, 1], [5, 1], [5, 1]];
  const pay = (last: number): MiniCell[] => [100, 100, 100, last].map((xp, table) => ({ table, comp: 'K', level: 5, win: 100, xp: [xp] }));

  it('fails a token room under the floor, which the zero test alone would pass', () => {
    const token = metricI5(miniData(pay(1), { rooms }));
    expect(token.pass).toBe(false);
    expect(token.values!.zeroRoomsOutsideStarter).toBe(0);
    expect(token.values!.roomsUnderFloor).toBe(1);
    expect(metricI5(miniData(pay(50), { rooms })).pass).toBe(true);
  });

  it('leaves the starter region and a room the party loses out of the floor', () => {
    const starter = miniData(pay(1), { rooms: [[5, 0], [5, 0], [5, 0], [5, 0]] });
    expect(metricI5(starter).values!.roomsUnderFloor).toBe(0);
    const lost = pay(1);
    lost[3] = { ...lost[3], win: 20 };
    expect(metricI5(miniData(lost, { rooms })).values!.roomsUnderFloor).toBe(0);
  });

  it('fails a room paying nothing to a member who wins it at or above their level', () => {
    const d = miniData([
      { table: 0, comp: 'K+P', level: 20, win: 100, xp: [100, 0] },
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
    ], { grid: [5, 20], rooms: [[5, 1]] });
    const metric = metricI5(d);
    expect(metric.values!.zeroRoomsOutsideStarter).toBe(0);
    expect(metric.values!.roomsPayingSomeoneNothing).toBe(1);
    expect(metric.pass).toBe(false);
  });

  it('reports what a room far below the party pays', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 20, win: 100, xp: [1] },
      { table: 1, comp: 'K', level: 20, win: 100, xp: [100] },
    ], { grid: [20], rooms: [[5, 1], [20, 1]] });
    const metric = metricI5(d);
    expect(metric.values!.afkLowestShare).toBeCloseTo(0.01);
    expect(metric.lines.join('\n')).toContain('Going AFK');
  });
});

describe('every layout counts in I14', () => {
  const levels = [10, 12, 14];
  const rooms: [number, number][] = [[10, 1], [12, 1], [14, 1]];

  it('counts a layout paid nothing as having no purpose, not as gone', () => {
    const cells: MiniCell[] = levels.flatMap((level, table) => ['K+P', 'K+A'].flatMap(comp => [{ table, comp, level, win: 100, xp: comp === 'K+P' ? [100, 100] : [0, 0] }]));
    const metric = metricI14(miniData(cells, { grid: levels, rooms }));
    expect(metric.values!.layoutsWithNoPurpose).toBe(1);
    expect(metric.pass).toBe(false);
  });

  it('prints leaders by family, boss rooms apart and the any-stage count', () => {
    const cells: MiniCell[] = levels.flatMap((level, table) => [{ table, comp: 'M+B', level, win: 100, xp: [100, 100] }, { table, comp: 'K+P', level, win: 100, xp: [90, 90] }]);
    const metric = metricI14(miniData(cells, { grid: levels, rooms }));
    expect(metric.values!.leadHoldsMageAndBard).toBe(1);
    expect(metric.values!.leadHoldsKnightAndPriest).toBe(0);
    const text = metric.lines.join('\n');
    expect(text).toContain('ordinary rooms only');
    expect(text).toContain('at any stage of the game');
    expect(text).toContain('boss rooms included');
  });
});

describe('reach and gates', () => {
  const rooms: [number, number][] = [[5, 0], [6, 0], [20, 0], [21, 0], [30, 0], [31, 0]];
  const wins = (tables: number[], level: number): MiniCell[] => tables.map(table => ({ table, comp: 'Bx5', level, win: 100, xp: [1, 1, 1, 1, 1] }));

  it('holds a room behind a gate out of the test, and marks the reach', () => {
    const d = miniData(wins([0, 1, 3, 4, 5], 10), { grid: [10], rooms });
    d.meta.tables[2].reachLevel = 15;
    expect(reachReading(d, 'Bx5', 10)).toEqual({ reach: 31, heldBack: true });
    const open = miniData(wins([0, 1, 3, 4, 5], 10), { grid: [10], rooms });
    expect(reachReading(open, 'Bx5', 10)).toEqual({ reach: 6, heldBack: false });
  });

  it('stops where every room near is out of reach', () => {
    const d = miniData(wins([0, 1], 10), { grid: [10], rooms });
    for (const i of [2, 3, 4, 5]) d.meta.tables[i].reachLevel = 15;
    expect(reachReading(d, 'Bx5', 10)).toEqual({ reach: 6, heldBack: true });
  });

  it('keeps ordinary rooms and boss rooms on their own footing in I13', () => {
    const d = miniData([
      ...wins([0, 1], 5),
      { table: 2, comp: 'Bx5', level: 5, win: 100, xp: [9, 9, 9, 9, 9] },
      { table: 2, comp: 'K+P', level: 5, win: 100, xp: [9, 9] },
      { table: 3, comp: 'K+P', level: 5, win: 100, xp: [9, 9] },
    ], { grid: [5], rooms: [[5, 0], [5, 0]], extraTables: [{ boss: true, roomLevel: 5 }, { boss: true, roomLevel: 5 }] });
    const metric = metricI13(d);
    expect(metric.values!.pairs).toBe(2);
    expect(metric.values!.roomsWon).toBe(2);
    expect(metric.values!.bossPairs).toBe(2);
    expect(metric.values!.bossWon).toBe(1);
    expect(metric.magnitude).toContain('of 2 on-level boss-room pairs they win 1');
  });
});

describe('dungeons pay above zero', () => {
  const floorOptions = (zeroXp: boolean) => ({ rooms: [[5, 0]] as [number, number][], extraTables: [{ kind: 'floor' as const, dungeonId: 'dd', dungeonName: 'Door', floorIndex: 0, roomLevel: 5, zeroXp }], content: { dungeons: { dd: { id: 'dd', name: 'Door', floors: [] } } } });
  const world = (floorXp: number, zeroXp: boolean): Data => miniData([
    { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
    { table: 1, comp: 'K', level: 5, win: 100, xp: [floorXp], xpf: [floorXp], ms: 3_000_000 },
  ], floorOptions(zeroXp));

  it('fails a floor whose content pays, cut to nothing, and only reports one written at zero', () => {
    const cut = metricI10(world(0, false));
    expect(cut.pass).toBe(false);
    expect(cut.values!.floorsCutToNothing).toBe(1);
    const written = metricI10(world(0, true));
    expect(written.pass).toBe(true);
    expect(written.values!.floorsWrittenAtZero).toBe(1);
    expect(written.lines.join('\n')).toContain('runs a dungeon for gear');
  });

  it('refuses a weekly rule out of bounds, and accepts the solo-dungeon rule', () => {
    expect(() => assertWeeklyRule({ fullClearsPerWeek: 1, repeatFactor: 0 }, 'd')).toThrow(/above 0/);
    expect(() => assertWeeklyRule({ fullClearsPerWeek: 100000, repeatFactor: 0.1 }, 'd')).toThrow(/fullClearsPerWeek/);
    expect(() => assertWeeklyRule({ fullClearsPerWeek: MAX_WEEKLY_FULL_CLEARS, repeatFactor: 1 }, 'd')).not.toThrow();
    expect(() => assertBossPolicy({ dungeonWeekly: weeklyRuleForSoloDungeons(0) }, ['d'])).toThrow(/above 0/);
    expect(() => weeklyRuleFor({ dungeonWeekly: { fullClearsPerWeek: 9, repeatFactor: 0.5 } }, 'd', true)).toThrow(/fullClearsPerWeek/);
    expect(() => assertBossPolicy({ dungeonWeekly: () => undefined }, ['d'])).not.toThrow();
  });

  it.each([
    ['a negative cap', { dungeonClearsPerDay: -5 }, /dungeonClearsPerDay/],
    ['a cap of nothing, a clear that never pays', { dungeonClearsPerDay: 0 }, /dungeonClearsPerDay/],
    ['a NaN cap', { dungeonClearsPerDay: NaN }, /dungeonClearsPerDay/],
    ['an endless cap', { dungeonClearsPerDay: Infinity }, /dungeonClearsPerDay/],
    ['a negative respawn', { respawnMs: -1 }, /respawnMs/],
    ['a NaN respawn', { respawnMs: NaN }, /respawnMs/],
  ])('refuses %s', (_name, policy, message) => {
    expect(() => assertBossPolicy(policy, ['d'])).toThrow(message);
  });

  it('accepts a real cap and respawn, with no weekly rule beside them', () => {
    expect(() => assertBossPolicy({ dungeonClearsPerDay: 0.5, respawnMs: 60000 }, [])).not.toThrow();
    expect(() => assertBossPolicy({ respawnMs: 0 }, [])).not.toThrow();
  });

  it('counts clears past the first each week in the premium', () => {
    expect(weeklyExcessXp(1000, { fullClearsPerWeek: 1, repeatFactor: 0.1 })).toBe(0);
    expect(weeklyExcessXp(1000, { fullClearsPerWeek: 3, repeatFactor: 0.1 })).toBe(1800);
    expect(weeklyExcessXp(1000, undefined)).toBe(0);
    const paid = (full: number): number => {
      const plan: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: full, repeatFactor: 0.01 } } };
      return metricI10(miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [1000000], xpf: [1000000], ms: 3_000_000 },
      ], { ...floorOptions(false), plan })).values!.premiumP90;
    };
    expect(paid(3)).toBeGreaterThan(paid(1));
  });

  it('reads the solo line against the room idle reads, on the win line too', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], fresh: 400 },
      { table: 1, comp: 'K', level: 5, win: 89, xp: [300], fresh: 400 },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [200], xpf: [200], ms: 3_600_000 - 15000 - 1800 },
    ], { rooms: [[5, 0], [5, 0]], extraTables: floorOptions(false).extraTables, content: floorOptions(false).content });
    expect(metricI10(d).values!.soloLoopsOverBeyondNoise).toBe(0);
  });

  it('calls a loop paying nothing against a room paying nothing nothing, and a paying one over', () => {
    const nothing = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [0] },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [0], xpf: [0], ms: 3_000_000 },
    ], floorOptions(true));
    expect(metricI10(nothing).values!.soloLoopsOver).toBe(0);
    const over = miniData([
      { table: 0, comp: 'K', level: 5, win: 10, xp: [0] },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [50], xpf: [50], ms: 3_000_000 },
    ], floorOptions(false));
    const metric = metricI10(over);
    expect(metric.pass).toBe(false);
    expect(metric.values!.worstSoloLoop).toBe(Infinity);
    expect(metric.values!.partyLevelsWithNoIdleRoom).toBe(1);
  });

  it('reads every core and extended party, not just the reference ones', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 0, comp: 'A+B', level: 5, win: 100, xp: [100, 100] },
      { table: 1, comp: 'A+B', level: 5, win: 100, xp: [1000, 1000], xpf: [1000000, 1000000], ms: 3_000_000 },
    ], floorOptions(false));
    const metric = metricI10(d);
    expect(metric.pass).toBe(false);
    expect(metric.values!.loopPairsAbove).toBe(1);
    expect(metric.values!.referenceLoopPairsAbove).toBe(0);
  });
});

describe('what a card says it can\'t see', () => {
  it('names the missing parties and the default loadouts, and drops the first once they are there', () => {
    const without = coverageNotes(miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [1] }]));
    expect(without.join()).toContain('Mx2+Bx3');
    expect(without.join()).toContain('default loadout');
    const withThem = miniData(MAGE_BARD_PARTIES.map(comp => ({ table: 0, comp, level: 5, win: 100, xp: [1, 1, 1, 1, 1] })));
    expect(coverageNotes(withThem).join()).not.toContain('Mx2+Bx3');
    expect(NOT_SIMULATED.map(c => c.family)).toContain('Skills granted by items');
  });

  describe('skills granted by items', () => {
    const skills = { shield: { id: 'shield', className: 'Mage' }, cut: { id: 'cut', className: 'Archer' } };
    const sameClassSet = { pair: { id: 'pair', name: 'Ward Pair', classRestriction: ['Mage'], breakpoints: [{ piecesRequired: 2, bonuses: { grantedSkillIds: ['shield'] } }] } };

    it('reads the grant the snapshot still holds, and names it', () => {
      const content = { skills, sets: sameClassSet, items: {} } as unknown as XpSnapshot;
      expect(skillGrants(content)).toEqual([{ source: 'Ward Pair', kind: 'set', skillClass: 'Mage', allowed: ['Mage'], crossClass: false }]);
      expect(skillGrantNote(content)).toBe('Plans assume no item grants another class\'s skill. Only the Ward Pair set remains, a Mage skill for Mages, which default loadouts don\'t slot.');
    });

    it('says plainly when a snapshot still gives one class another\'s skill', () => {
      const content = { skills, sets: sameClassSet, items: { frame: { id: 'frame', name: 'A Frame', grantedSkillIds: ['cut'], classRestriction: ['Knight'] }, open: { id: 'open', name: 'Open', grantedSkillIds: ['cut'] } } } as unknown as XpSnapshot;
      expect(skillGrants(content).filter(g => g.crossClass).map(g => g.source)).toEqual(['A Frame', 'Open']);
      const note = skillGrantNote(content);
      expect(note).toContain('still holds 2 that do (A Frame, Open)');
      expect(note).toContain('predates');
    });

    it('prints the note in Not simulated, and claims nothing without a snapshot', () => {
      const d = miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [1] }], { content: { skills, sets: sameClassSet } });
      expect(metricNotSimulated(d).lines.join('\n')).toContain('a Mage skill for Mages');
      expect(coverageNotes(d).join()).toContain('a Mage skill for Mages');
      expect(metricNotSimulated().lines.join('\n')).toContain('Plans assume no item grants another class\'s skill');
      expect(metricNotSimulated().lines.join('\n')).not.toContain('never slots');
    });
  });

  it('holds those parties, and an xp_bonus twin of every Bard party of distinct classes', () => {
    const comps = buildComps(ALL_FAMILIES);
    const ids = new Set(comps.map(c => c.id));
    for (const id of MAGE_BARD_PARTIES) {
      expect(ids.has(id)).toBe(true);
      expect(comps.find(c => c.id === id)!.members.length).toBe(5);
      expect(ids.has(`${XP_BONUS_PREFIX}${id}`)).toBe(true);
    }
    for (const id of ['M+B', 'A+P+B', 'K+A+M+B']) expect(ids.has(`${XP_BONUS_PREFIX}${id}`)).toBe(true);
    expect(new Set(comps.map(c => c.id)).size).toBe(comps.length);
  });
});

describe('what the card warns about', () => {
  const cell: MiniCell = { table: 0, comp: 'A', level: 5, win: 100, xp: [5] };

  it('warns when a plan caps or drops the XP multiplier', () => {
    expect(xpBonusProbe(baseline, mod, 1.8, 2)).toBeCloseTo(2, 2);
    const flat: XpPlan = { id: 'p', describe: '', payout: () => 7 };
    expect(xpBonusProbe(flat, mod, 1.8, 2)).toBe(1);
    expect(sanityWarnings(miniData([cell], { plan: flat }), []).join()).toContain('no plan may cap');
    expect(sanityWarnings(miniData([cell], { plan: baseline }), [])).toEqual([]);
    const unpaid: XpPlan = { id: 'p', describe: '', payout: () => 0 };
    expect(xpBonusProbe(unpaid, mod, 1.8, 2)).toBeNaN();
  });

  it('warns on pay for a lost fight, at any room level', () => {
    expect(paysLostFights(baseline, mod, 1.8)).toBe(false);
    const gapped: XpPlan = { id: 'p', describe: '', payout: (f, m, c) => (f.won ? 1 : c.table.roomLevel - m.level >= 11 ? 1 : 0) };
    expect(paysLostFights(gapped, mod, 1.8)).toBe(true);
    expect(sanityWarnings(miniData([cell], { plan: gapped }), []).join()).toContain('lost fight');
  });

  it('warns when kill rate hardly orders pay, and not otherwise', () => {
    const metric = (values: Record<string, number>) => ({ id: 'I7', title: 'I7', pass: true, magnitude: 'm', lines: [], values });
    expect(sanityWarnings(miniData([cell]), [metric({ spreadGroups: 3, killRateCorrelation: NaN })]).join()).toContain('kill rate hardly orders');
    expect(sanityWarnings(miniData([cell]), [metric({ spreadGroups: 3, killRateCorrelation: 0.9 })])).toEqual([]);
    expect(sanityWarnings(miniData([cell]), [metric({ spreadGroups: 0, killRateCorrelation: NaN })])).toEqual([]);
  });

  it('warns when a plan cuts first clears or quests, against the atlas\'s own content', () => {
    const d = miniData([cell], { content: { dungeons: { dd: { id: 'dd', firstClearXp: 10 } }, quests: { w: { id: 'w', repeat: 'weekly', rewards: [{ kind: 'xp', amount: 5 }] } } } });
    d.baseContent = { ...d.content, dungeons: { dd: { id: 'dd', firstClearXp: 100 } }, quests: { w: { id: 'w', repeat: 'weekly', rewards: [{ kind: 'xp', amount: 50 }] } } } as unknown as XpSnapshot;
    const text = sanityWarnings(d, []).join();
    expect(text).toContain('first-clear XP from 100');
    expect(text).toContain('weekly quest XP from');
    expect(text).not.toContain('one-off');
    d.baseContent = d.content;
    expect(sanityWarnings(d, [])).toEqual([]);
  });

});

describe('a metric with something to say doesn\'t read n/a', () => {
  it('fails I3 when sitters beat journeyers though no pair is tested', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100] },
      { table: 1, comp: 'K', level: 12, win: 100, xp: [10] },
    ], { grid: [5, 12], rooms: [[5, 0], [12, 1]] });
    const metric = metricI3(d);
    expect(metric.values!.pairs).toBe(0);
    expect(metric.pass).toBe(false);
  });

  it('fails I10 on a boss room paying when the party has no other room', () => {
    const d = miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [100] }], { rooms: [], extraTables: [{ boss: true, roomLevel: 5 }] });
    const metric = metricI10(d);
    expect(metric.pass).toBe(false);
    expect(metric.values!.worstBoss).toBe(Infinity);
    expect(metric.values!.partyLevelsWithNoIdleRoom).toBe(1);
  });
});

describe('the AFK persona', () => {
  const cells = (afkPay: number): MiniCell[] => [
    { table: 0, comp: 'K+P+M', level: 5, win: 100, xp: [100, 100, 100] },
    { table: 1, comp: 'K+P+M', level: 5, win: 100, xp: [afkPay, afkPay, afkPay] },
  ];
  const zeroed = (d: Data): Data => {
    d.meta.tables[1].zeroXp = true;
    return d;
  };

  it('reads what the plan pays in those rooms, at half rate while they pay nothing', () => {
    const row = (d: Data): string => metricProgression(d).lines.find(line => line.includes('AFK half') && line.includes('no quests'))!;
    const unpaid = row(zeroed(miniData(cells(0), { rooms: [[5, 0], [2, 0]] })));
    const paid = row(zeroed(miniData(cells(100), { rooms: [[5, 0], [2, 0]] })));
    expect(unpaid).not.toEqual(paid);
    const days = (line: string): number => Number(line.split('|')[3]);
    expect(days(unpaid) / days(paid)).toBeCloseTo(2, 1);
  });
});

describe('--param and a bossPolicy', () => {
  it('refuses a plain policy still holding a param\'s old value', () => {
    const params = { respawnMs: 1000, repeat: 0.5 };
    const trap: XpPlan = { id: 'p', describe: '', params, payout: () => 0, bossPolicy: { respawnMs: params.respawnMs, dungeonWeekly: weeklyRuleForSoloDungeons(params.repeat) } };
    expect(() => assertParamsReachPolicy(trap, { ...params }, { respawnMs: 2000 })).toThrow(/respawnMs/);
    expect(() => assertParamsReachPolicy(trap, { ...params }, { repeat: 0.1 })).toThrow(/repeat/);
    expect(() => assertParamsReachPolicy(trap, { ...params }, { repeat: 0.5 })).not.toThrow();
    expect(() => assertParamsReachPolicy(trap, { ...params }, undefined)).not.toThrow();
  });

  it('lets a plain policy whose rule reads params when it runs alone', () => {
    const params = { repeat: 1 };
    const lazy: XpPlan = { id: 'p', describe: '', params, payout: () => 0, bossPolicy: { dungeonWeekly: (id, one) => weeklyRuleForSoloDungeons(params.repeat)(id, one) } };
    applyParamOverrides(lazy, { repeat: 0.1 });
    expect(() => assertParamsReachPolicy(lazy, { repeat: 1 }, { repeat: 0.1 })).not.toThrow();
    expect(params.repeat).toBe(0.1);
  });

  it('reads a policy written as a function of params after they are set', () => {
    const params = { repeat: 0.5 };
    const plan: XpPlan = { id: 'p', describe: '', params, payout: () => 0, bossPolicy: p => ({ dungeonWeekly: weeklyRuleForSoloDungeons(p.repeat) }) };
    applyParamOverrides(plan, { repeat: 0.1 });
    expect(() => assertParamsReachPolicy(plan, { repeat: 0.5 }, { repeat: 0.1 })).not.toThrow();
    expect(weeklyRuleFor(planBossPolicy(plan), 'd', true)).toEqual({ fullClearsPerWeek: 1, repeatFactor: 0.1 });
    const d = miniData([{ table: 0, comp: 'A', level: 5, win: 100, xp: [5] }], { plan });
    expect(weeklyRuleFor(d.policy, 'd', true)!.repeatFactor).toBe(0.1);
  });
});

describe('samples a run keeps to itself', () => {
  it('reads the atlas\'s sample if it has one, else its own folder', () => {
    const atlas = mkdtempSync(join(tmpdir(), 'xp-sample-'));
    try {
      const shared = sampleDir(atlas, 400);
      mkdirSync(shared, { recursive: true });
      writeFileSync(cellFile(shared, 1), '');
      expect(sampleFile(atlas, 400, 1, join(atlas, 'mine'))).toBe(cellFile(shared, 1));
      expect(sampleFile(atlas, 400, 2, join(atlas, 'mine'))).toBe(cellFile(join(atlas, 'mine'), 2));
      expect(sampleFile(atlas, 400, 2)).toBe(cellFile(shared, 2));
    } finally {
      rmSync(atlas, { recursive: true, force: true });
    }
  });
});

describe('materials through parts', () => {
  const content = {
    items: {
      raw: { id: 'raw', name: 'Raw' },
      soldRaw: { id: 'soldRaw', name: 'Sold Raw' },
      freeRaw: { id: 'freeRaw', name: 'Free Raw' },
      lonely: { id: 'lonely', name: 'Lonely' },
      even: { id: 'even', name: 'Even' },
      unsoldPart: { id: 'unsoldPart', name: 'Unsold Part' },
      soldPart: { id: 'soldPart', name: 'Sold Part' },
      nothing: { id: 'nothing', name: 'Quest Thing' },
      sword: { id: 'sword', name: 'Sword', equipSlot: 'mainhand' },
      shield: { id: 'shield', name: 'Shield', equipSlot: 'offhand' },
    },
    recipes: {
      part1: { id: 'part1', requiredLevel: 10, ingredients: [{ itemId: 'freeRaw', quantity: 3 }], result: { itemId: 'unsoldPart', quantity: 3 } },
      part2: { id: 'part2', requiredLevel: 10, ingredients: [{ itemId: 'soldRaw', quantity: 4 }], result: { itemId: 'soldPart', quantity: 2 } },
      quest: { id: 'quest', requiredLevel: 10, ingredients: [{ itemId: 'lonely', quantity: 7 }], result: { itemId: 'nothing', quantity: 1 } },
      sword: { id: 'sword', requiredLevel: 30, ingredients: [{ itemId: 'unsoldPart', quantity: 2 }, { itemId: 'soldPart', quantity: 3 }, { itemId: 'even', quantity: 2 }, { itemId: 'raw', quantity: 1 }], result: { itemId: 'sword', quantity: 1 } },
      shield: { id: 'shield', requiredLevel: 40, ingredients: [{ itemId: 'even', quantity: 3 }, { itemId: 'raw', quantity: 1 }], result: { itemId: 'shield', quantity: 1 } },
    },
    monsters: {},
    dungeons: {},
    shops: { s: { id: 's', name: 'Shop', inventory: [{ itemId: 'soldPart', price: 1 }] } },
    quests: {},
    henchmen: {},
    skills: {},
    encounters: {},
  };
  const materials = buildMaterials(content as unknown as XpSnapshot, mod);
  const of = (id: string) => materials.find(m => m.id === id)!;

  it('counts a material reaching gear through a part no shop sells, per gear craft', () => {
    expect(of('freeRaw').usedByGear).toBe(true);
    expect(of('freeRaw').savesGoldOnly).toBe(false);
    expect(of('freeRaw').perCraft).toBe(2);
    expect(of('freeRaw').maxLevel).toBe(30);
  });

  it('calls a material reaching gear only through a sold part a gold saver', () => {
    expect(of('soldRaw').usedByGear).toBe(false);
    expect(of('soldRaw').savesGoldOnly).toBe(true);
    expect(of('soldRaw').perCraft).toBe(6);
    expect(of('soldRaw').maxLevel).toBe(10);
  });

  it('keeps a material reaching no gear out of both', () => {
    expect(of('lonely').usedByGear).toBe(false);
    expect(of('lonely').savesGoldOnly).toBe(false);
    expect(of('lonely').perCraft).toBe(7);
  });

  it('takes a true median', () => {
    expect(of('even').perCraft).toBe(2.5);
    expect(of('raw').perCraft).toBe(1);
  });
});

describe('gold arithmetic', () => {
  /** Every way these rolls can land, each once, in the order payVictory makes them. */
  function everyRoll(widths: readonly number[]): number[][] {
    return widths.reduce<number[][]>((all, width) => all.flatMap(prefix => Array.from({ length: width }, (_, k) => [...prefix, (k + 0.5) / width])), [[]]);
  }

  function realCoin(monsters: { goldMin: number; goldMax: number }[], humans: number, hires: number, floor?: { coinFactor?: number }): number[] {
    const defs = monsters.map((m, i) => ({ id: `g${i}`, xp: 0, currentHp: 0, ...m }));
    return realPayVictory({
      monsters: defs,
      humans: Array.from({ length: humans }, () => ({ level: 5 })),
      hires: Array.from({ length: hires }, () => ({})),
      floor,
      getMonster: (id: string) => defs.find(d => d.id === id),
    }).map(r => r.gold);
  }

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['one flat monster alone', [{ goldMin: 3, goldMax: 3 }], 1, 0],
    ['a spread, split with a hire', [{ goldMin: 1, goldMax: 3 }], 1, 1],
    ['two monsters, five humans', [{ goldMin: 1, goldMax: 3 }, { goldMin: 2, goldMax: 5 }], 5, 0],
    ['three monsters, three humans and a hire', [{ goldMin: 0, goldMax: 1 }, { goldMin: 2, goldMax: 4 }, { goldMin: 0, goldMax: 0 }], 3, 1],
    ['a monster paying nothing', [{ goldMin: 0, goldMax: 0 }], 2, 0],
    ['a floor\'s coin factor', [{ goldMin: 1, goldMax: 7 }, { goldMin: 3, goldMax: 4 }], 2, 0, { coinFactor: 0.3 }],
    ['a floor paying no coin', [{ goldMin: 5, goldMax: 9 }], 1, 0, { coinFactor: 0 }],
    ['a floor with an invalid coin factor', [{ goldMin: 1, goldMax: 3 }], 1, 0, { coinFactor: 2 }],
  ] as [string, { goldMin: number; goldMax: number }[], number, number, { coinFactor?: number }?][])('matches payVictory exactly: %s', (_name, monsters, humans, hires, floor) => {
    const outcomes = everyRoll(monsters.map(m => m.goldMax - m.goldMin + 1));
    let total = 0;
    for (const rolls of outcomes) {
      const queue = [...rolls];
      vi.spyOn(Math, 'random').mockImplementation(() => queue.shift() ?? 0);
      const paid = realCoin(monsters, humans, hires, floor);
      expect(new Set(paid).size).toBe(1);
      total += paid[0];
    }
    const model = expectedSplitCoin(monsters.map(m => ({ min: m.goldMin, max: m.goldMax, count: 1 })), mod.COMBAT_PACE.rewardMultiplier, humans + hires, mod.floorPayFactor(floor?.coinFactor));
    expect(model).toBeCloseTo(total / outcomes.length, 10);
  });

  it('counts a repeated monster as separate rolls, and pays round-up on a thin pack', () => {
    const one = expectedSplitCoin([{ min: 1, max: 3, count: 2 }], 1.8, 5);
    const apart = expectedSplitCoin([{ min: 1, max: 3, count: 1 }, { min: 1, max: 3, count: 1 }], 1.8, 5);
    expect(one).toBeCloseTo(apart, 10);
    expect(expectedSplitCoin([{ min: 1, max: 1, count: 1 }], 1.8, 5)).toBe(1);
    expect(expectedSplitCoin([], 1.8, 5)).toBe(0);
  });

  it('stays within a gold of the true mean past the walkable size, where it stops walking', () => {
    const coin = expectedSplitCoin([{ min: 0, max: 1_000_000, count: 1 }], 1.8, 1);
    const exact = 500_000 * 1.8 + 0.4;
    expect(Math.abs(coin - exact)).toBeLessThan(1);
    expect(coin).toBeGreaterThan(500_000 * 1.8);
  });

  it('matches grantDungeonRewards: per member, not split, class by class, at the authored chance', () => {
    const items: Record<string, any> = { gem: { id: 'gem', value: 100 }, robe: { id: 'robe', value: 3000 }, noValue: { id: 'noValue' } };
    const rewards = [
      { itemId: 'gem', chance: 0.5, minQty: 1, maxQty: 3 },
      { itemId: 'robe', chance: 0.05, classRestriction: ['Mage'] },
      { itemId: 'noValue', chance: 0.5 },
      { itemId: 'gone', chance: 1 },
    ];
    const sold: Record<string, number> = { Knight: 0, Mage: 0 };
    const sessions = new Map(['Knight', 'Mage'].map(c => [c, { getClassName: () => c, addLogEntry: () => {}, grantRewardItem: (id: string) => { sold[c] += itemSaleValue(items, id); return true; } }]));
    const manager = Object.create(PartyBattleManager.prototype);
    manager.getSession = (u: string) => sessions.get(u);
    manager.content = { getItem: (id: string) => items[id] };
    const rng = makeRng(hashSeed('floor-rewards'));
    vi.spyOn(Math, 'random').mockImplementation(rng);
    const trials = 60000;
    for (let i = 0; i < trials; i++) manager.grantDungeonRewards({ members: new Set(sessions.keys()) }, rewards, 'Floor reward');
    for (const className of ['Knight', 'Mage']) {
      expect(sold[className] / trials / floorRewardValue({ rewards }, className, items)).toBeCloseTo(1, 1);
    }
    expect(floorRewardValue({ rewards }, 'Knight', items)).toBeCloseTo(0.5 * 2 * 100 + 0.5 * 1);
    expect(floorRewardValue({ rewards }, 'Mage', items)).toBeCloseTo(0.5 * 2 * 100 + 0.05 * 3000 + 0.5 * 1);
  });

  it('matches payVictory\'s drops: one share each, a hire\'s lost, class-locked items among that class', () => {
    const items: Record<string, any> = { open: { id: 'open', value: 100 }, robe: { id: 'robe', value: 1000, classRestriction: ['Mage'] }, axe: { id: 'axe', value: 1000, classRestriction: ['Archer'] } };
    const drops = [{ itemId: 'open', chance: 0.2 }, { itemId: 'robe', chance: 0.1 }, { itemId: 'axe', chance: 0.6 }];
    const def = { id: 'mob', xp: 0, goldMin: 0, goldMax: 0, drops };
    const classes = ['Mage', 'Knight'];
    const sold = [0, 0];
    vi.spyOn(Math, 'random').mockImplementation(makeRng(hashSeed('monster-drops')));
    const trials = 60000;
    const fight: FakeFight = {
      monsters: [{ ...def, currentHp: 0 }],
      humans: classes.map(className => ({ level: 5, className })),
      hires: [{ className: 'Mage' }],
      getMonster: () => def,
      getItem: (id: string) => items[id],
    };
    for (let i = 0; i < trials; i++) {
      realPayVictory(fight).forEach((r, m) => {
        for (const id of r.items) sold[m] += items[id].value;
      });
    }
    const paced = (chance: number): number => mod.paceDropChance(mod.COMBAT_PACE, chance);
    classes.forEach((c, i) => {
      expect(sold[i] / trials / monsterDropValue(drops, paced, items, c, [...classes, 'Mage'])).toBeCloseTo(1, 1);
    });
    expect(dropShare(['Mage'], 'Mage', ['Mage', 'Knight', 'Mage'])).toBe(0.5);
    expect(dropShare(['Mage'], 'Knight', ['Mage', 'Knight', 'Mage'])).toBe(0);
    expect(dropShare(['Archer'], 'Knight', ['Mage', 'Knight', 'Mage'])).toBeCloseTo(1 / 3);
    expect(dropShare(undefined, 'Knight', ['Mage', 'Knight'])).toBe(0.5);
  });

  it('sells at value, 1 where an item has none, and an item the content lacks for nothing', () => {
    const items = { a: { value: 5 }, b: {}, free: { value: 0 } } as unknown as XpSnapshot['items'];
    expect([itemSaleValue(items, 'a'), itemSaleValue(items, 'b'), itemSaleValue(items, 'free'), itemSaleValue(items, 'gone')]).toEqual([5, 1, 0, 0]);
  });

  it('walks a run floor by floor: a loss ends it, and only a won floor rolls its rewards', () => {
    const run = loopRunGold([
      { winPct: 50, coinPerFight: 10, dropsPerFight: 4, rewardPerWin: 100 },
      { winPct: 100, coinPerFight: 20, dropsPerFight: 8, rewardPerWin: 1000 },
    ]);
    expect(run.coin).toBeCloseTo(10 + 0.5 * 20);
    expect(run.drops).toBeCloseTo(4 + 0.5 * 8);
    expect(run.rewards).toBeCloseTo(0.5 * 100 + 0.5 * 1000);
  });

  it('reads a run walking out after each floor, the last being the full run', () => {
    const floors = [
      { winPct: 50, coinPerFight: 10, dropsPerFight: 4, rewardPerWin: 100, cycleMs: 2000 },
      { winPct: 100, coinPerFight: 20, dropsPerFight: 8, rewardPerWin: 1000, cycleMs: 4000 },
    ];
    const [first, second] = goldStops(floors, 1000);
    expect(first).toEqual({ floors: 1, run: { coin: 10, rewards: 50, drops: 4 }, runMs: 3000, reach: 0.5 });
    expect(second.floors).toBe(2);
    expect(second.runMs).toBe(1000 + 2000 + 0.5 * 4000);
    expect(second.reach).toBeCloseTo(0.5);
    expect(second.run).toEqual(loopRunGold(floors));
  });

  it('keeps gold whole unless a rule says otherwise, whatever XP\'s factor is', () => {
    expect(goldFactors(undefined)).toEqual({ coin: 1, rewards: 1 });
    expect(goldFactors({ repeatFactor: 0.01 } as never)).toEqual({ coin: 1, rewards: 1 });
    expect(goldFactors({ repeatCoinFactor: 0.5, repeatRewardFactor: 0 })).toEqual({ coin: 0.5, rewards: 0 });
    const paid = applyGoldFactors({ coin: 100, rewards: 1000, drops: 7 }, { coin: 0.5, rewards: 0.1 }, 1);
    expect(paid.gold).toBeCloseTo(150);
    expect(paid.repeat.drops).toBe(7);
    expect(paid.lump).toBeCloseTo(950);
  });

  it('never confuses a party of two with a lone player and a hire', () => {
    const content = { monsters: { m: { id: 'm', goldMin: 0, goldMax: 0, drops: [{ itemId: 'x', chance: 1 }] } }, items: { x: { value: 10 } } } as unknown as XpSnapshot;
    const gold = new FightGold(['m'], content, mod, 1.8);
    expect(gold.dropValues(['Knight'], ['Priest']).length).toBe(1);
    expect(gold.dropValues(['Knight', 'Priest'], []).length).toBe(2);
  });
});

describe('gold off fight rows', () => {
  const comp = buildComps(['core']).find(c => c.id === 'K+P')!;
  const floor = { index: 0, key: 'floor|d|0', kind: 'floor', label: 'F', boss: false, starterZone: false, strata: [{ encounterId: 'e', share: 1, boss: false }] } as unknown as XpTable;
  const meta = { monsters: ['boss', 'wall'], encounters: ['e'], comps: [comp], tables: [floor], pauseMs: 1800, retreatMs: 6040, autoRetreatBelowPct: 25, rewardMultiplier: 1.8 } as unknown as AtlasMeta;
  const cells: XpCell[] = [{ id: 0, table: 0, comp: 0, level: 5, hires: [], xpMult: 1 }];
  const content = {
    monsters: { boss: { id: 'boss', xp: 10, hp: 5, level: 5, tier: 'boss', goldMin: 100, goldMax: 100, drops: [{ itemId: 'x', chance: 0.5 }] }, wall: { id: 'wall', xp: 0, hp: 5, passive: true, goldMin: 10, goldMax: 10 } },
    items: { x: { id: 'x', value: 40 } },
  } as unknown as XpSnapshot;
  const plan: XpPlan = { id: 'p', describe: '', payout: () => 1 };

  function rate(rows: { result: number }[], retuned?: XpSnapshot, table: XpTable = floor): CellRate {
    const dir = mkdtempSync(join(tmpdir(), 'xp-gold-'));
    const path = join(dir, 'rows.bin');
    const writer = new RowWriter(path);
    for (const r of rows) writer.write({ cell: 0, encounter: 0, result: r.result, realMs: 10000, pastHorizon: false, deaths: 0, damage: 1, minHp: 1, groups: [0, 1, 0, 1, 0, 1] });
    writer.close();
    const out: CellRate[] = [];
    try {
      createEvaluator({ meta: { ...meta, tables: [table] }, cells, content: retuned ?? content, plan, mod, ...(retuned ? { atlasContent: content } : {}) })(path, x => out.push(x));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return out[0];
  }

  it('pays coin and drops on a win, for every monster present, standing walls too', () => {
    const g = rate([{ result: RESULT_VICTORY }]).g!;
    expect(g.cf).toBe(Math.ceil((110 * 1.8) / 2));
    expect(g.df).toEqual([10, 10]);
    expect(g.cr).toBeCloseTo((99 / 11800) * 3_600_000, 0);
    expect(g.ch).toBe(g.cr);
  });

  it('pays no coin on a loss', () => {
    expect(rate([{ result: 1 }]).g!.cf).toBe(0);
    expect(rate([{ result: RESULT_TIMEOUT }]).g!.cf).toBe(0);
  });

  it('pays a floor\'s coin factor, and only on a floor', () => {
    expect(rate([{ result: RESULT_VICTORY }], undefined, { ...floor, floorCoinFactor: 0.5 }).g!.cf).toBe(Math.ceil((110 * 1.8 * 0.5) / 2));
    expect(rate([{ result: RESULT_VICTORY }], undefined, { ...floor, floorCoinFactor: 7 }).g!.cf).toBe(99);
    expect(rate([{ result: RESULT_VICTORY }], undefined, { ...floor, kind: 'room', floorCoinFactor: 0.5 }).g!.cf).toBe(99);
  });

  it('reads the same fights off the atlas\'s own content too when a plan retuned it, and adds nothing when none did', () => {
    const won = [{ result: RESULT_VICTORY }];
    const plain = rate(won).g!;
    expect(plain.atlas).toBeUndefined();
    const retuned = JSON.parse(JSON.stringify(content));
    retuned.monsters.boss.goldMin = 1000;
    retuned.monsters.boss.goldMax = 1000;
    retuned.items.x.value = 400;
    const g = rate(won, retuned).g!;
    expect(g.cf).toBe(Math.ceil((1010 * 1.8) / 2));
    expect(g.df).toEqual([100, 100]);
    expect(g.atlas!.ch).toBe(plain.ch);
    expect(g.atlas!.df).toEqual(plain.df);
  });

  it('writes gold apart, leaving rates.jsonl what it would be without it, and reads it back', () => {
    const fresh = rate([{ result: RESULT_VICTORY }]);
    const { g, ...xpOnly } = fresh;
    expect(rateLine(fresh)).toBe(JSON.stringify(xpOnly));
    expect(goldLine(fresh)).toBe(JSON.stringify({ c: 0, ...g }));
    expect(goldLine(xpOnly as CellRate)).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'xp-gold-file-'));
    try {
      writeRates(dir, [fresh]);
      const back = readRates(dir);
      expect(back[0]).toEqual(fresh);
      rmSync(join(dir, GOLD_FILE));
      expect(readRates(dir)[0].g).toBeUndefined();
      writeFileSync(join(dir, RATES_FILE), `${rateLine(fresh)}\n`);
      expect(readRates(dir)[0]).toEqual(xpOnly);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the door', () => {
  const lone = (className: string, level = 50) => [{ className, level }];
  const dungeon = (entryRequirements: Record<string, unknown>) => ({ id: 'd', name: 'D', floors: [{}], entryRequirements });

  it.each([
    ['open from a level', { minLevel: 10 }, true],
    ['one player only', { maxPartySize: 1 }, true],
    ['at most three', { maxPartySize: 3 }, true],
    ['too low', { minLevel: 60 }, false],
    ['needs three', { minPartySize: 3 }, false],
    ['needs five', { minPartySize: 5, maxPartySize: 5 }, false],
  ])('reads %s through the real entry rule', (_name, requirements, opens) => {
    expect(dungeonRefusal(mod, dungeon(requirements), lone('Knight')) === undefined).toBe(opens);
  });

  it('opens by class', () => {
    expect(dungeonRefusal(mod, dungeon({ requiredClasses: ['Knight', 'Mage'] }), lone('Knight'))).toBeUndefined();
    expect(dungeonRefusal(mod, dungeon({ requiredClasses: ['Knight', 'Mage'] }), lone('Bard'))).toBeDefined();
  });
});

describe('no solo dungeon for gold', () => {
  const HOUR = 3_600_000;
  /** One floor taking an hour with the re-entry and the pause, so per-run figures read as per-hour ones. */
  const floorMs = HOUR - 15000 - 1800;
  const coinOf = (ch: number, members = 1): CellGold => ({ cf: ch, ch, cr: ch, df: Array(members).fill(0), dh: Array(members).fill(0) });
  const items = { gem: { id: 'gem', name: 'Gem', value: 100 }, deep: { id: 'deep', name: 'Deep', value: 100 }, blade: { id: 'blade', name: 'Blade', equipSlot: 'mainhand', value: 0 } };
  const dungeons = (rewards: unknown[] = [{ itemId: 'gem', chance: 1, minQty: 5, maxQty: 5 }], entryRequirements: unknown = { minLevel: 5 }) => ({ dd: { id: 'dd', name: 'Door', floors: [{ rewards, encounterTable: [] }], entryRequirements } });
  const floorTable = { kind: 'floor' as const, dungeonId: 'dd', dungeonName: 'Door', floorIndex: 0, roomLevel: 5 };

  function world(roomCoin: number, floorCoin = 0, extra: Partial<MiniOptions> = {}): Data {
    return miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(roomCoin) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(floorCoin) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items }, ...extra });
  }

  it('fails a lone loop over the richest room, only past the allowance, and prints count and dungeon', () => {
    expect(metricI16(world(10000)).pass).toBe(true);
    const near = metricI16(world(490));
    expect(near.values!.over).toBe(1);
    expect(near.values!.overBeyondNoise).toBe(0);
    expect(near.pass).toBe(true);
    const over = metricI16(world(100));
    expect(over.pass).toBe(false);
    expect(over.values!.overBeyondNoise).toBe(1);
    expect(over.values!.worst).toBeCloseTo(5);
    expect(over.values!.dungeons).toBe(1);
    expect(over.magnitude).toContain('1/1 cases');
    expect(over.lines.join('\n')).toContain('| Door | L5+ | 1 | 1 | 1 | 1/1 | 5.00x | 5.00x |');
  });

  it('counts coin and floor rewards together, not monster drops, and not first clears', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(1000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: { cf: 300, ch: 300, cr: 300, df: [9999], dh: [9999] } },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: { dd: { ...dungeons().dd, firstClearGold: 999999, firstClearRewards: [{ itemId: 'gem', chance: 1, minQty: 999, maxQty: 999 }] } }, items } });
    const [c] = soloGoldCases(d);
    expect(c.gold.goldPerHour[0]).toBeCloseTo(300 + 500);
    expect(c.gold.dropsPerHour[0]).toBeCloseTo(9999);
    expect(c.ratio).toBeCloseTo(0.8);
  });

  it('leaves a dungeon alone that a lone player can\'t enter, and reports it under Gold', () => {
    const party = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100) },
      { table: 0, comp: 'K+P', level: 5, win: 100, xp: [50, 50], g: coinOf(50, 2) },
      { table: 1, comp: 'K', level: 5, win: 0, xp: [0], ineligible: 'door' },
      { table: 1, comp: 'K+P', level: 5, win: 100, xp: [1, 1], xpf: [1, 1], ms: floorMs, g: coinOf(0, 2) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    const metric = metricI16(party);
    expect(metric.values!.cases).toBe(0);
    expect(metric.values!.dungeons).toBe(0);
    expect(metric.pass).toBeNull();
    const gold = metricGold(party);
    expect(gold.pass).toBeNull();
    const text = gold.lines.join('\n');
    expect(text).toContain('Party-only dungeon loops');
    expect(text).toContain('| Door | L5+ | 1 | 500 |');
  });

  describe('runs that don\'t clear', () => {
    const lowClear = (win: number, roomCoin = 1): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(roomCoin) },
      { table: 1, comp: 'K', level: 5, win, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });

    it('fails a loop that pays well without clearing, so pushing clears under a line can\'t hide it', () => {
      const metric = metricI16(lowClear(89));
      expect(metric.pass).toBe(false);
      expect(metric.values!.cases).toBe(1);
      expect(metric.values!.clearingCases).toBe(0);
      expect(metric.values!.overWithoutClearing).toBe(1);
      expect(metric.values!.worst).toBeCloseTo(0.89 * 500);
    });

    it('still passes one paying under the line', () => {
      expect(metricI16(lowClear(25, 10000)).pass).toBe(true);
    });

    it('reads n/a when one player can enter but nobody wins a floor, and the card warns, rather than passing', () => {
      const d = lowClear(0);
      const metric = metricI16(d);
      expect(metric.values!.cases).toBe(0);
      expect(metric.values!.dungeons).toBe(1);
      expect(metric.pass).toBeNull();
      expect(metric.lines.join('\n')).toContain('no class wins even their first floor');
      expect(sanityWarnings(d, [metric]).join()).toContain('I16');
    });

    it('prints the full clears on their own, so the verdict can be read against the narrower line', () => {
      const metric = metricI16(lowClear(100));
      expect(metric.values!.clearingCases).toBe(1);
      expect(metric.values!.clearingOverBeyondNoise).toBe(1);
      expect(metric.magnitude).toContain('Full clears by loops clearing at least 90 % alone: 1/1');
    });
  });

  describe('runs that walk out early', () => {
    const floors = {
      dd: { id: 'dd', name: 'Door', entryRequirements: { minLevel: 5 }, floors: [{ rewards: [{ itemId: 'gem', chance: 1, minQty: 5, maxQty: 5 }], encounterTable: [] }, { rewards: [], encounterTable: [] }] },
    };
    const twoFloors = (plan?: XpPlan): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(500) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: 9 * HOUR, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable, { ...floorTable, floorIndex: 1 }], content: { dungeons: floors, items }, plan });

    it('reads the richest place to leave: a floor that pays and a slow one that doesn\'t can\'t hide behind a full clear', () => {
      const [c] = soloGoldCases(twoFloors());
      expect(c.gold.goldPerHour[0]).toBeCloseTo(50, 0);
      expect(c.stop.floors).toBe(1);
      expect(c.stop.perHour).toBeCloseTo(500);
      expect(c.ratio).toBeCloseTo(1);
    });

    it('fails on a stop paying over the line where the full clear doesn\'t, and counts it apart', () => {
      const [c] = soloGoldCases(twoFloors());
      expect(c.fullRatio).toBeLessThan(1);
      const richer = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
        { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: 99 * HOUR, g: coinOf(0) },
      ], { rooms: [[5, 0]], extraTables: [floorTable, { ...floorTable, floorIndex: 1 }], content: { dungeons: floors, items } });
      const metric = metricI16(richer);
      expect(metric.pass).toBe(false);
      expect(metric.values!.overOnlyStoppingEarly).toBe(1);
      expect(metric.values!.clearingOverBeyondNoise).toBe(0);
      expect(metric.lines.join('\n')).toContain('1 of 2');
    });

    it('cuts a stopped run by a rule\'s factors as well', () => {
      const plan: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.5, repeatRewardFactor: 0.1 } } };
      expect(soloGoldCases(twoFloors(plan))[0].stop.perHour).toBeCloseTo(50);
    });

    it('reads the full run on a tie, and the same figure the full loop does', () => {
      const [c] = soloGoldCases(world(100));
      expect(c.stop.floors).toBe(1);
      expect(c.stop.perHour).toBeCloseTo(c.gold.goldPerHour[0]);
      expect(c.stop.runMs).toBeCloseTo(c.gold.runMs);
    });
  });

  describe('a plan can\'t lift its own yardstick', () => {
    const paying = (ch: number, atlasCh: number): CellGold => ({ ...coinOf(ch), atlas: { ch: atlasCh, df: [0] } });
    const raised = (roomCoin: number, atlasCoin: number, other?: [number, number]): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: paying(roomCoin, atlasCoin) },
      ...(other ? [{ table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: paying(other[0], other[1]) }] : []),
      { table: other ? 2 : 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: paying(0, 0) },
    ], { rooms: other ? [[5, 0], [5, 0]] : [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });

    it('fails a plan raising a room\'s coin past what the atlas pays, with the dungeon untouched', () => {
      const metric = metricI16(raised(100000, 100));
      expect(metric.pass).toBe(false);
      expect(metric.values!.worst).toBeCloseTo(5);
      expect(soloGoldCases(raised(100000, 100))[0].roomCoin).toBe(100);
    });

    it('takes the lower when a plan cuts the room', () => {
      expect(soloGoldCases(raised(100, 100000))[0].roomCoin).toBe(100);
    });

    it('lets a raised room stand in for a cut one, up to the atlas\'s richest, since a line that low is still honest', () => {
      const [c] = soloGoldCases(raised(1000, 100, [0, 2000]));
      expect(c.roomCoin).toBe(1000);
      expect(soloGoldCases(raised(5000, 100, [0, 2000]))[0].roomCoin).toBe(2000);
    });

    it('holds boss rooms in the reported column the same way', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: paying(100, 100) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: paying(100000, 200) },
        { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: paying(0, 0) },
      ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
      d.meta.tables[1].boss = true;
      expect(soloGoldCases(d)[0].anyRoomRatio).toBeCloseTo(2.5);
    });

    it('takes fresh reads of rooms that could really be the yardstick, not rooms only the plan raised', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: paying(490, 490) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: paying(100000, 1) },
        { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: paying(0, 0) },
      ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
      expect(goldLookCells(d).sort()).toEqual([0, 2]);
    });
  });

  describe('gold moved into monster drops', () => {
    const withDrops = (plan: number, atlas: number): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(10000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: { ...coinOf(0), df: [plan], dh: [plan], atlas: { ch: 0, df: [atlas] } } },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });

    it('fails a plan raising a lone loop\'s drops past the line, and only then', () => {
      const moved = metricI16(withDrops(1000, 100));
      expect(moved.pass).toBe(false);
      expect(moved.values!.dropsRaised).toBe(1);
      expect(moved.values!.overBeyondNoise).toBe(0);
      expect(moved.magnitude).toContain('raised monster drops');
      expect(metricI16(withDrops(125, 100)).pass).toBe(true);
      expect(metricI16(withDrops(50, 100)).pass).toBe(true);
    });

    it('fails drops raised from nothing', () => {
      expect(metricI16(withDrops(1, 0)).values!.dropsRaised).toBe(1);
    });

    it('reads a loop\'s drops as they stand on a run with no retune', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(10000) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: { ...coinOf(0), df: [99999], dh: [99999] } },
      ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
      expect(metricI16(d).values!.dropsRaised).toBe(0);
    });
  });

  describe('nothing against nothing', () => {
    it('reads n/a and warns when no case has anything to measure, however many there are', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(0) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
      ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons([]), items } });
      const metric = metricI16(d);
      expect(metric.values!.cases).toBe(1);
      expect(metric.values!.nothingAgainstNothing).toBe(1);
      expect(metric.pass).toBeNull();
      expect(metric.magnitude).toContain('measure nothing');
      expect(sanityWarnings(d, [metric]).join()).toContain('I16');
    });

    it('passes a dungeon cut to nothing while its rooms still pay', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(50) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
      ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons([]), items } });
      expect(metricI16(d).pass).toBe(true);
    });

    it('still fails on any case over the line, whatever else measures nothing', () => {
      const metric = metricI16(world(100));
      expect(metric.values!.nothingAgainstNothing).toBe(0);
      expect(metric.pass).toBe(false);
    });
  });

  describe('the card\'s other readings, none of which judges', () => {
    const quick = (roomCoin: number): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(roomCoin) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: 5000, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons([{ itemId: 'gem', chance: 1, minQty: 1, maxQty: 1 }]), items } });
    // 100 gold a run: at 15 s + 1.8 s + 5 s that is 16,514/hr, at 5 s 30,000/hr, at 30 s about 9,890/hr.

    it('prints the verdict at other re-entry waits, since nothing in the game sets one', () => {
      const metric = metricI16(quick(16000));
      expect(metric.pass).toBe(true);
      expect(metric.values!.overAtReentry5s).toBe(1);
      expect(metric.values!.overAtReentry30s).toBe(0);
      expect(metric.magnitude).toContain('at 5 s and 30 s to re-enter 1 and 0');
      expect(metric.lines.join('\n')).toContain('The game has no re-entry cooldown');
    });

    it('reads a wait\'s swing in both directions', () => {
      const metric = metricI16(quick(12000));
      expect(metric.pass).toBe(false);
      expect(metric.values!.overAtReentry30s).toBe(0);
    });

    it('prints monster drops counted, and a harder line, beside the verdict', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [1], g: { ...coinOf(1000), dh: [9000] } },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100) },
        { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: { ...coinOf(500), df: [1000], dh: [1000] } },
      ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons([]), items } });
      const metric = metricI16(d);
      expect(metric.pass).toBe(true);
      expect(metric.values!.overWithDropsInLoop).toBe(1);
      expect(metric.values!.overWithDropsBothSides).toBe(0);
      expect(metric.values!.overStrictLine).toBe(1);
      expect(metric.lines.join('\n')).toContain('Monster drops counted on both sides');
    });

    it('reports parties in the same dungeons and says the rule\'s reach is a design choice, without judging them', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(10000) },
        { table: 0, comp: 'K+P', level: 5, win: 100, xp: [50, 50], g: coinOf(100, 2) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
        { table: 1, comp: 'K+P', level: 5, win: 100, xp: [10, 10], xpf: [10, 10], ms: floorMs, g: coinOf(0, 2) },
      ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
      const metric = metricI16(d);
      expect(metric.pass).toBe(true);
      expect(metric.values!.partyPairs).toBe(1);
      expect(metric.values!.partyPairsOver).toBe(1);
      expect(metric.lines.join('\n')).toContain('a design choice');
    });

    it('prints a capped run per hour spent in the dungeon, since the day\'s reading dilutes it', () => {
      const plan: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonClearsPerDay: 1 } };
      const metric = metricI16(world(100, 0, { plan }));
      expect(metric.lines.join('\n')).toContain('Per hour spent in the dungeon instead, 1 of 1');
      expect(metricI16(world(100)).lines.join('\n')).not.toContain('Per hour spent in the dungeon');
    });
  });

  describe('warnings a plan earns', () => {
    const atlasRead = (ch: number, atlasCh: number): CellGold => ({ ...coinOf(ch), atlas: { ch: atlasCh, df: [0] } });
    const monster = (id: string, gold: number, tier = 'normal') => ({ id, name: id, hp: 1, damage: 1, xp: 1, tier, goldMin: gold, goldMax: gold });
    const retuned = (monsters: Record<string, unknown>, baseMonsters: Record<string, unknown>, extraItems: Record<string, unknown> = items, room: [number, number] = [100, 100]): Data => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: atlasRead(...room) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: atlasRead(0, 0) },
      ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items: extraItems, monsters } });
      d.baseContent = { dungeons: dungeons(), items, monsters: baseMonsters, shops: {} } as unknown as XpSnapshot;
      return d;
    };

    it('warns on coin raised past the line, naming how many are bosses, and is quiet under it', () => {
      const up = sanityWarnings(retuned({ a: monster('a', 100), b: monster('b', 100, 'boss') }, { a: monster('a', 10), b: monster('b', 10, 'boss') }), []).join();
      expect(up).toContain('on 2 monsters, 1 of them bosses');
      const near = sanityWarnings(retuned({ a: monster('a', 12) }, { a: monster('a', 10) }), []).join();
      expect(near).not.toContain('atlas\'s coin on');
    });

    it('warns on an item\'s sale value raised', () => {
      expect(sanityWarnings(retuned({}, {}, { ...items, gem: { ...items.gem, value: 101 } }), []).join()).toContain('raises the sale value of 1 items');
      expect(sanityWarnings(retuned({}, {}, { ...items, gem: { ...items.gem, value: 99 } }), []).join()).not.toContain('raises the sale value');
    });

    it('warns when rooms pay far from what the atlas does, up or down', () => {
      expect(sanityWarnings(retuned({}, {}, items, [1, 100]), []).join()).toContain('the atlas\'s coin, outside');
      expect(sanityWarnings(retuned({}, {}, items, [1000, 100]), []).join()).toContain('the atlas\'s coin, outside');
      expect(sanityWarnings(retuned({}, {}, items, [100, 100]), []).join()).not.toContain('the atlas\'s coin, outside');
    });

    it('warns when a retuned run holds no read of the atlas, since its yardstick then can\'t be held', () => {
      const d = world(100);
      d.baseContent = d.content;
      expect(sanityWarnings(d, []).join()).toContain('evaluate the plan again');
      expect(sanityWarnings(world(100), []).join()).not.toContain('evaluate the plan again');
    });

    it('warns on a clear cap paying more full clears than a weekly rule may, unless a rule cuts their gold', () => {
      const capped = (bossPolicy: Record<string, unknown>): string => sanityWarnings(world(100, 0, { plan: { id: 'p', describe: '', payout: () => 0, bossPolicy } }), []).join();
      expect(capped({ dungeonClearsPerDay: 1 })).toContain('pays 7 clears a week in full');
      expect(capped({ dungeonClearsPerDay: 0.25 })).not.toContain('clears a week in full');
      expect(capped({ dungeonClearsPerDay: 1, dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.5, repeatCoinFactor: 0.5, repeatRewardFactor: 0.5 } })).not.toContain('clears a week in full');
    });
  });

  describe('gear a plan leaves with no source', () => {
    const blade = { id: 'blade', name: 'Blade', equipSlot: 'mainhand', value: 0 };
    const floorWith = (chance: number) => ({ dd: { id: 'dd', name: 'Door', entryRequirements: { minLevel: 5 }, floors: [{ rewards: [{ itemId: 'blade', chance }, { itemId: 'gem', chance: 0 }], encounterTable: [] }] } });
    const setup = (chance: number, extra: Record<string, unknown> = {}, plan?: XpPlan): Data => {
      const d = world(100, 0, { plan, content: { dungeons: floorWith(chance), items, ...extra } });
      d.baseContent = { dungeons: floorWith(1), items, monsters: {}, shops: {} } as unknown as XpSnapshot;
      return d;
    };
    const rule = (fullClearsPerWeek: number, repeatRewardFactor: number): XpPlan => ({ id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek, repeatFactor: 0.5, repeatRewardFactor } } });

    it('names a piece whose only source a plan cut, warns, and judges nothing', () => {
      const d = setup(0);
      expect(gearWithNoSource(d)).toEqual([blade.name]);
      expect(sanityWarnings(d, []).join()).toContain('1 pieces of gear with no source anywhere: Blade');
      expect(metricGold(d).values!.gearWithNoSource).toBe(1);
      expect(metricGold(d).lines.join('\n')).toContain('Gear this plan leaves with no source');
    });

    it.each([
      ['a shop', { shops: { s: { id: 's', inventory: [{ itemId: 'blade', price: 5 }] } } }],
      ['a recipe', { recipes: { r: { id: 'r', result: { itemId: 'blade', quantity: 1 }, ingredients: [] } } }],
      ['a monster', { monsters: { m: { id: 'm', drops: [{ itemId: 'blade', chance: 0.1 }] } } }],
      ['a quest', { quests: { q: { id: 'q', rewards: [{ kind: 'item', itemId: 'blade' }] } } }],
    ])('counts %s as a source', (_name, extra) => {
      expect(gearWithNoSource(setup(0, extra))).toEqual([]);
    });

    it('counts a first clear as a source', () => {
      const dungeons = floorWith(0) as any;
      dungeons.dd.firstClearRewards = [{ itemId: 'blade', chance: 1 }];
      expect(gearWithNoSource(setup(0, { dungeons }))).toEqual([]);
    });

    it('reads a rule: a week\'s full clear is a source, a repeat factor of nothing with none isn\'t', () => {
      expect(gearWithNoSource(setup(1, {}, rule(1, 0)))).toEqual([]);
      expect(gearWithNoSource(setup(1, {}, rule(0, 0.5)))).toEqual([]);
      expect(gearWithNoSource(setup(1, {}, rule(0, 0)))).toEqual([blade.name]);
    });

    it('doesn\'t name gear the atlas never handed out on a floor', () => {
      const d = world(100, 0, { content: { dungeons: floorWith(0), items } });
      expect(gearWithNoSource(d)).toEqual([]);
    });
  });

  it('keeps boss rooms and dungeon floors out of the yardstick, and reports what boss rooms would do', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100000) },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    d.meta.tables[1].boss = true;
    const metric = metricI16(d);
    expect(metric.pass).toBe(false);
    expect(metric.values!.overBeyondNoiseWithBossRooms).toBe(0);
    expect(metric.lines.join('\n')).toContain('Boss rooms are out of the yardstick');
  });

  it('counts a room paying no XP if it pays coin, and reads the win line on the plan\'s side', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [0], g: coinOf(100000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(1) },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    expect(metricI16(d).pass).toBe(true);
    const onLine = miniData([
      { table: 0, comp: 'K', level: 5, win: 89, fresh: 400, xp: [100], g: coinOf(1000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    expect(metricI16(onLine).pass).toBe(true);
    const lost = miniData([
      { table: 0, comp: 'K', level: 5, win: 50, fresh: 400, xp: [100], g: coinOf(1000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    expect(metricI16(lost).values!.worst).toBe(Infinity);
  });

  it('prints the room they\'d stand in for XP, the best party\'s gold room, and the lower lines beside the verdict, none of which judge', () => {
    const d = miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [10], g: coinOf(2000) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(100) },
      { table: 0, comp: 'K+P', level: 5, win: 100, xp: [10, 10], g: coinOf(1000, 2) },
      { table: 2, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0], [5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });
    const metric = metricI16(d);
    expect(metric.pass).toBe(true);
    expect(metric.values!.medianRatio).toBeCloseTo(0.25);
    expect(metric.values!.medianAgainstXpRoom).toBeCloseTo(5);
    expect(metric.values!.medianAgainstPartyRoom).toBeCloseTo(0.5);
    expect(metric.values!.overHalf).toBe(0);
    expect(metric.values!.overQuarter).toBe(0);
    const text = metric.lines.join('\n');
    expect(text).toContain('Adjustable numbers and choices');
    expect(text).toContain('Why the richest room is a poor yardstick');
    expect(text).toContain('L5 20.00x');
  });

  it('reads n/a on a run with no gold, which the card warns about, instead of passing', () => {
    const d = miniData([{ table: 0, comp: 'K', level: 5, win: 100, xp: [100] }]);
    const metric = metricI16(d);
    expect(metric.pass).toBeNull();
    expect(metric.magnitude).toContain('evaluate the plan again');
    expect(sanityWarnings(d, [metric]).join()).toContain('I16');
  });

  describe('a plan\'s hooks', () => {
    const rulePlan = (rule: Record<string, number>): XpPlan => ({ id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.1, ...rule } } });

    it('cuts coin and floor rewards apart, with the first clear each week as a lump', () => {
      const plan = rulePlan({ repeatCoinFactor: 0.5, repeatRewardFactor: 0.1 });
      const d = world(100, 300, { plan });
      const [c] = soloGoldCases(d);
      expect(c.gold.goldPerHour[0]).toBeCloseTo(300 * 0.5 + 500 * 0.1);
      expect(c.gold.fullPerHour[0]).toBeCloseTo(800);
      expect(c.gold.weeklyLump).toBeCloseTo(800 - 200);
      expect(metricI16(d).values!.worst).toBeCloseTo(2);
    });

    it('leaves gold whole when a rule only cuts XP, and warns, since that is the default', () => {
      const d = world(100, 300, { plan: rulePlan({}) });
      expect(metricI16(d).values!.worst).toBeCloseTo(8);
      expect(sanityWarnings(d, []).join()).toContain('leaves coin and floor rewards in full');
      const said = world(100, 300, { plan: rulePlan({ repeatCoinFactor: 1, repeatRewardFactor: 1 }) });
      expect(sanityWarnings(said, []).join()).not.toContain('leaves coin and floor rewards in full');
    });

    it('scopes the same way the XP rule does', () => {
      const scoped: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: weeklyRuleForSoloDungeons(0.1, 1, { coin: 0, rewards: 0.1 }) } };
      expect(metricI16(world(100, 300, { plan: scoped })).values!.worst).toBeCloseTo(0.5);
      expect(weeklyRuleFor(scoped.bossPolicy as never, 'dd', true)).toEqual({ fullClearsPerWeek: 1, repeatFactor: 0.1, repeatCoinFactor: 0, repeatRewardFactor: 0.1 });
      expect(weeklyRuleFor(scoped.bossPolicy as never, 'dd', false)).toBeUndefined();
      expect(weeklyRuleForSoloDungeons(0.1)('d', true)).toEqual({ fullClearsPerWeek: 1, repeatFactor: 0.1 });
    });

    it('refuses factors out of bounds, and lets gold reach zero where XP can\'t', () => {
      expect(() => assertWeeklyRule({ fullClearsPerWeek: 1, repeatFactor: 0.1, repeatCoinFactor: 0, repeatRewardFactor: 0 }, 'd')).not.toThrow();
      expect(() => assertWeeklyRule({ fullClearsPerWeek: 1, repeatFactor: 0.1, repeatCoinFactor: -0.1 }, 'd')).toThrow(/repeatCoinFactor/);
      expect(() => assertWeeklyRule({ fullClearsPerWeek: 1, repeatFactor: 0.1, repeatRewardFactor: 1.5 }, 'd')).toThrow(/repeatRewardFactor/);
      expect(() => assertWeeklyRule({ fullClearsPerWeek: 1, repeatFactor: 0.1, repeatRewardFactor: NaN }, 'd')).toThrow(/repeatRewardFactor/);
    });

    it('catches a plain policy holding a gold factor\'s old value past --param', () => {
      const params = { coin: 0.5 };
      const trap: XpPlan = { id: 'p', describe: '', params, payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.1, repeatCoinFactor: params.coin } } };
      expect(() => assertParamsReachPolicy(trap, { coin: 0.5 }, { coin: 0.25 })).toThrow(/old value/);
    });

    it('reads retuned content: coin in the rates, floor rewards and item values off the plan\'s snapshot', () => {
      const cheap = { ...items, gem: { ...items.gem, value: 10 } };
      expect(metricI16(world(100, 0, { content: { dungeons: dungeons(), items: cheap } })).values!.worst).toBeCloseTo(0.5);
      const rarer = dungeons([{ itemId: 'gem', chance: 0.1, minQty: 5, maxQty: 5 }]);
      expect(metricI16(world(100, 0, { content: { dungeons: rarer, items } })).values!.worst).toBeCloseTo(0.5);
    });
  });

  describe('dungeon-only materials under a cut', () => {
    const recipes = { r: { id: 'r', requiredLevel: 5, ingredients: [{ itemId: 'deep', quantity: 2 }], result: { itemId: 'blade', quantity: 1 } } };
    const deepFloor = (chance: number) => ({ dd: { id: 'dd', name: 'Door', entryRequirements: { minLevel: 5 }, floors: [{ rewards: [{ itemId: 'deep', chance, minQty: 1, maxQty: 1 }], encounterTable: [] }] } });
    const setup = (extra: Partial<MiniOptions>, chance = 1): Data => world(1000, 0, { content: { dungeons: deepFloor(chance), items, recipes }, ...extra });
    const row = (d: Data): string => metricGold(d).lines.find(l => l.startsWith('| Deep |'))!;

    const rule = (fullClearsPerWeek: number, repeatRewardFactor: number, repeatFactor = 0.5): XpPlan => ({ id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek, repeatFactor, repeatRewardFactor } } });

    it('reports hours per craft before and after a rule\'s reward factor', () => {
      expect(row(setup({}))).toContain('| 2.0 | 2.0 |');
      const cut = setup({ plan: rule(0, 0.1) });
      expect(row(cut)).toContain('| 2.0 | 20.0 |');
      expect(metricI15(cut).lines.join('\n')).toContain('Deep');
    });

    it('adds the week\'s full clears to the repeat rate', () => {
      expect(row(setup({ plan: rule(1, 0.1) }))).toContain('| 2.0 | 19.0 |');
    });

    it('reads a week\'s full clear as a source: slow to come, little XP given up, and not cut to nothing', () => {
      const weeklyOnly = setup({ plan: rule(1, 0) });
      expect(row(weeklyOnly)).toContain(`| 2.0 | ${(2 * 168).toFixed(1)} |`);
      const metric = metricI15(weeklyOnly);
      expect(metric.values!.cutToNothing).toBe(0);
      expect(metric.values!.stranded).toBe(0);
      expect(metric.values!.medianHoursPerCraft).toBeCloseTo(2 * 168);
      expect(metric.values!.medianGivenUp).toBeLessThanOrEqual(2);
      expect(metric.pass).toBe(true);
    });

    it('charges XP given up for time in the dungeon, not for the wait between full clears', () => {
      const lowPay = setup({ plan: rule(1, 0, 0.0001) });
      const metric = metricI15(lowPay);
      expect(metric.values!.medianGivenUp).toBeLessThanOrEqual(2);
    });

    it('fails a material far too slow to count as obtainable, as a tiny chance would leave it, though nothing is cut to nothing', () => {
      const tiny = setup({ plan: rule(0, 1e-6, 1) });
      const metric = metricI15(tiny);
      expect(metric.values!.cutToNothing).toBe(0);
      expect(metric.values!.stranded).toBe(1);
      expect(metric.values!.medianHit).toBeNaN();
      expect(metric.pass).toBe(false);
      expect(metric.magnitude).toContain('taking over 672 hours per craft');
    });

    it('fails the same cut made by content, and leaves it alone with a full clear a week at an honest chance', () => {
      const byContent = setup({}, 1e-6);
      byContent.baseContent = { dungeons: deepFloor(1), items, recipes, monsters: {}, shops: {} } as unknown as XpSnapshot;
      expect(metricI15(byContent).values!.stranded).toBe(1);
      expect(metricI15(setup({ plan: rule(1, 1e-6, 1) })).values!.stranded).toBe(0);
    });

    it('reads a clear cap: fewer paid clears a day take longer to craft, and cost only the time spent', () => {
      const cap = (bossPolicy: Record<string, unknown>): Data => setup({ plan: { id: 'p', describe: '', payout: () => 0, bossPolicy } });
      expect(row(cap({ dungeonClearsPerDay: 2 }))).toContain('| 2.0 | 24.0 |');
      expect(metricI15(cap({ dungeonClearsPerDay: 2 })).values!.medianGivenUp).toBeLessThanOrEqual(2);
      expect(paidRunsPerHour(3_600_000, 50, 12)).toBeCloseTo(1);
      expect(paidRunsPerHour(3_600_000, 50, 6)).toBeCloseTo(0.5);
      expect(paidRunsPerHour(3_600_000, 0, 1)).toBeCloseTo(1);
    });

    it('reports hours per craft before and after a retuned chance', () => {
      const d = setup({}, 0.5);
      d.baseContent = { dungeons: deepFloor(1), items, recipes, monsters: {}, shops: {} } as unknown as XpSnapshot;
      expect(row(d)).toContain('| 2.0 | 4.0 |');
    });

    it('fails I15 when a plan cuts a dungeon-only material to nothing, and shows it, since they must stay obtainable', () => {
      const cut = setup({ plan: rule(0, 0) });
      const metric = metricI15(cut);
      expect(metric.pass).toBe(false);
      expect(metric.values!.cutToNothing).toBe(1);
      expect(metric.magnitude).toContain('cut to nothing');
      expect(row(cut)).toContain('cut to nothing');
      const byContent = setup({}, 0);
      byContent.baseContent = { dungeons: deepFloor(1), items, recipes, monsters: {}, shops: {} } as unknown as XpSnapshot;
      expect(metricI15(byContent).values!.cutToNothing).toBe(1);
    });

    it('doesn\'t call a material written at chance 0 cut, since no plan did that', () => {
      expect(metricI15(setup({}, 0)).values!.cutToNothing).toBe(0);
    });
  });

  describe('the Gold section', () => {
    it('says what it doesn\'t model', () => {
      const text = metricGold(world(100)).lines.join('\n');
      for (const phrase of ['crafted income', 'trading', 'what gear costs']) expect(text).toContain(phrase);
      expect(metricGold(world(100)).magnitude).toContain('Not modelled: crafted income, trading, gear prices');
    });

    it('reads each layout\'s richest room against its best XP room, boss rooms in a column apart', () => {
      const d = miniData([
        { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(50) },
        { table: 1, comp: 'K', level: 5, win: 100, xp: [10], g: coinOf(500) },
        { table: 2, comp: 'K', level: 5, win: 100, xp: [10], g: coinOf(1000) },
      ], { rooms: [[5, 0], [3, 0], [3, 0]], content: { dungeons: {}, items } });
      d.meta.tables[2].boss = true;
      const row = metricGold(d).lines.find(l => l.startsWith('| 5 | 1 |'))!;
      expect(row).toContain('| 20.00x |');
      expect(row).toContain('| 10.00x |');
      expect(row).toContain('| 100 % |');
      expect(row).toContain('| 90 % |');
    });

    it('prints what a rule leaves, and says so when there is none', () => {
      expect(metricGold(world(100)).lines.join('\n')).toContain('no dungeon rule');
      const plan: XpPlan = { id: 'p', describe: '', payout: () => 0, bossPolicy: { dungeonWeekly: { fullClearsPerWeek: 1, repeatFactor: 0.25, repeatCoinFactor: 0.5, repeatRewardFactor: 0.1 } } };
      const text = metricGold(world(100, 100, { plan })).lines.join('\n');
      expect(text).toContain('1 full a week; XP x0.25, coin x0.5, rewards x0.1');
    });

    it('prints how much of a clear\'s reward value is gear, so a plan can cut that and leave materials', () => {
      const content = { items: { ...items, sword: { id: 'sword', equipSlot: 'mainhand', value: 900 } }, dungeons: { dd: { id: 'dd', floors: [{ rewards: [{ itemId: 'gem', chance: 1 }, { itemId: 'sword', chance: 1, classRestriction: ['Knight'] }] }] } } } as unknown as XpSnapshot;
      expect(gearShareOfRewards(content, 'dd')).toBeCloseTo(0.9);
      expect(gearShareOfRewards(content, 'gone')).toBe(0);
    });
  });

  describe('its own fresh reads', () => {
    const near = (): Data => miniData([
      { table: 0, comp: 'K', level: 5, win: 100, xp: [100], g: coinOf(490) },
      { table: 1, comp: 'K', level: 5, win: 100, xp: [10], xpf: [10], ms: floorMs, g: coinOf(0) },
    ], { rooms: [[5, 0]], extraTables: [floorTable], content: { dungeons: dungeons(), items } });

    it('reads cases near the line, their floors and rivals, and none far from it', () => {
      expect(goldLookCells(near()).sort()).toEqual([0, 1]);
      expect(goldLookCells(world(100000))).toEqual([]);
      expect(goldLookCells(world(1))).toEqual([]);
    });

    it('moves I16 and nothing else', () => {
      const d = near();
      const before = metricI10(d).values!.worstSoloLoop;
      const room = d.get(0, 'K', 5)!;
      d.goldSecond.set(room.cell.id, { ...room.rate, g: coinOf(100) });
      d.goldLook = { cells: 1, fights: 400, simulatedCells: 1 };
      expect(metricI16(d).pass).toBe(false);
      expect(metricI16(d).lines.join('\n')).toContain('a fresh read of 400 fights');
      expect(metricI10(d).values!.worstSoloLoop).toBe(before);
      expect(d.rawRates().find(r => r.c === room.cell.id)!.g!.ch).toBe(490);
      expect(d.second.size).toBe(0);
    });
  });
});

describe('leaderboard', () => {
  const card = (title: string, pass: boolean | null, short?: string, values?: Record<string, number | null>) => ({ title, metrics: [{ id: 'I1', title: 'Best room', pass, magnitude: 'a long magnitude that goes on and on and on, far past what fits in a cell of any table at all', short, values }, { id: 'I13', title: 'Bards', pass: null, magnitude: 'reported', short: 'r' }] });

  it('prints a plan by metric table with verdicts and short magnitudes', () => {
    const md = renderLeaderboard([card('a (b=1)', false, '3/10'), card('c', true, '0/10')], false);
    expect(md).toContain('| metric | a (b=1) | c |');
    expect(md).toContain('| I1 Best room | FAIL: 3/10 | PASS: 0/10 |');
    expect(md).toContain('| I13 Bards | n/a: r | n/a: r |');
    expect(md).toContain('| fails | 1/1 | 0/1 |');
  });

  it('shortens an older card\'s magnitude, and shows a gap where a metric is missing', () => {
    const md = renderLeaderboard([card('old', false), { title: 'new', metrics: [] }], false);
    expect(md).toContain('FAIL: a long magnitude');
    expect(md).toContain('...');
    expect(md).toContain('| - |');
  });

  it('compares numbers per metric on request', () => {
    const md = renderLeaderboard([card('a', false, 's', { pairs: 10, worst: null }), card('b', true, 's', { pairs: 12.34567 })], true);
    expect(md).toContain('## I1 Best room');
    expect(md).toContain('| pairs | 10 | 12.346 |');
    expect(md).toContain('| worst | - | - |');
  });

  it('shows warnings, whether picks were re-sampled, and scored metrics that read n/a', () => {
    const broken = { title: 'broken', warnings: ['pays nothing here'], resampledAt: 0, metrics: [{ id: 'I1', title: 't', pass: null, scored: true, magnitude: 'm' }, { id: 'I2', title: 't', pass: false, scored: true, magnitude: 'm' }, { id: 'I13', title: 't', pass: null, scored: false, magnitude: 'r' }] };
    const fine = { title: 'fine', warnings: [], resampledAt: 400, metrics: [{ id: 'I1', title: 't', pass: true, scored: true, magnitude: 'm' }] };
    const md = renderLeaderboard([broken, fine], false);
    expect(md).toContain('| fails | 1/1 (1 n/a) | 0/1 |');
    expect(md).toContain('| warnings | 1: pays nothing here | none |');
    expect(md).toContain('| verdict picks re-sampled | no, first reads | at 400 fights |');
    const older = renderLeaderboard([{ title: 'old', metrics: [] }], false);
    expect(older).toContain('| warnings | - |');
  });

  it('reads a run\'s scorecard.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-board-'));
    try {
      writeFileSync(join(dir, 'scorecard.json'), JSON.stringify({ plan: 'p', metrics: [{ id: 'I1', title: 't', pass: true, magnitude: 'm' }] }));
      expect(readCard(dir).title).toBe('p');
      writeFileSync(join(dir, 'scorecard.json'), JSON.stringify({ plan: 'p', title: 'p (b=1)', metrics: [] }));
      expect(readCard(dir).title).toBe('p (b=1)');
      expect(readCards([dir, dir])[0].title).toContain('p (b=1) [');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rework', () => {
  const snapshot = (): Record<string, any> => ({
    monsters: { a: { id: 'a', hp: 10, damage: 2, abilities: [{ power: 1 }, { power: 2 }] }, b: { id: 'b', hp: 20, damage: 3 } },
    items: { i: { id: 'i', value: 1 } },
    world: { defaultMapId: 'm', maps: [{ id: 'm', name: 'M' }], tiles: [{ id: 't1', zone: 'z', mapId: 'm' }, { id: 't2', zone: 'z', mapId: 'm' }] },
  });

  it('counts changes per section and field, and judges nothing', () => {
    const { after, changes } = applyRework(snapshot(), s => {
      s.monsters.a.hp = 11;
      s.monsters.a.abilities[1].power = 9;
      s.monsters.b.hp = 21;
      s.monsters.c = { id: 'c', hp: 1 };
      delete s.items.i;
      s.world.tiles[1].zone = 'y';
    });
    expect(after.monsters.a.hp).toBe(11);
    const of = (section: string) => changes.find(c => c.section === section)!;
    expect(of('monsters')).toEqual({ section: 'monsters', total: 3, added: 1, removed: 0, changed: 2, fields: { hp: 2, 'abilities[].power': 1 } });
    expect(of('items').removed).toBe(1);
    expect(of('world.tiles')).toEqual({ section: 'world.tiles', total: 2, added: 0, removed: 0, changed: 1, fields: { zone: 1 } });
    expect(of('world.maps').changed).toBe(0);
    const md = renderChangeSummary('in.json', 'mod.ts', { sha1: 'abc', changes });
    expect(md).toContain('hp 2');
    expect(md).toContain('| monsters | 3 | 1 | 0 | 2 |');
    expect(md).not.toContain('world.maps');
  });

  it('takes a returned snapshot too, and refuses anything else', () => {
    const { after } = applyRework(snapshot(), s => ({ ...s, items: {} }));
    expect(after.items).toEqual({});
    expect(() => applyRework(snapshot(), () => 5)).toThrow(/return the snapshot/);
  });

  it('reports no change as no change', () => {
    const before = snapshot();
    const changes = changeSummary(before, JSON.parse(JSON.stringify(before)));
    expect(changes.every(c => !c.added && !c.removed && !c.changed)).toBe(true);
    expect(renderChangeSummary('in', 'mod', { sha1: 'a', changes })).toContain('Nothing changed');
  });

  it('loads a module from any path, its own imports included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xp-rework-'));
    try {
      mkdirSync(join(dir, 'parts'));
      writeFileSync(join(dir, 'parts', 'factor.mjs'), 'export const FACTOR = 3;');
      writeFileSync(join(dir, 'tiny.mjs'), 'import { FACTOR } from "./parts/factor.mjs"; export function rework(s) { s.monsters.a.hp *= FACTOR; return s; }');
      const fn = await loadRework(join(dir, 'tiny.mjs'));
      expect((fn(snapshot()) as any).monsters.a.hp).toBe(30);
      writeFileSync(join(dir, 'none.mjs'), 'export const x = 1;');
      await expect(loadRework(join(dir, 'none.mjs'))).rejects.toThrow(/rework\(snapshot\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

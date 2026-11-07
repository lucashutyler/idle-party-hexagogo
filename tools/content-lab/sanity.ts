import type { Combatant, EngineAdapter } from './engines.js';
import { OLD_HORIZON_TICKS } from './engines.js';
import { hashSeed, makeRng } from './sim.js';
import { chooseLoadout, humanSeats } from './policy.js';
import type { ClassName, ContentSnapshot, EncounterEntry } from './types.js';

export interface SanityLine {
  name: string;
  expected: string;
  measured: string;
  ok: boolean;
}

const STARTER_GEAR = { bonusAttackMin: 3, bonusAttackMax: 10, damageReductionMin: 1, damageReductionMax: 8, magicReductionMin: 0, magicReductionMax: 0 };
const CHIEFTAIN_ENCOUNTER = 'goblin_chieftain_court';
const CHIEFTAIN_N = 200;
const TRASH_N = 200;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
}

/** The seed world, as `ContentStore` would serve it on first boot. */
function seedContent(mod: any): ContentSnapshot {
  return {
    monsters: mod.SEED_MONSTERS,
    items: {},
    zones: mod.SEED_ZONES,
    encounters: mod.SEED_ENCOUNTERS,
    sets: {},
    shops: {},
    henchmen: {},
    dungeons: mod.SEED_DUNGEONS,
    skills: mod.SEED_SKILLS,
    skillSlotSchedules: mod.SEED_SKILL_SLOT_SCHEDULES,
    world: { defaultMapId: '', maps: [], tiles: [] },
  };
}

/** Calibration's default loadout: the lowest-unlock skills per slot. */
function seedLoadout(content: ContentSnapshot, className: ClassName, level: number): (string | null)[] {
  const queues: Record<string, any[]> = { passive: [], active: [] };
  for (const skill of Object.values(content.skills) as any[]) {
    if (skill.className === className && typeof skill.unlockLevel === 'number' && skill.unlockLevel <= level) queues[skill.type]?.push(skill);
  }
  for (const q of Object.values(queues)) q.sort((a, b) => a.unlockLevel - b.unlockLevel || a.id.localeCompare(b.id));
  return content.skillSlotSchedules[className].map(slot => (slot.unlocksAtLevel > level ? null : queues[slot.type].shift()?.id ?? null));
}

function starterParty(engine: EngineAdapter, content: ContentSnapshot, classes: ClassName[], level: number): Combatant[] {
  return humanSeats(classes, false).map(spec => {
    const built = engine.buildHuman({ ...spec, level, equipment: {}, skillIds: seedLoadout(content, spec.className, level) }, content);
    built.equipBonuses = { ...STARTER_GEAR };
    return built;
  });
}

function runSeed(engine: EngineAdapter, content: ContentSnapshot, players: Combatant[], table: EncounterEntry[], n: number, label: string): { winPct: number; medianSec: number; stalematePct: number } {
  let wins = 0;
  let stalemates = 0;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const end = engine.fight({
      players,
      table,
      content,
      xpMultiplier: 1,
      humanCount: players.length,
      hireCount: 0,
      memberLevel: players[0].level,
      rng: makeRng(hashSeed(`sanity|${label}|${i}`)),
    });
    if (end.result === 'victory') {
      wins++;
      times.push(end.ms);
    } else if (end.result === 'stalemate') {
      stalemates++;
    }
  }
  return { winPct: (100 * wins) / n, medianSec: median(times) / 1000, stalematePct: (100 * stalemates) / n };
}

function chieftainLines(engine: EngineAdapter): SanityLine[] {
  const mod = engine.module;
  const content = seedContent(mod);
  const table = [{ encounterId: CHIEFTAIN_ENCOUNTER, weight: 1 }];
  const trio = runSeed(engine, content, starterParty(engine, content, ['Knight', 'Priest', 'Mage'], 6), table, CHIEFTAIN_N, 'chief-trio');
  const five = runSeed(engine, content, starterParty(engine, content, ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'], 6), table, CHIEFTAIN_N, 'chief-five');
  const solos = (['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] as ClassName[]).map(c => ({
    c,
    r: runSeed(engine, content, starterParty(engine, content, [c], 6), table, CHIEFTAIN_N, `chief-${c}`),
  }));
  const dungeon = mod.SEED_DUNGEONS.crystal_caves_trial;
  const bossRun = mod.runForecast(
    {
      kind: 'dungeon',
      players: starterParty(engine, content, ['Knight', 'Priest', 'Mage'], 6),
      pace: mod.COMBAT_PACE,
      dungeon,
      monsters: content.monsters,
      encounters: content.encounters,
      startFloorIndex: dungeon.floors.length - 1,
    },
    { key: 'content-lab-chieftain', maxSims: CHIEFTAIN_N, minSims: CHIEFTAIN_N },
  );
  return [
    {
      name: 'new: Goblin Chieftain floor, K+P+M L6, starter gear, one attempt (runForecast)',
      expected: 'within 10 points of the harness',
      measured: `${bossRun.winPct} % against ${trio.winPct.toFixed(1)} %`,
      ok: Math.abs(bossRun.winPct - trio.winPct) <= 10,
    },
    {
      name: 'new: Goblin Chieftain, K+P+M L6, starter gear, one attempt through the harness',
      expected: 'winning fights: median 6.3 min, on seed charge and recovery',
      measured: `${trio.winPct.toFixed(1)} % wins, median ${(trio.medianSec / 60).toFixed(2)} min`,
      ok: Math.abs(trio.medianSec / 60 - 6.3) <= 0.6,
    },
    {
      name: 'new: Goblin Chieftain, 5-class party L6, one attempt through the harness',
      expected: 'winning fights: median 2 min, on seed charge and recovery',
      measured: `${five.winPct.toFixed(1)} % wins, median ${(five.medianSec / 60).toFixed(2)} min`,
      ok: Math.abs(five.medianSec / 60 - 2) <= 0.3,
    },
    {
      name: 'new: Goblin Chieftain, any class solo L6',
      expected: '0 %',
      measured: solos.map(s => `${s.c} ${s.r.winPct.toFixed(0)} %`).join(', '),
      ok: solos.every(s => s.r.winPct === 0),
    },
  ];
}

function templateMonster(mod: any, level: number): any {
  const stats = mod.suggestMonsterStats(level, 'trash');
  return { id: `lab_trash_${level}`, name: `Trash ${level}`, level, tier: 'trash', damageType: 'physical', drops: [], ...stats };
}

function soloTrashLines(engine: EngineAdapter): SanityLine[] {
  const mod = engine.module;
  const lines: SanityLine[] = [];
  const base = seedContent(mod);
  for (const level of [10, 30, 60]) {
    const monster = templateMonster(mod, level);
    const encounterId = `lab_pair_${level}`;
    const content: ContentSnapshot = {
      ...base,
      monsters: { [monster.id]: monster },
      encounters: { [encounterId]: { id: encounterId, name: 'Pair', type: 'explicit', placements: [{ monsterId: monster.id, gridPosition: 4 }, { monsterId: monster.id, gridPosition: 1 }] } },
    };
    const table = [{ encounterId, weight: 1 }];
    const knight = runSeed(engine, content, starterParty(engine, content, ['Knight'], level), table, TRASH_N, `solo-K-${level}`);
    const priest = runSeed(engine, content, starterParty(engine, content, ['Priest'], level), table, TRASH_N, `solo-P-${level}`);
    lines.push({
      name: `new: solo on-level vs 2 trash, L${level}`,
      expected: 'Knight 100 %, 18-23 s; Priest 100 %, 14-25 s, on seed charge and recovery',
      measured: `Knight ${knight.winPct.toFixed(0)} %, ${knight.medianSec.toFixed(1)} s; Priest ${priest.winPct.toFixed(0)} %, ${priest.medianSec.toFixed(1)} s`,
      ok: knight.winPct === 100 && priest.winPct === 100 && Math.abs(knight.medianSec - 20.5) <= 2.5 && Math.abs(priest.medianSec - 19.5) <= 5.5,
    });
  }
  return lines;
}

function forecastCrossCheck(engine: EngineAdapter, content: ContentSnapshot): SanityLine {
  const mod = engine.module;
  const trio = starterParty(engine, seedContent(mod), ['Knight', 'Priest', 'Mage'], 6);
  const table = Object.values(content.zones).find(z => (z.encounterTable?.length ?? 0) >= 2)?.encounterTable ?? [];
  const seed = seedContent(mod);
  const seedTable = (Object.values(seed.zones) as any[]).find(z => (z.encounterTable?.length ?? 0) >= 2)?.encounterTable ?? table;
  const forecast = mod.runForecast(
    { kind: 'room', players: trio, table: seedTable, monsters: seed.monsters, encounters: seed.encounters, pace: mod.COMBAT_PACE },
    { key: 'content-lab-cross-check', maxSims: 200, minSims: 200 },
  );
  let wins = 0;
  const times: number[] = [];
  const n = 200;
  const total = seedTable.reduce((s: number, e: EncounterEntry) => s + e.weight, 0);
  for (const entry of seedTable as EncounterEntry[]) {
    const sims = Math.round((n * entry.weight) / total);
    const r = runSeed(engine, seed, trio, [entry], sims, `cross-${entry.encounterId}`);
    wins += (r.winPct / 100) * sims;
    if (Number.isFinite(r.medianSec)) times.push(r.medianSec);
  }
  const winPct = (100 * wins) / n;
  const forecastMedian = forecast.medianMs === null ? NaN : forecast.medianMs / 1000;
  return {
    name: 'new: harness vs runForecast on a seed zone table, K+P+M L6',
    expected: `forecast ${forecast.winPct} % (CI ${forecast.ci[0]}-${forecast.ci[1]}), median ${forecastMedian.toFixed(1)} s`,
    measured: `harness ${winPct.toFixed(1)} %, stratum medians ${times.map(t => t.toFixed(1)).join('/')} s`,
    ok: winPct >= forecast.ci[0] - 2 && winPct <= forecast.ci[1] + 2,
  };
}

/** A fixed Math.random of 0.5 makes the damage variance 0, so the whole fight can be worked out by hand. */
function oldHandFight(engine: EngineAdapter): SanityLine[] {
  const mod = engine.module;
  const monsterDef = { id: 'lab_dummy', name: 'Dummy', hp: 100, damage: 4, damageType: 'physical', xp: 10, goldMin: 2, goldMax: 2 };
  const buildArcher = (): Combatant => engine.buildHuman({ className: 'Archer', username: 'A', gridPosition: 5, level: 10, equipment: {}, skillIds: [] }, seedContent(mod));
  const original = Math.random;
  const lines: SanityLine[] = [];
  try {
    Math.random = () => 0.5;
    const archer = buildArcher();
    const state = mod.createPartyCombatState([archer], [mod.createMonsterInstance(monsterDef, 3)]);
    const hpByTick: number[] = [];
    while (!state.finished && state.tickCount < OLD_HORIZON_TICKS) {
      mod.processPartyTick(state);
      hpByTick.push(state.monsters[0].currentHp);
    }
    lines.push({
      name: 'old: Archer L10 (33 dmg, 17 HP) vs 100 HP / 4 dmg, variance 0: turns alternate, one actor per tick',
      expected: 'player hits on ticks 1,3,5,7 (100>67>34>1>dead), monster on 2,4,6: victory at tick 7, player HP 17-12=5',
      measured: `${state.result} at tick ${state.tickCount}, player HP ${state.players[0].currentHp}, monster HP by tick ${hpByTick.join(',')}`,
      ok: state.result === 'victory' && state.tickCount === 7 && state.players[0].currentHp === 5,
    });

    const armored = buildArcher();
    armored.equipBonuses = { ...STARTER_GEAR, bonusAttackMin: 0, bonusAttackMax: 0, damageReductionMin: 3, damageReductionMax: 3 };
    const armoredState = mod.createPartyCombatState([armored], [mod.createMonsterInstance(monsterDef, 3)]);
    while (!armoredState.finished) mod.processPartyTick(armoredState);
    lines.push({
      name: 'old: same fight with flat DR 3: flat subtraction, min 0',
      expected: 'each hit 4-3=1: player HP 17-3=14 at tick 7',
      measured: `${armoredState.result} at tick ${armoredState.tickCount}, player HP ${armoredState.players[0].currentHp}`,
      ok: armoredState.tickCount === 7 && armoredState.players[0].currentHp === 14,
    });

    const knight = engine.buildHuman({ className: 'Knight', username: 'K', gridPosition: 5, level: 10, equipment: {}, skillIds: [] }, seedContent(mod));
    const duo = mod.createPartyCombatState([knight, buildArcher()], [mod.createMonsterInstance(monsterDef, 3)]);
    const before = [...duo.players.map((p: any) => p.username)];
    for (let i = 0; i < 3; i++) mod.processPartyTick(duo);
    lines.push({
      name: 'old: two players, one monster, three ticks: each acts once per round',
      expected: 'Knight 10 + Archer 33 = 43 damage, 4 to the Knight',
      measured: `order ${before.join(',')}, monster HP ${duo.monsters[0].currentHp}, Knight lost ${duo.players[0].maxHp - duo.players[0].currentHp}`,
      ok: duo.monsters[0].currentHp === 57 && duo.players[0].maxHp - duo.players[0].currentHp === 4,
    });
  } finally {
    Math.random = original;
  }

  let threeHitWins = 0;
  const n = 5000;
  const content = seedContent(mod);
  const table = [{ encounterId: 'lab_single', weight: 1 }];
  const withDummy: ContentSnapshot = { ...content, monsters: { lab_dummy: monsterDef }, encounters: { lab_single: { id: 'lab_single', name: 'Single', type: 'explicit', placements: [{ monsterId: 'lab_dummy', gridPosition: 3 }] } } };
  for (let i = 0; i < n; i++) {
    const end = engine.fight({ players: [buildArcher()], table, content: withDummy, xpMultiplier: 1, humanCount: 1, hireCount: 0, memberLevel: 10, rng: makeRng(hashSeed(`old-hand|${i}`)) });
    if (end.ms === 5000) threeHitWins++;
  }
  const pct = (100 * threeHitWins) / n;
  lines.push({
    name: 'old: same fight through the adapter with real variance -2..+2',
    expected: '53 of 125 outcomes reach 100 in three hits: 42.4 % end at tick 5, the rest at tick 7',
    measured: `${pct.toFixed(1)} % at tick 5 (N=${n})`,
    ok: Math.abs(pct - 42.4) <= 2,
  });
  return lines;
}

export function runSanity(newEngine: EngineAdapter, oldEngine: EngineAdapter, content: ContentSnapshot): SanityLine[] {
  const loadoutCheck = chooseLoadout(seedContent(newEngine.module), 'Priest', 6).filter(Boolean).length;
  return [
    ...chieftainLines(newEngine),
    ...soloTrashLines(newEngine),
    forecastCrossCheck(newEngine, content),
    {
      name: 'new: chooseLoadout fills the seed schedule at L6',
      expected: '2 skills (passive@1, active@5)',
      measured: `${loadoutCheck} skills`,
      ok: loadoutCheck === 2,
    },
    ...oldHandFight(oldEngine),
  ];
}

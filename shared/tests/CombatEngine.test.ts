import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  findTarget,
  createPartyCombatState,
  processCombatStep,
  advanceCombat,
} from '../src/systems/CombatEngine';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { createEncounter, SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';
import { SEED_ZONES } from '../src/systems/ZoneTypes';
import { calculateBaseDamage } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import {
  BASE_ACTION_INTERVAL_MS,
  COMBAT_STEP_MS,
  FIRST_ACTION_MONSTER_MS,
  FIRST_ACTION_PLAYER_MS,
  STALEMATE_WINDOW_MS,
} from '../src/systems/CombatTiming';
import {
  activeSkill,
  makeMonster,
  makePlayer,
  monsterAt,
  ofKind,
  passiveSkill,
  pinRandom,
  player,
  runTo,
  runUntilEvent,
} from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

function attackTimes(events: ReturnType<typeof runTo>['events'], side: 'player' | 'monster', pos: number): number[] {
  return ofKind(events, 'attack').filter(e => e.src?.side === side && e.src.pos === pos).map(e => e.t);
}

describe('findTarget', () => {
  it('targets same-row combatant first', () => {
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    expect(findTarget(0 as PartyGridPosition, targets, false)).toBe(targets[0]);
  });

  it('prefers low column for players attacking (preferHighCol=false)', () => {
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    expect(findTarget(0 as PartyGridPosition, targets, false)).toBe(targets[0]);
  });

  it('prefers high column for monsters attacking (preferHighCol=true)', () => {
    const targets = [
      { currentHp: 10, gridPosition: 0 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    expect(findTarget(1 as PartyGridPosition, targets, true)).toBe(targets[1]);
  });

  it('scans up before down when no same-row targets', () => {
    const targets = [
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
      { currentHp: 10, gridPosition: 8 as PartyGridPosition },
    ];
    expect(findTarget(4 as PartyGridPosition, targets, false)).toBe(targets[0]);
  });

  it('skips dead targets', () => {
    const targets = [
      { currentHp: 0, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    expect(findTarget(0 as PartyGridPosition, targets, false)).toBe(targets[1]);
  });

  it('returns null when no alive targets', () => {
    const targets = [{ currentHp: 0, gridPosition: 1 as PartyGridPosition }];
    expect(findTarget(0 as PartyGridPosition, targets, false)).toBeNull();
  });

  it('matches the user example targeting', () => {
    const players = [
      { currentHp: 10, gridPosition: 0 as PartyGridPosition, username: 'P0' },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition, username: 'P2' },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition, username: 'P4' },
    ];
    const monsters = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition, name: 'M1' },
      { currentHp: 10, gridPosition: 5 as PartyGridPosition, name: 'M5' },
      { currentHp: 10, gridPosition: 8 as PartyGridPosition, name: 'M8' },
    ];

    expect(findTarget(1 as PartyGridPosition, players, true)!.username).toBe('P2');
    expect(findTarget(5 as PartyGridPosition, players, true)!.username).toBe('P4');
    expect(findTarget(8 as PartyGridPosition, players, true)!.username).toBe('P4');
    expect(findTarget(0 as PartyGridPosition, monsters, false)!.name).toBe('M1');
    expect(findTarget(2 as PartyGridPosition, monsters, false)!.name).toBe('M1');
    expect(findTarget(4 as PartyGridPosition, monsters, false)!.name).toBe('M5');
  });
});

describe('createPartyCombatState', () => {
  it('creates a fresh timeline state', () => {
    const players = [makePlayer('Alice', 0), makePlayer('Bob', 4)];
    const monsters = createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS);
    const state = createPartyCombatState(players, monsters);

    expect(state.players).toHaveLength(2);
    expect(state.monsters).toHaveLength(2);
    expect(state.tickCount).toBe(0);
    expect(state.elapsedMs).toBe(0);
    expect(state.nextEventId).toBe(1);
    expect(state.finished).toBe(false);
    expect(state.result).toBeNull();
    expect(state.lastProgressMs).toBe(0);
    expect(state.lowestMonsterHp).toBe(state.monsters.reduce((s, m) => s + m.maxHp, 0));
    expect(state.pendingCounters).toEqual([]);
    expect(state).not.toHaveProperty('turnIndex');
    expect(state).not.toHaveProperty('roundCount');
  });

  it('sorts players front-to-back and staggers first actions by 100 ms (capped at index 5)', () => {
    const positions: PartyGridPosition[] = [0, 1, 2, 3, 4, 5, 6];
    const state = createPartyCombatState(positions.map(p => makePlayer(`P${p}`, p)), [makeMonster(0)]);

    expect(state.players.map(p => p.gridPosition)).toEqual([2, 5, 1, 4, 0, 3, 6]);
    expect(state.players.map(p => p.actionRemainingMs)).toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1500]);
    for (const p of state.players) {
      expect(p.actionIntervalMs).toBe(BASE_ACTION_INTERVAL_MS);
      expect(p.actionTotalMs).toBe(p.actionRemainingMs);
      expect(p.pulseRemainingMs).toBe(p.actionRemainingMs);
      expect(p.stunRemainingMs).toBe(0);
      expect(p.stunTotalMs).toBe(0);
      expect(p.cast).toBeNull();
    }
  });

  it('sorts monsters front (col 0) first and staggers from 1400 ms (capped at index 8)', () => {
    const positions: PartyGridPosition[] = [8, 7, 6, 5, 4, 3, 2, 1, 0];
    const monsters = positions.map(p => makeMonster(p, { name: `M${p}` }));
    monsters.push(makeMonster(8, { name: 'Extra' }));
    const state = createPartyCombatState([makePlayer('A', 0)], monsters);

    expect(state.monsters.slice(0, 9).map(m => m.gridPosition)).toEqual([0, 3, 6, 1, 4, 7, 2, 5, 8]);
    expect(state.monsters.map(m => m.actionRemainingMs))
      .toEqual([1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2200]);
    expect(state.monsters[0].actionIntervalMs).toBe(1000);
  });

  it('gives walls no action timer but still a pulse offset', () => {
    const wall = createMonsterInstance(SEED_MONSTERS.stone_wall, 0);
    const state = createPartyCombatState([makePlayer('A', 0)], [wall, makeMonster(3)]);
    const w = monsterAt(state, 0);
    expect(w.actionIntervalMs).toBe(0);
    expect(w.actionRemainingMs).toBe(0);
    expect(w.actionTotalMs).toBe(0);
    expect(w.pulseRemainingMs).toBe(FIRST_ACTION_MONSTER_MS);
    expect(monsterAt(state, 3).actionRemainingMs).toBe(FIRST_ACTION_MONSTER_MS + 100);
  });

  it('honours attackInterval and clamps it to 0.3 s', () => {
    const state = createPartyCombatState([makePlayer('A', 0)], [
      makeMonster(0, { attackInterval: 0.8 }),
      makeMonster(3, { attackInterval: 0.1 }),
      makeMonster(6, { attackInterval: 2.5 }),
      makeMonster(1, { attackInterval: Number.NaN }),
    ]);
    expect(monsterAt(state, 0).actionIntervalMs).toBe(800);
    expect(monsterAt(state, 3).actionIntervalMs).toBe(300);
    expect(monsterAt(state, 6).actionIntervalMs).toBe(2500);
    expect(monsterAt(state, 1).actionIntervalMs).toBe(1000);
  });

  it('owns every per-battle field and ignores what builders hand it', () => {
    const init = {
      ...makePlayer('Alice', 4, { hp: 100 }),
      currentHp: 5,
      attackCount: 9,
      dots: [{ sourceUsername: 'x', name: 'rot', damagePerTick: 5, ticksRemaining: 3, damageType: 'magical' as const }],
      damageShield: 40,
      hasResurrected: true,
      martyrBonus: 0.25,
      activeSkillCount: 3,
      actionRemainingMs: 99999,
      stunRemainingMs: 5000,
    };
    const state = createPartyCombatState([init], [makeMonster(0)]);
    const p = state.players[0];
    expect(p.currentHp).toBe(100);
    expect(p.attackCount).toBe(0);
    expect(p.dots).toEqual([]);
    expect(p.damageShield).toBe(0);
    expect(p.hasResurrected).toBe(false);
    expect(p.martyrBonus).toBe(0);
    expect(p.activeSkillCount).toBe(0);
    expect(p.actionRemainingMs).toBe(FIRST_ACTION_PLAYER_MS);
    expect(p.stunRemainingMs).toBe(0);
  });

  it('clones monster skills and resistances per combat instance', () => {
    const def = { skills: [{ skillId: 'rot', value: 5, cooldown: 2 }], resistances: [{ damageType: 'magical' as const, flatReduction: 1, percentReduction: 10 }] };
    const a = makeMonster(0, def);
    const b = makeMonster(3, def);
    const state = createPartyCombatState([makePlayer('A', 0)], [a, b]);
    state.monsters[0].skills[0].value = 99;
    state.monsters[0].resistances[0].flatReduction = 50;
    expect(state.monsters[1].skills[0].value).toBe(5);
    expect(state.monsters[1].resistances[0].flatReduction).toBe(1);
    expect(a.skills![0].value).toBe(5);
    expect(state.monsters[0].skillCooldowns).toEqual({ rot: 0 });
  });

  it('applies Mage Burn bonus damage at combat start', () => {
    const mage = makePlayer('Mage', 0, {
      className: 'Mage', level: 5, baseDamage: calculateBaseDamage(5, 'Mage'),
      skills: [SEED_SKILLS.mage_burn, null, null, null, null],
    });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    expect(state.players[0].baseDamage).toBe(calculateBaseDamage(5, 'Mage') + 10);
  });

  it('computes Bard Rally multiplier (and 0 without a Bard)', () => {
    const bard = makePlayer('Bard', 0, { className: 'Bard', skills: [SEED_SKILLS.bard_rally, null, null, null, null] });
    expect(createPartyCombatState([bard, makePlayer('Archer', 2)], [makeMonster(0)]).rallyMultiplier).toBeCloseTo(0.40);
    expect(createPartyCombatState([makePlayer('Archer', 0)], [makeMonster(0)]).rallyMultiplier).toBe(0);
  });

  it('two passiveEffects of the same kind on one skill SUM at combat start', () => {
    const doubleBurn = passiveSkill({
      id: 'test_double_burn', className: 'Mage',
      passiveEffects: [{ kind: 'bonus_damage', valuePerLevel: 2 }, { kind: 'bonus_damage', valuePerLevel: 3 }],
    });
    const mage = makePlayer('Mage', 0, { className: 'Mage', level: 5, baseDamage: 23, skills: [doubleBurn] });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    expect(state.players[0].baseDamage).toBe(23 + 25);
  });
});

describe('processCombatStep / advanceCombat', () => {
  it('advances elapsedMs by one fixed step and counts steps', () => {
    const state = createPartyCombatState([makePlayer('A', 4)], [makeMonster(0)]);
    processCombatStep(state);
    expect(state.tickCount).toBe(1);
    expect(state.elapsedMs).toBe(COMBAT_STEP_MS);
  });

  it('clamps dt to (0, COMBAT_STEP_MS]', () => {
    const state = createPartyCombatState([makePlayer('A', 4)], [makeMonster(0)]);
    processCombatStep(state, 250);
    expect(state.elapsedMs).toBe(100);
    processCombatStep(state, 30);
    expect(state.elapsedMs).toBe(130);
    processCombatStep(state, Number.NaN);
    expect(state.elapsedMs).toBe(230);
    processCombatStep(state, 0);
    expect(state.elapsedMs).toBeGreaterThan(230);
  });

  it('advanceCombat runs ceil(ms / step) steps and concatenates results', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0)]);
    const r = advanceCombat(state, 1050);
    expect(state.tickCount).toBe(11);
    expect(state.elapsedMs).toBe(1100);
    expect(r.events[0].kind).toBe('battle_start');
    expect(ofKind(r.events, 'attack')).toHaveLength(1);
    expect(r.logEntries.some(l => l.startsWith('A hits Dummy'))).toBe(true);
    expect(r.finished).toBe(false);
  });

  it('advanceCombat stops early once the fight is finished', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 50 })], [makeMonster(0, { hp: 10 })]);
    const r = advanceCombat(state, 10000);
    expect(r.finished).toBe(true);
    expect(r.result).toBe('victory');
    expect(state.elapsedMs).toBe(1000);
    expect(ofKind(r.events, 'battle_end')).toEqual([expect.objectContaining({ result: 'victory', t: 1000 })]);
  });

  it('does nothing on an already-finished combat', () => {
    const state = createPartyCombatState([makePlayer('A', 4)], [makeMonster(0)]);
    state.finished = true;
    state.result = 'victory';
    const r = processCombatStep(state);
    expect(r).toEqual({ logEntries: [], events: [], finished: true, result: 'victory' });
    expect(state.tickCount).toBe(0);
    expect(state.elapsedMs).toBe(0);
  });

  it('emits battle_start on the first step only', () => {
    const state = createPartyCombatState([makePlayer('A', 4)], [makeMonster(0)]);
    const first = processCombatStep(state);
    expect(first.events).toEqual([{ id: 1, t: 100, kind: 'battle_start' }]);
    const run = runTo(state, 3000);
    expect(ofKind(run.events, 'battle_start')).toHaveLength(0);
  });

  it('numbers events monotonically and stamps them with combat time', () => {
    pinRandom();
    const state = createPartyCombatState(
      [makePlayer('A', 2, { baseDamage: 3 }), makePlayer('B', 5, { baseDamage: 3 })],
      [makeMonster(0, { hp: 60, damage: 2 }), makeMonster(3, { hp: 60, damage: 2 })],
    );
    const { events } = runTo(state, 60000);
    expect(state.finished).toBe(true);
    events.forEach((e, i) => {
      expect(e.id).toBe(i + 1);
      expect(e.t % COMBAT_STEP_MS).toBe(0);
      if (i > 0) expect(e.t).toBeGreaterThanOrEqual(events[i - 1].t);
    });
    expect(state.nextEventId).toBe(events.length + 1);
    expect(events[events.length - 1].kind).toBe('battle_end');
  });
});

describe('action timeline', () => {
  it('every combatant acts once per second on its own timer', () => {
    const state = createPartyCombatState(
      [makePlayer('A', 2), makePlayer('B', 5)],
      [makeMonster(0, { damage: 1 })],
    );
    const { events } = runTo(state, 4000);
    expect(attackTimes(events, 'player', 2)).toEqual([1000, 2000, 3000, 4000]);
    expect(attackTimes(events, 'player', 5)).toEqual([1100, 2100, 3100]);
    expect(attackTimes(events, 'monster', 0)).toEqual([1400, 2400, 3400]);
  });

  it('players act simultaneously — several actors can act in the same step', () => {
    const state = createPartyCombatState([makePlayer('A', 2), makePlayer('B', 5)], [makeMonster(0)]);
    state.players[1].actionRemainingMs = 1000;
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'attack').filter(e => e.t === 1000)).toHaveLength(2);
  });

  it('a faster monster (attackInterval 0.8 s) attacks more often', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [
      createMonsterInstance(SEED_MONSTERS.wolf, 0),
    ]);
    state.monsters[0].currentHp = state.monsters[0].maxHp = 10000;
    const { events } = runTo(state, 3800);
    expect(attackTimes(events, 'monster', 0)).toEqual([1400, 2200, 3000, 3800]);
  });

  it('sets actionTotalMs to the length of the current wait', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0, { attackInterval: 1.25 })]);
    runTo(state, 1400);
    expect(state.players[0].actionTotalMs).toBe(1000);
    expect(state.players[0].actionRemainingMs).toBe(600);
    expect(state.monsters[0].actionTotalMs).toBe(1250);
    expect(state.monsters[0].actionRemainingMs).toBe(1250);
  });
});

describe('class-aware damage', () => {
  it('Archer and Mage hit for baseDamage (variance pinned to 0)', () => {
    pinRandom();
    for (const className of ['Archer', 'Mage'] as const) {
      const state = createPartyCombatState(
        [makePlayer('P', 0, { className, baseDamage: 15 })],
        [createMonsterInstance({ ...SEED_MONSTERS.goblin, hp: 100 }, 4)],
      );
      runTo(state, 1000);
      expect(state.monsters[0].currentHp).toBe(85);
    }
  });

  it('damage variance spans −2..+2 and never drops below 1', () => {
    const results: number[] = [];
    for (const roll of [0, 0.2, 0.4, 0.6, 0.8]) {
      vi.spyOn(Math, 'random').mockReturnValue(roll);
      const state = createPartyCombatState(
        [makePlayer('Knight', 0, { className: 'Knight', baseDamage: 1 })],
        [makeMonster(4, { hp: 100 })],
      );
      runTo(state, 1000);
      results.push(100 - state.monsters[0].currentHp);
      vi.restoreAllMocks();
    }
    expect(results).toEqual([1, 1, 1, 2, 3]);
  });

  it('Knight Guard reduces physical damage taken', () => {
    pinRandom();
    const knight = makePlayer('Arthur', 2, {
      className: 'Knight', hp: 200, baseDamage: 1, skills: [SEED_SKILLS.knight_guard],
    });
    const state = createPartyCombatState([knight], [createMonsterInstance(SEED_MONSTERS.goblin, 4)]);
    runTo(state, 1400);
    expect(state.players[0].currentHp).toBe(200 - 2);
  });

  it('Knight Guard scales with level: still 50 % vs a same-level attacker, never a 0-damage hit', () => {
    pinRandom();
    const knight = makePlayer('Arthur', 2, {
      className: 'Knight', level: 5, hp: 200, baseDamage: 1, skills: [SEED_SKILLS.knight_guard],
    });
    const state = createPartyCombatState([knight], [makeMonster(4, { damage: 4 })]);
    const { events } = runTo(state, 1400);
    expect(state.players[0].currentHp).toBe(198);
    const hit = ofKind(events, 'damage').find(e => e.dst?.side === 'player');
    expect(hit).toMatchObject({ amount: 2, dmgType: 'physical', t: 1400 });
  });

  it('two physical_reduction options on one skill SUM at the consumption site', () => {
    pinRandom();
    const doubleGuard = passiveSkill({
      id: 'test_double_guard',
      passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 }, { kind: 'physical_reduction', valuePerLevel: 1 }],
    });
    const knight = makePlayer('Arthur', 2, { className: 'Knight', hp: 200, baseDamage: 1, skills: [doubleGuard] });
    const state = createPartyCombatState([knight], [createMonsterInstance(SEED_MONSTERS.goblin, 4)]);
    runTo(state, 1400);
    expect(state.players[0].currentHp).toBe(200 - 2);
  });

  it('Priest Bless provides party-wide magical damage reduction', () => {
    pinRandom();
    const wolf = makeMonster(4, { hp: 1000, damage: 5, damageType: 'magical' });
    const priest = makePlayer('Cleric', 0, {
      className: 'Priest', hp: 200, baseDamage: 3, skills: [SEED_SKILLS.priest_bless],
    });
    const archer = makePlayer('Legolas', 2, { className: 'Archer', hp: 200, baseDamage: 15 });
    const state = createPartyCombatState([priest, archer], [wolf]);
    runTo(state, 1400);
    expect(player(state, 'Legolas').currentHp).toBe(200 - Math.floor(5 * 0.5));
    expect(player(state, 'Cleric').currentHp).toBe(200);
  });

  it('equipment reduction does NOT apply to magical damage', () => {
    const archer = makePlayer('Legolas', 2, {
      hp: 200, baseDamage: 1,
      equipBonuses: {
        bonusAttackMin: 0, bonusAttackMax: 0, damageReductionMin: 5, damageReductionMax: 5,
        magicReductionMin: 0, magicReductionMax: 0,
      },
    });
    const state = createPartyCombatState([archer], [createMonsterInstance(SEED_MONSTERS.wolf, 4)]);
    runTo(state, 1400);
    expect(state.players[0].currentHp).toBe(200 - SEED_MONSTERS.wolf.damage);
  });
});

describe('end checks', () => {
  it('victory when all monsters die', () => {
    pinRandom();
    const state = createPartyCombatState(
      [makePlayer('Alice', 0, { baseDamage: 30 })],
      [createMonsterInstance(SEED_MONSTERS.goblin, 4)],
    );
    const r = runUntilEvent(state, e => e.kind === 'battle_end');
    expect(r.hit).toMatchObject({ result: 'victory', t: 1000 });
    expect(state.finished).toBe(true);
    expect(state.result).toBe('victory');
    expect(r.log).toContain('Goblin defeated!');
    expect(ofKind(r.events, 'death')).toEqual([expect.objectContaining({ dst: { side: 'monster', pos: 4 } })]);
  });

  it('defeat when all players die', () => {
    pinRandom();
    const state = createPartyCombatState(
      [makePlayer('Alice', 0, { baseDamage: 1, hp: 1 })],
      [createMonsterInstance(SEED_MONSTERS.goblin, 4)],
    );
    runTo(state, 1000);
    expect(state.finished).toBe(false);
    const r = runUntilEvent(state, e => e.kind === 'battle_end');
    expect(r.hit).toMatchObject({ result: 'defeat', t: 1400 });
    expect(state.players[0].currentHp).toBe(0);
    expect(r.log).toContain('Alice has fallen!');
  });

  it('a full seed battle resolves within a bounded time', () => {
    const state = createPartyCombatState(
      [makePlayer('Alice', 0, { baseDamage: 10, hp: 40 })],
      [createMonsterInstance(SEED_MONSTERS.goblin, 4)],
    );
    runTo(state, 20000);
    expect(state.finished).toBe(true);
    expect(state.elapsedMs).toBeLessThanOrEqual(5000);
  });

  it('a room of only walls is won on the first step', () => {
    const state = createPartyCombatState([makePlayer('A', 0)], [
      createMonsterInstance(SEED_MONSTERS.stone_wall, 0),
      createMonsterInstance(SEED_MONSTERS.stone_wall, 1),
    ]);
    const r = processCombatStep(state);
    expect(r.finished).toBe(true);
    expect(r.result).toBe('victory');
    expect(state.tickCount).toBe(1);
    expect(r.events.map(e => e.kind)).toEqual(['battle_start', 'battle_end']);
  });

  it('a mutual wipe in the same phase is a victory', () => {
    const state = createPartyCombatState([makePlayer('A', 0)], [makeMonster(0)]);
    const p = state.players[0];
    const m = state.monsters[0];
    p.currentHp = 1;
    m.currentHp = 1;
    p.dots.push({ sourceUsername: 'x', name: 'rot', damagePerTick: 5, ticksRemaining: 3, damageType: 'magical' });
    m.dots.push({ sourceUsername: 'A', name: 'bleed', damagePerTick: 5, ticksRemaining: 3, damageType: 'physical' });
    p.pulseRemainingMs = 100;
    m.pulseRemainingMs = 100;
    const r = processCombatStep(state);
    expect(p.currentHp).toBe(0);
    expect(m.currentHp).toBe(0);
    expect(r.result).toBe('victory');
  });

  it('a DoT kill in the status pass ends the fight before anyone acts that step', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0, { damage: 1 })]);
    runTo(state, 900);
    const m = state.monsters[0];
    m.currentHp = 3;
    m.dots.push({ sourceUsername: 'A', name: 'bleed', damagePerTick: 5, ticksRemaining: 3, damageType: 'physical' });
    m.pulseRemainingMs = 100;
    const r = processCombatStep(state);
    expect(r.result).toBe('victory');
    expect(state.elapsedMs).toBe(1000);
    expect(ofKind(r.events, 'attack')).toHaveLength(0);
    expect(r.logEntries).toContain('Dummy defeated! (DoT)');
  });

  it('checks the end after every actor slot — a monster killed this step never swings', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 20 })], [makeMonster(0, { hp: 20, damage: 5 })]);
    state.monsters[0].actionRemainingMs = 1000;
    const r = runTo(state, 1000);
    expect(state.result).toBe('victory');
    expect(attackTimes(r.events, 'monster', 0)).toEqual([]);
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('declares a stalemate defeat after 30 s without monster HP progress', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2)], [
      makeMonster(0, { skills: [{ skillId: 'heal', value: 100000, cooldown: 0, castTime: 0 }] }),
    ]);
    const r = runTo(state, 60000);
    expect(state.result).toBe('defeat');
    expect(state.lastProgressMs).toBe(1000);
    expect(state.elapsedMs).toBe(1000 + STALEMATE_WINDOW_MS);
    expect(r.log[r.log.length - 1]).toBe('The fight drags on — the party withdraws.');
    expect(ofKind(r.events, 'battle_end')).toEqual([expect.objectContaining({ result: 'defeat' })]);
  });

  it('restarts the stalemate window whenever monster HP reaches a new low', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 10 })], [makeMonster(0, { hp: 20000 })]);
    runTo(state, 5000);
    expect(state.lastProgressMs).toBe(5000);
    state.monsters[0].skills = [{ skillId: 'heal', value: 100000, cooldown: 0, castTime: 0 }];
    state.monsters[0].skillCooldowns = { heal: 0 };
    runTo(state, 60000);
    expect(state.result).toBe('defeat');
    expect(state.elapsedMs).toBe(5000 + STALEMATE_WINDOW_MS);
  });

  it.each([
    ['the seed stone wall', SEED_MONSTERS.stone_wall],
    ['a 400 HP wall', { ...SEED_MONSTERS.stone_wall, hp: 400 }],
  ])('chipping through %s counts as progress, so a slow Knight still wins', (_label, wallDef) => {
    pinRandom();
    const knight = makePlayer('K', 5, { className: 'Knight', level: 1, hp: 1000, baseDamage: 3 });
    const state = createPartyCombatState([knight], [
      createMonsterInstance(wallDef, 3),
      createMonsterInstance({ ...SEED_MONSTERS.goblin, damage: 1 }, 4),
    ]);
    const r = runTo(state, 300000);
    expect(state.result).toBe('victory');
    expect(state.elapsedMs).toBeGreaterThan(STALEMATE_WINDOW_MS);
    expect(r.log).not.toContain('The fight drags on — the party withdraws.');
    expect(monsterAt(state, 3).currentHp).toBe(0);
  });

  it('an out-healing goblin behind a wall still ends in a stalemate once the wall falls', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('K', 5, { className: 'Knight', baseDamage: 50 })], [
      createMonsterInstance(SEED_MONSTERS.stone_wall, 3),
      makeMonster(4, { skills: [{ skillId: 'heal', value: 100000, cooldown: 0, castTime: 0 }] }),
    ]);
    const r = runTo(state, 60000);
    expect(monsterAt(state, 3).currentHp).toBe(0);
    expect(state.result).toBe('defeat');
    expect(state.elapsedMs).toBe(state.lastProgressMs + STALEMATE_WINDOW_MS);
    expect(r.log[r.log.length - 1]).toBe('The fight drags on — the party withdraws.');
  });

  it('healing monsters do not reset the stalemate window', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 10 })], [makeMonster(0, { hp: 20000 })]);
    runTo(state, 3000);
    const low = state.lowestMonsterHp;
    state.monsters[0].currentHp += 500;
    runTo(state, 4000);
    expect(state.lowestMonsterHp).toBe(low);
    expect(state.lastProgressMs).toBe(3000);
  });
});

describe('stuns', () => {
  it('a stunned player freezes its action timer and cooldowns', () => {
    const bash = activeSkill({ id: 'slow', cooldown: 3 });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [bash] })], [makeMonster(0)]);
    state.players[0].stunRemainingMs = 1000;
    state.players[0].stunTotalMs = 1000;
    const { events } = runTo(state, 2000);
    expect(attackTimes(events, 'player', 2)).toEqual([2000]);
    expect(state.players[0].stunRemainingMs).toBe(0);
    expect(state.players[0].stunTotalMs).toBe(0);
  });

  it('a stunned monster skips its action until the stun ends', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0, { damage: 1 })]);
    state.monsters[0].stunRemainingMs = 1000;
    const { events } = runTo(state, 2400);
    expect(attackTimes(events, 'monster', 0)).toEqual([2400]);
  });

  it('stuns refresh to 1 s and never stack', () => {
    pinRandom();
    const knights = [
      makePlayer('K1', 2, { className: 'Knight', skills: [SEED_SKILLS.knight_bash] }),
      makePlayer('K2', 5, { className: 'Knight', skills: [SEED_SKILLS.knight_bash] }),
    ];
    const state = createPartyCombatState(knights, [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'stun')).toHaveLength(1);
    expect(state.monsters[0].stunRemainingMs).toBe(900);
    runTo(state, 1100, r);
    expect(ofKind(r.events, 'stun')).toHaveLength(2);
    expect(state.monsters[0].stunRemainingMs).toBe(900);
    expect(state.monsters[0].stunTotalMs).toBe(1000);
    expect(r.log.filter(l => l === 'Dummy is stunned!')).toHaveLength(2);
  });
});

describe('multi-option skills', () => {
  it('an active with one no-op and one effective option acts and does NOT rewind activeSkillCount', () => {
    const combo = activeSkill({
      id: 'test_combo', name: 'Combo Strike', className: 'Priest', cooldown: 1,
      activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'damage_percent', damagePercent: 1.0 }],
    });
    const priest = makePlayer('Healer', 0, { className: 'Priest', baseDamage: 10, skills: [null, combo] });
    const state = createPartyCombatState([priest], [makeMonster(4)]);
    const r = runTo(state, 1000);
    expect(r.log.some(l => l.includes('uses Combo Strike on Dummy'))).toBe(true);
    expect(state.monsters[0].currentHp).toBeLessThan(10000);
    expect(state.players[0].activeSkillCount).toBe(1);
    expect(ofKind(r.events, 'fizzle')).toHaveLength(0);
  });

  it('an active whose options all have nothing to do is held: auto-attack, no cooldown, no rewind needed', () => {
    const useless = activeSkill({
      id: 'test_useless', name: 'Wasted Words', className: 'Priest', cooldown: 1,
      activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'cure_debuffs' }],
    });
    const priest = makePlayer('Healer', 0, { className: 'Priest', baseDamage: 10, skills: [null, useless] });
    const state = createPartyCombatState([priest], [makeMonster(4)]);
    const r = runTo(state, 1000);
    expect(r.log.some(l => l.includes('Wasted Words'))).toBe(false);
    expect(r.log.some(l => l.startsWith('Healer hits Dummy'))).toBe(true);
    expect(state.players[0].activeSkillCount).toBe(0);
    expect(state.players[0].skillCooldowns.test_useless).toBe(0);
    expect(ofKind(r.events, 'fizzle')).toHaveLength(0);
  });

  it('Sunder marks from skills with different multipliers accumulate independently', () => {
    const strong = activeSkill({ id: 'strong', name: 'Strong Sunder', activeEffects: [{ kind: 'stacking_mark', markMultiplier: 0.25 }] });
    const weak = activeSkill({ id: 'weak', name: 'Weak Sunder', activeEffects: [{ kind: 'stacking_mark', markMultiplier: 0.05 }] });
    const state = createPartyCombatState([
      makePlayer('Arthur', 1, { className: 'Knight', skills: [null, strong] }),
      makePlayer('Lancelot', 0, { className: 'Knight', skills: [null, weak] }),
    ], [makeMonster(4)]);

    const r = runTo(state, 1000);
    expect(state.monsters[0].sunderMark).toMatchObject({ stacks: 1, totalBonus: 0.25 });
    expect(r.log).toContain('Dummy is sundered! (+25% incoming damage)');

    runTo(state, 1100, r);
    expect(state.monsters[0].sunderMark!.stacks).toBe(2);
    expect(state.monsters[0].sunderMark!.totalBonus).toBeCloseTo(0.30);
    expect(ofKind(r.events, 'status').map(e => e.name)).toEqual(['Strong Sunder', 'Weak Sunder']);
  });

  it('Sunder increases later damage to the marked target', () => {
    pinRandom();
    const mark = activeSkill({ id: 'mark', name: 'Mark', cooldown: 10, warmup: 0, activeEffects: [{ kind: 'stacking_mark', markMultiplier: 0.5 }] });
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 10, skills: [mark] })], [makeMonster(0, { hp: 1000 })]);
    runTo(state, 1000);
    expect(state.monsters[0].currentHp).toBe(990);
    runTo(state, 2000);
    expect(state.monsters[0].currentHp).toBe(990 - 15);
  });
});

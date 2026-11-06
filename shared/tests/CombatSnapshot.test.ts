import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildClientCombatSnapshot, createPartyCombatState } from '../src/systems/CombatEngine';
import type { PartyCombatState } from '../src/systems/CombatEngine';
import type { ClientCombatUnit } from '../src/systems/CombatEvents';
import { LEGACY_SEED_SKILLS } from './legacySeedSkills';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import {
  activeSkill,
  makeMonster,
  makePlayer,
  monsterAt,
  pinRandom,
  player,
  runTo,
} from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

function unit(snapshot: { units: ClientCombatUnit[] }, side: 'player' | 'monster', pos: number): ClientCombatUnit {
  const u = snapshot.units.find(x => x.side === side && x.pos === pos);
  if (!u) throw new Error(`no ${side} unit at ${pos}`);
  return u;
}

function party(): PartyCombatState {
  return createPartyCombatState([
    makePlayer('K', 2, {
      className: 'Knight',
      skills: [LEGACY_SEED_SKILLS.knight_guard, LEGACY_SEED_SKILLS.knight_bash, LEGACY_SEED_SKILLS.knight_intercept, LEGACY_SEED_SKILLS.knight_dispel],
    }),
    makePlayer('Grim the Bold', 5, { className: 'Knight', isHenchman: true, skills: [LEGACY_SEED_SKILLS.knight_bash] }),
  ], [
    createMonsterInstance({ ...SEED_MONSTERS.goblin, description: 'A goblin.' }, 0),
    createMonsterInstance(SEED_MONSTERS.stone_wall, 3),
  ]);
}

describe('buildClientCombatSnapshot', () => {
  it('full snapshot carries static fields', () => {
    const snap = buildClientCombatSnapshot(party(), 42, true);
    expect(snap).toMatchObject({ battleId: 42, elapsedMs: 0, full: true, finished: false, result: null });
    expect(snap.units.map(u => `${u.side}:${u.pos}`)).toEqual(['player:2', 'player:5', 'monster:0', 'monster:3']);

    expect(unit(snap, 'player', 2)).toEqual({
      side: 'player', pos: 2, hp: 1000, maxHp: 1000, actionMs: 1000, actionTotalMs: 1000, actionIntervalMs: 1000,
      name: 'K', level: 1, className: 'Knight', passives: ['knight_guard'],
      skills: [
        { id: 'knight_bash', remainingMs: 1000, cooldownMs: 1000, state: 'cooldown', name: 'Bash', cardType: 'action', castTimeMs: 0, baseCooldownMs: 2000, useCooldownMs: 2000 },
        { id: 'knight_intercept', remainingMs: 0, cooldownMs: 0, state: 'armed', name: 'Intercept', cardType: 'instant', trigger: 'ally_targeted', castTimeMs: 0, baseCooldownMs: 2000, useCooldownMs: 2000 },
        { id: 'knight_dispel', remainingMs: 4000, cooldownMs: 4000, state: 'cooldown', name: 'Dispel', cardType: 'instant', trigger: 'enemy_cast', castTimeMs: 0, baseCooldownMs: 5000, useCooldownMs: 5000 },
      ],
    });

    const hench = unit(snap, 'player', 5);
    expect(hench).toMatchObject({ name: 'Grim the Bold', henchman: true, actionMs: 1100 });
    expect(hench.skills).toBeUndefined();
    expect(hench.className).toBeUndefined();
    expect(hench.passives).toBeUndefined();

    expect(unit(snap, 'monster', 0)).toEqual({
      side: 'monster', pos: 0, hp: 15, maxHp: 15, actionMs: 1400, actionTotalMs: 1400, actionIntervalMs: 1000,
      name: 'Goblin', id: 'goblin', description: 'A goblin.',
      level: expect.any(Number), levelSource: expect.any(String), tier: 'trash',
    });
    expect(unit(snap, 'monster', 3)).toMatchObject({ passive: true, actionMs: 0, actionTotalMs: 0, id: 'stone_wall' });
  });

  it('dynamic snapshots drop static fields but keep maxHp and skill timing', () => {
    const snap = buildClientCombatSnapshot(party(), 42, false);
    expect(snap.full).toBe(false);
    const k = unit(snap, 'player', 2);
    expect(k).toEqual({
      side: 'player', pos: 2, hp: 1000, maxHp: 1000, actionMs: 1000, actionTotalMs: 1000,
      skills: [
        { id: 'knight_bash', remainingMs: 1000, cooldownMs: 1000, state: 'cooldown' },
        { id: 'knight_intercept', remainingMs: 0, cooldownMs: 0, state: 'armed' },
        { id: 'knight_dispel', remainingMs: 4000, cooldownMs: 4000, state: 'cooldown' },
      ],
    });
    expect(unit(snap, 'monster', 0)).toEqual({ side: 'monster', pos: 0, hp: 15, maxHp: 15, actionMs: 1400, actionTotalMs: 1400 });
    expect(unit(snap, 'monster', 3).passive).toBeUndefined();
  });

  it('only full snapshots carry actionIntervalMs, and never for walls', () => {
    const state = party();
    state.players[1].actionIntervalMs = 1250;
    state.monsters[0].actionIntervalMs = 800;
    const full = buildClientCombatSnapshot(state, 42, true);
    expect(unit(full, 'player', 2).actionIntervalMs).toBe(1000);
    expect(unit(full, 'player', 5).actionIntervalMs).toBe(1250);
    expect(unit(full, 'monster', 0).actionIntervalMs).toBe(800);
    expect(unit(full, 'monster', 3)).not.toHaveProperty('actionIntervalMs');
    const dynamic = buildClientCombatSnapshot(state, 42, false);
    expect(dynamic.units.filter(u => 'actionIntervalMs' in u)).toEqual([]);
  });

  it('tracks elapsed time, action timers and the end result', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 20 })], [makeMonster(0, { hp: 30 })]);
    runTo(state, 1300);
    let snap = buildClientCombatSnapshot(state, 7, false);
    expect(snap.elapsedMs).toBe(1300);
    expect(unit(snap, 'player', 2)).toMatchObject({ actionMs: 700, actionTotalMs: 1000 });
    expect(unit(snap, 'monster', 0)).toMatchObject({ hp: 10, actionMs: 100, actionTotalMs: 1400 });
    runTo(state, 3000);
    snap = buildClientCombatSnapshot(state, 7, false);
    expect(snap).toMatchObject({ finished: true, result: 'victory' });
    expect(unit(snap, 'monster', 0).hp).toBe(0);
  });

  describe('skill state', () => {
    it('ready, held and casting', () => {
      const zap = activeSkill({ id: 'zap', cooldown: 2, warmup: 0 });
      const channel = activeSkill({ id: 'ch', cooldown: 5, warmup: 0, castTime: 1 });
      const state = createPartyCombatState([
        makePlayer('P', 2, { className: 'Priest', skills: [LEGACY_SEED_SKILLS.priest_minor_heal, zap] }),
        makePlayer('M', 5, { className: 'Mage', skills: [channel] }),
      ], [makeMonster(0)]);
      let snap = buildClientCombatSnapshot(state, 1, false);
      expect(unit(snap, 'player', 2).skills!.map(s => s.state)).toEqual(['held', 'ready']);
      expect(unit(snap, 'player', 5).skills!.map(s => s.state)).toEqual(['ready']);

      runTo(state, 1100);
      snap = buildClientCombatSnapshot(state, 1, false);
      expect(unit(snap, 'player', 2).skills![1]).toEqual({ id: 'zap', remainingMs: 1900, cooldownMs: 2000, state: 'cooldown' });
      expect(unit(snap, 'player', 5).skills![0]).toMatchObject({ state: 'casting', remainingMs: 5000, cooldownMs: 5000 });
      expect(unit(snap, 'player', 5).cast).toEqual({
        skill: 'ch', skillId: 'ch', totalMs: 1000, remainingMs: 1000, target: { side: 'monster', pos: 0 },
      });

      player(state, 'M').currentHp = 400;
      snap = buildClientCombatSnapshot(state, 1, false);
      expect(unit(snap, 'player', 2).skills![0].state).toBe('ready');
    });

    it('a counter reads armed whether or not an enemy can cast', () => {
      const dispel = { ...LEGACY_SEED_SKILLS.knight_dispel, warmup: 0 };
      const quiet = createPartyCombatState([makePlayer('K', 2, { skills: [dispel] })], [makeMonster(0)]);
      expect(unit(buildClientCombatSnapshot(quiet, 1, false), 'player', 2).skills![0].state).toBe('armed');

      const casting = createPartyCombatState([makePlayer('K', 2, { skills: [dispel] })], [
        makeMonster(0, { skills: [{ skillId: 'fireball', value: 1, cooldown: 3 }] }),
      ]);
      expect(unit(buildClientCombatSnapshot(casting, 1, false), 'player', 2).skills![0].state).toBe('armed');
    });

    it('owner stun does not change skill state but shows on the unit, with a paused cast', () => {
      const channel = activeSkill({ id: 'ch', cooldown: 5, warmup: 0, castTime: 1 });
      const state = createPartyCombatState([makePlayer('M', 2, { skills: [channel, LEGACY_SEED_SKILLS.knight_intercept] })], [makeMonster(0)]);
      runTo(state, 1300);
      state.players[0].stunRemainingMs = 800;
      state.players[0].stunTotalMs = 1000;
      const u = unit(buildClientCombatSnapshot(state, 1, false), 'player', 2);
      expect(u.stunMs).toBe(800);
      expect(u.stunTotalMs).toBe(1000);
      expect(u.cast).toMatchObject({ remainingMs: 700, paused: true });
      expect(u.skills!.map(s => s.state)).toEqual(['casting', 'armed']);
    });
  });

  it('shows monster casts with their locked target', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { hp: 100 }), makePlayer('B', 5)], [
      makeMonster(0, { skills: [{ skillId: 'assassinate', value: 10, cooldown: 6 }] }),
    ]);
    runTo(state, 1500);
    const m = unit(buildClientCombatSnapshot(state, 1, false), 'monster', 0);
    expect(m.cast).toEqual({ skill: 'Assassinate', skillId: 'assassinate', totalMs: 1000, remainingMs: 900, target: { side: 'player', pos: 2 } });
    expect(m.actionTotalMs).toBe(1000);
  });

  it('reports statuses on monsters', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0)]);
    const m = monsterAt(state, 0);
    m.dots.push(
      { sourceUsername: 'A', name: 'bleed', label: 'Bleed', damagePerTick: 2, ticksRemaining: 3, damageType: 'physical' },
      { sourceUsername: 'A', name: 'bleed', label: 'Bleed', damagePerTick: 2, ticksRemaining: 1, damageType: 'physical' },
      { sourceUsername: 'A', name: 'ignite', label: 'Ignite', damagePerTick: 3, ticksRemaining: 1, damageType: 'magical', permanent: true },
    );
    m.debuffs.push(
      { type: 'crippling_shot', value: 0.3, remainingMs: 2500, name: 'Crippling Shot' },
      { type: 'scorch', value: 0.1, remainingMs: 2000, name: 'Scorch' },
    );
    m.sunderMark = { stacks: 2, totalBonus: 0.5, name: 'Sunder' };
    m.chaosActive = true;
    m.chaosName = 'Chaos';
    m.buffs.push({ type: 'ward', value: 1, remainingMs: -1, name: 'Ward' });
    const u = unit(buildClientCombatSnapshot(state, 1, false), 'monster', 0);
    expect(u.statuses).toEqual([
      { kind: 'dot', name: 'Bleed', stacks: 2, remainingMs: 3400 },
      { kind: 'dot', name: 'Ignite' },
      { kind: 'debuff', name: 'Crippling Shot', remainingMs: 2500 },
      { kind: 'scorch', name: 'Scorch', remainingMs: 2000 },
      { kind: 'buff', name: 'Ward' },
      { kind: 'mark', name: 'Sunder', stacks: 2 },
      { kind: 'chaos', name: 'Chaos' },
    ]);
  });

  it('reports HoTs, shields and party buffs on players, and nothing on the dead', () => {
    const warSong = { ...LEGACY_SEED_SKILLS.bard_war_song, cooldown: 1 };
    const state = createPartyCombatState([
      makePlayer('B', 2, { className: 'Bard', skills: [warSong] }),
      makePlayer('X', 5),
    ], [makeMonster(0)]);
    runTo(state, 2000);
    const b = player(state, 'B');
    b.hots.push({ sourceUsername: 'P', name: 'mending', label: 'Mending', healPerTick: 5, ticksRemaining: 2 });
    b.damageShield = 12;
    player(state, 'X').currentHp = 0;
    const snap = buildClientCombatSnapshot(state, 1, false);
    const u = unit(snap, 'player', 2);
    expect(u.shield).toBe(12);
    expect(u.statuses).toEqual([
      { kind: 'hot', name: 'Mending', remainingMs: 2000 },
      { kind: 'buff', name: 'War Song', stacks: 2 },
    ]);
    expect(unit(snap, 'player', 5).statuses).toBeUndefined();
  });
});

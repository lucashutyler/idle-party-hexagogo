import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPartyCombatState, applyMonsterResistance } from '../src/systems/CombatEngine';
import type { Resistance } from '../src/systems/MonsterTypes';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from '../src/systems/MonsterSkills';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';
import { makeMonster, makePlayer, monsterAt, ofKind, pinRandom, player, runTo } from './combatTestUtils';
import type { PlayerOptions } from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

function knight(username: string, pos: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, opts: PlayerOptions = {}) {
  return makePlayer(username, pos, { className: 'Knight', level: 10, hp: 100, ...opts });
}

function seed(...ids: string[]): SkillDefinition[] {
  return ids.map(id => SEED_SKILLS[id]);
}

describe('Monster Resistances', () => {
  describe('applyMonsterResistance', () => {
    it('applies percent reduction first, then flat', () => {
      const resistances: Resistance[] = [
        { damageType: 'physical', flatReduction: 5, percentReduction: 50 },
      ];
      // 100 damage → 50% = 50 → -5 flat = 45
      const result = applyMonsterResistance(100, 'physical', resistances);
      expect(result).toBe(45);
    });

    it('returns damage unchanged for non-matching type', () => {
      const resistances: Resistance[] = [
        { damageType: 'magical', flatReduction: 10, percentReduction: 50 },
      ];
      const result = applyMonsterResistance(100, 'physical', resistances);
      expect(result).toBe(100);
    });

    it('handles negative percent (vulnerability)', () => {
      const resistances: Resistance[] = [
        { damageType: 'magical', flatReduction: 0, percentReduction: -100 },
      ];
      // 50 damage → -100% = 50 * (1 - (-100/100)) = 50 * 2 = 100
      const result = applyMonsterResistance(50, 'magical', resistances);
      expect(result).toBe(100);
    });

    it('handles negative flat (extra damage)', () => {
      const resistances: Resistance[] = [
        { damageType: 'physical', flatReduction: -20, percentReduction: 0 },
      ];
      // 50 damage → 0% = 50 → -(-20) flat = 70
      const result = applyMonsterResistance(50, 'physical', resistances);
      expect(result).toBe(70);
    });

    it('floors at minimum 0 (full block is allowed)', () => {
      const resistances: Resistance[] = [
        { damageType: 'physical', flatReduction: 1000, percentReduction: 99 },
      ];
      const result = applyMonsterResistance(10, 'physical', resistances);
      expect(result).toBe(0);
    });

    it('handles holy damage type', () => {
      const resistances: Resistance[] = [
        { damageType: 'holy', flatReduction: 5, percentReduction: 0 },
      ];
      const result = applyMonsterResistance(20, 'holy', resistances);
      expect(result).toBe(15);
    });
  });


  describe('resistance in combat', () => {
    it('reduces player damage to a resistant monster', () => {
      pinRandom();
      const monster = makeMonster(4, {
        name: 'Resistant Goblin', hp: 1000, damage: 1,
        resistances: [{ damageType: 'physical', flatReduction: 0, percentReduction: 50 }],
      });
      const state = createPartyCombatState([knight('Alice', 4, { baseDamage: 100, damageType: 'physical' })], [monster]);
      const { log } = runTo(state, 1000);
      expect(state.monsters[0].currentHp).toBe(950);
      expect(log).toContain('Alice hits Resistant Goblin for 50 physical damage');
    });
  });
});

describe('MONSTER_SKILL_CATALOG timing', () => {
  it('has the telegraphed cast times from the spec', () => {
    const castTimes = Object.fromEntries(Object.values(MONSTER_SKILL_CATALOG).map(d => [d.id, d.castTime ?? 0]));
    expect(castTimes).toEqual({ fireball: 1.5, fear: 1.0, rot: 0, heal: 1.0, assassinate: 1.0 });
    expect(MONSTER_SKILL_CATALOG.fear.description).toBe('Stuns all archers and mages for 1 second');
  });

  it('getMonsterSkillCastTimeMs prefers the entry override, then the catalog default', () => {
    expect(getMonsterSkillCastTimeMs({ skillId: 'fireball', value: 1, cooldown: 3 })).toBe(1500);
    expect(getMonsterSkillCastTimeMs({ skillId: 'fireball', value: 1, cooldown: 3, castTime: 0.4 })).toBe(400);
    expect(getMonsterSkillCastTimeMs({ skillId: 'fireball', value: 1, cooldown: 3, castTime: 0 })).toBe(0);
    expect(getMonsterSkillCastTimeMs({ skillId: 'rot', value: 1, cooldown: 3 })).toBe(0);
    expect(getMonsterSkillCastTimeMs({ skillId: 'nope', value: 1, cooldown: 3 })).toBe(0);
    expect(getMonsterSkillCastTimeMs({ skillId: 'heal', value: 1, cooldown: 3, castTime: -2 })).toBe(0);
  });
});

describe('Monster Skills', () => {
  describe('skill execution in combat', () => {
    it('Fireball is telegraphed for 1.5 s, then hits every player', () => {
      const monster = makeMonster(4, { name: 'Mage Goblin', damage: 0, damageType: 'magical', skills: [{ skillId: 'fireball', value: 20, cooldown: 3 }] });
      const state = createPartyCombatState([knight('Alice', 4), knight('Bob', 1)], [monster]);
      const r = runTo(state, 2800);
      expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({
        t: 1400, src: { side: 'monster', pos: 4 }, skill: 'Fireball', skillId: 'fireball', durationMs: 1500,
      })]);
      expect(r.log).toContain('Mage Goblin begins casting Fireball!');
      expect(player(state, 'Alice').currentHp).toBe(100);

      runTo(state, 2900, r);
      const at2900 = r.events.filter(e => e.t === 2900 && e.src?.side === 'monster').map(e => e.kind);
      expect(at2900).toEqual(['cast_end', 'attack', 'damage', 'damage', 'attack', 'damage']);
      expect(r.log).toContain('Mage Goblin casts Fireball!');
      expect(r.log).toContain('Fireball hits Alice for 20 magical damage');
      expect(player(state, 'Alice').currentHp).toBe(80);
      expect(player(state, 'Bob').currentHp).toBe(80);
    });

    it('an entry castTime of 0 makes the skill instant', () => {
      const monster = makeMonster(4, { skills: [{ skillId: 'fireball', value: 20, cooldown: 3, castTime: 0 }] });
      const state = createPartyCombatState([knight('Alice', 4)], [monster]);
      const r = runTo(state, 1400);
      expect(ofKind(r.events, 'cast_start')).toHaveLength(0);
      expect(ofKind(r.events, 'attack').filter(e => e.skillId === 'fireball').map(e => e.t)).toEqual([1400]);
      expect(state.players[0].currentHp).toBe(80);
    });

    it('a monster heals its most wounded other ally after a 1 s cast', () => {
      const wounded = makeMonster(1, { name: 'Wounded', hp: 100, damage: 1 });
      wounded.currentHp = 10;
      const healer = makeMonster(4, { name: 'Healer', damage: 1, damageType: 'magical', skills: [{ skillId: 'heal', value: 50, cooldown: 2 }] });
      const state = createPartyCombatState([knight('Alice', 4, { baseDamage: 1 })], [healer, wounded]);
      const r = runTo(state, 2500);
      expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({ t: 1500, dst: { side: 'monster', pos: 1 }, skill: 'Heal' })]);
      expect(ofKind(r.events, 'heal')).toEqual([expect.objectContaining({ t: 2500, src: { side: 'monster', pos: 4 }, dst: { side: 'monster', pos: 1 }, amount: 50 })]);
      expect(r.log).toContain('Healer casts Heal on Wounded for 50 HP!');
    });

    it('a monster cast with nothing left to do at resolution fizzles', () => {
      const wounded = makeMonster(1, { name: 'Wounded', hp: 100 });
      wounded.currentHp = 10;
      const healer = makeMonster(4, { name: 'Healer', skills: [{ skillId: 'heal', value: 50, cooldown: 2 }] });
      const state = createPartyCombatState([knight('Alice', 4, { baseDamage: 1 })], [healer, wounded]);
      runTo(state, 1500);
      monsterAt(state, 1).currentHp = 100;
      const r = runTo(state, 2500);
      expect(ofKind(r.events, 'fizzle')).toEqual([expect.objectContaining({ t: 2500, src: { side: 'monster', pos: 4 }, skill: 'Heal', skillId: 'heal' })]);
      expect(r.log).toContain('Healer\'s Heal fizzles!');
      expect(ofKind(r.events, 'heal')).toHaveLength(0);
      expect(monsterAt(state, 4).skillCooldowns.heal).toBeGreaterThan(0);
    });

    it('never heals itself or a wall, and a skill with nothing to do keeps its cooldown', () => {
      const healer = makeMonster(0, { skills: [{ skillId: 'heal', value: 50, cooldown: 2 }] });
      const wall = createMonsterInstance(SEED_MONSTERS.stone_wall, 3);
      wall.currentHp = 1;
      const state = createPartyCombatState([knight('Alice', 4)], [healer, wall]);
      state.monsters[0].currentHp = 5000;
      const r = runTo(state, 3000);
      expect(ofKind(r.events, 'cast_start')).toHaveLength(0);
      expect(ofKind(r.events, 'heal')).toHaveLength(0);
      expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'monster').map(e => e.t)).toEqual([1400, 2400]);
      expect(monsterAt(state, 0).skillCooldowns.heal).toBe(0);
    });

    it('Fear is held while no Archer or Mage is in reach, then fires as soon as one is', () => {
      const monster = makeMonster(4, { name: 'Horror', skills: [{ skillId: 'fear', value: 1, cooldown: 3 }] });
      const state = createPartyCombatState([knight('K', 4)], [monster]);
      const r = runTo(state, 2400);
      expect(ofKind(r.events, 'cast_start')).toHaveLength(0);
      expect(state.monsters[0].skillCooldowns.fear).toBe(0);
      state.players[0].className = 'Mage';
      runTo(state, 3400, r);
      expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({ t: 3400, skill: 'Fear' })]);
    });

    it('cooldowns are seconds after use', () => {
      const state = createPartyCombatState([knight('A', 4, { hp: 10000 })], [
        makeMonster(4, { skills: [{ skillId: 'rot', value: 1, cooldown: 2 }] }),
        makeMonster(1, { skills: [{ skillId: 'rot', value: 1, cooldown: 0 }] }),
      ]);
      const { events } = runTo(state, 5500);
      const rotTimes = (pos: number) => ofKind(events, 'attack').filter(e => e.skillId === 'rot' && e.src!.pos === pos).map(e => e.t);
      expect(rotTimes(1)).toEqual([1400, 2400, 3400, 4400, 5400]);
      expect(rotTimes(4)).toEqual([1500, 3500, 5500]);
    });

    it('uses the first skill in array order that is ready and needed; unknown ids are skipped', () => {
      const monster = makeMonster(4, {
        skills: [
          { skillId: 'nope', value: 1, cooldown: 0 },
          { skillId: 'heal', value: 5, cooldown: 0 },
          { skillId: 'rot', value: 2, cooldown: 5 },
        ],
      });
      const state = createPartyCombatState([knight('A', 4)], [monster]);
      const r = runTo(state, 2400);
      const monsterAttacks = ofKind(r.events, 'attack').filter(e => e.src?.side === 'monster');
      expect(monsterAttacks.map(e => [e.t, e.skillId])).toEqual([[1400, 'rot'], [2400, undefined]]);
    });
  });

  describe('player defenses against monster skills', () => {
    it('Fireball is reduced by Priest Bless (party-wide MR)', () => {
      const monster = makeMonster(4, { name: 'Mage', damage: 0, damageType: 'magical', skills: [{ skillId: 'fireball', value: 50, cooldown: 3 }] });
      const state = createPartyCombatState([
        knight('K', 4, { hp: 1000 }),
        makePlayer('P', 1, { className: 'Priest', level: 10, hp: 1000, skills: seed('priest_bless') }),
      ], [monster]);
      runTo(state, 2900);
      expect(player(state, 'K').currentHp).toBe(1000 - 30);
    });

    it('Assassinate is reduced by Knight Guard (physical reduction)', () => {
      const monster = makeMonster(4, { name: 'Rogue', skills: [{ skillId: 'assassinate', value: 50, cooldown: 5 }] });
      const state = createPartyCombatState([knight('K', 4, { hp: 1000, skills: seed('knight_guard') })], [monster]);
      const r = runTo(state, 2400);
      expect(ofKind(r.events, 'damage').filter(e => e.skill === 'Assassinate').map(e => [e.t, e.amount])).toEqual([[2400, 30]]);
      expect(r.log).toContain('Rogue\'s Assassinate hits K for 30 physical damage');
      expect(state.players[0].currentHp).toBe(1000 - 30);
    });

    it('Assassinate aims at the lowest-HP player and a Knight\'s Intercept takes it', () => {
      const monster = makeMonster(0, { name: 'Rogue', skills: [{ skillId: 'assassinate', value: 30, cooldown: 5 }] });
      const state = createPartyCombatState([
        knight('K', 0, { baseDamage: 0, hp: 200, skills: seed('knight_guard', 'knight_intercept') }),
        makePlayer('A', 4, { className: 'Archer', baseDamage: 0, hp: 50 }),
      ], [monster]);
      const r = runTo(state, 2400);
      expect(ofKind(r.events, 'cast_start')[0].dst).toEqual({ side: 'player', pos: 4 });
      expect(r.log.some(l => l.includes('intercepts'))).toBe(true);
      expect(player(state, 'A').currentHp).toBe(50);
      expect(player(state, 'K').currentHp).toBe(200 - 10);
    });

    it('Martyr triggers from DoT damage to a Knight (capped at single stack)', () => {
      const monster = makeMonster(4, { name: 'Rotter', damageType: 'magical', skills: [{ skillId: 'rot', value: 5, cooldown: 2 }] });
      const state = createPartyCombatState([
        knight('K', 4, { hp: 1000 }),
        makePlayer('P', 1, { className: 'Priest', level: 1, hp: 100, skills: seed('priest_martyr') }),
      ], [monster]);
      const r = runTo(state, 6000);
      expect(ofKind(r.events, 'damage').filter(e => e.overTime && e.dst?.pos === 4).length).toBeGreaterThanOrEqual(3);
      expect(player(state, 'P').martyrBonus).toBe(0.25);
    });
  });

  describe('fear skill', () => {
    it('stuns archers and mages for 1 second, never knights', () => {
      const monster = makeMonster(4, { name: 'Scary', damage: 1, damageType: 'magical', skills: [{ skillId: 'fear', value: 1, cooldown: 3 }] });
      const state = createPartyCombatState([
        makePlayer('Archer', 4, { className: 'Archer' }),
        knight('Knight', 1),
      ], [monster]);
      const r = runTo(state, 2400);
      expect(ofKind(r.events, 'stun')).toEqual([expect.objectContaining({
        t: 2400, src: { side: 'monster', pos: 4 }, dst: { side: 'player', pos: 4 }, durationMs: 1000,
      })]);
      expect(r.log).toContain('Scary casts Fear! Archer is stunned!');
      expect(player(state, 'Archer').stunRemainingMs).toBe(1000);
      expect(player(state, 'Knight').stunRemainingMs).toBe(0);
      runTo(state, 3400, r);
      expect(player(state, 'Archer').stunRemainingMs).toBe(0);
    });
  });
});

describe('seed monsters', () => {
  it('wolf and bandit carry their attack speeds', () => {
    expect(SEED_MONSTERS.wolf).toMatchObject({ attackInterval: 0.8, damage: 5 });
    expect(SEED_MONSTERS.bandit).toMatchObject({ attackInterval: 1.25, damage: 6 });
  });

  it('adds the goblin shaman and bandit cutthroat casters', () => {
    expect(SEED_MONSTERS.goblin_shaman).toMatchObject({
      hp: 18, damage: 3, damageType: 'magical', xp: 9, goldMin: 2, goldMax: 4,
      skills: [{ skillId: 'fireball', value: 4, cooldown: 5 }, { skillId: 'heal', value: 8, cooldown: 4 }],
    });
    expect(SEED_MONSTERS.goblin_shaman.description).toBeTruthy();
    expect(SEED_MONSTERS.bandit_cutthroat).toMatchObject({
      hp: 26, damage: 5, damageType: 'physical', xp: 18, goldMin: 3, goldMax: 6,
      skills: [{ skillId: 'assassinate', value: 12, cooldown: 6 }],
    });
    for (const m of Object.values(SEED_MONSTERS)) {
      for (const s of m.skills ?? []) expect(MONSTER_SKILL_CATALOG[s.skillId], `${m.id} ${s.skillId}`).toBeDefined();
    }
  });

  it('createMonsterInstance copies attackInterval and clones skills and resistances', () => {
    const def = { ...SEED_MONSTERS.goblin_shaman, resistances: [{ damageType: 'holy' as const, flatReduction: 1, percentReduction: 0 }] };
    const a = createMonsterInstance(SEED_MONSTERS.wolf, 0);
    expect(a.attackInterval).toBe(0.8);
    const b = createMonsterInstance(def, 1);
    b.skills![0].value = 99;
    b.resistances![0].flatReduction = 99;
    expect(def.skills![0].value).toBe(4);
    expect(def.resistances[0].flatReduction).toBe(1);
    expect(b.skillCooldowns).toEqual({ fireball: 0, heal: 0 });
    expect(b).not.toHaveProperty('stunTurns');
  });
});

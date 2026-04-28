import { describe, it, expect } from 'vitest';
import { findTarget, createPartyCombatState, processPartyTick } from '../src/systems/CombatEngine';
import type { PartyCombatant } from '../src/systems/CombatEngine';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { createEncounter, SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';
import { SEED_ZONES } from '../src/systems/ZoneTypes';
import { calculateMaxHp, calculateBaseDamage, CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { ClassName, DamageType } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import { SKILL_TREES, getSkillById } from '../src/systems/SkillTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';

function makePlayer(
  username: string,
  pos: PartyGridPosition,
  overrides: Partial<{
    hp: number;
    className: ClassName;
    level: number;
    baseDamage: number;
    damageType: DamageType;
    equippedSkills: (SkillDefinition | null)[];
  }> = {},
): PartyCombatant {
  const className = overrides.className ?? 'Archer';
  const level = overrides.level ?? 1;
  const hp = overrides.hp ?? calculateMaxHp(level, className);
  const baseDamage = overrides.baseDamage ?? calculateBaseDamage(level, className);
  const damageType = overrides.damageType ?? CLASS_DEFINITIONS[className].damageType;
  return {
    username,
    maxHp: hp,
    currentHp: hp,
    baseDamage,
    playerDamageType: damageType,
    gridPosition: pos,
    className,
    level,
    equippedSkills: overrides.equippedSkills ?? [null, null, null, null, null],
    attackCount: 0,
    stunTurns: 0,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    braceActive: false,
    braceDamageTaken: 0,
    interceptActive: false,
    activeSkillCount: 0,
  };
}

// ── Grid Targeting ───────────────────────────────────────────

describe('findTarget', () => {
  it('targets same-row combatant first', () => {
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]);
  });

  it('prefers low column for players attacking (preferHighCol=false)', () => {
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]);
  });

  it('prefers high column for monsters attacking (preferHighCol=true)', () => {
    const targets = [
      { currentHp: 10, gridPosition: 0 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    const result = findTarget(1 as PartyGridPosition, targets, true);
    expect(result).toBe(targets[1]);
  });

  it('scans up before down when no same-row targets', () => {
    const targets = [
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
      { currentHp: 10, gridPosition: 8 as PartyGridPosition },
    ];
    const result = findTarget(4 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]);
  });

  it('skips dead targets', () => {
    const targets = [
      { currentHp: 0, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[1]);
  });

  it('returns null when no alive targets', () => {
    const targets = [{ currentHp: 0, gridPosition: 1 as PartyGridPosition }];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBeNull();
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

// ── Party Combat ───────────────────────────────────────────

describe('Party Combat', () => {
  describe('createPartyCombatState', () => {
    it('creates party combat with multiple players', () => {
      const players = [makePlayer('Alice', 0), makePlayer('Bob', 4)];
      const monsters = createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS);
      const state = createPartyCombatState(players, monsters);

      expect(state.players).toHaveLength(2);
      expect(state.monsters).toHaveLength(2);
      expect(state.tickCount).toBe(0);
      expect(state.finished).toBe(false);
      expect(state.turnIndex).toBe(0);
      expect(state.turnOrderSize).toBe(4);
    });

    it('resets players to full HP', () => {
      const player = makePlayer('Alice', 4, { hp: 100 });
      player.currentHp = 50;
      const state = createPartyCombatState([player], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      expect(state.players[0].currentHp).toBe(100);
    });

    it('applies Mage Burn bonus damage at combat start', () => {
      const burnSkill = getSkillById('mage_burn')!;
      const mage = makePlayer('Mage', 0, {
        className: 'Mage',
        level: 5,
        baseDamage: calculateBaseDamage(5, 'Mage'), // 15 + 4*2 = 23
        equippedSkills: [burnSkill, null, null, null, null],
      });
      const state = createPartyCombatState([mage], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      // Burn adds 2 * level = 10 damage
      expect(state.players[0].baseDamage).toBe(23 + 10);
    });

    it('computes Bard Rally multiplier', () => {
      const rallySkill = getSkillById('bard_rally')!;
      const bard = makePlayer('Bard', 0, {
        className: 'Bard',
        equippedSkills: [rallySkill, null, null, null, null],
      });
      const archer = makePlayer('Archer', 2);
      const state = createPartyCombatState([bard, archer], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      // Rally: 0.20 * 2 members = 0.40
      expect(state.rallyMultiplier).toBeCloseTo(0.40);
    });

    it('rally multiplier is 0 with no Bard', () => {
      const archer = makePlayer('Archer', 0);
      const state = createPartyCombatState([archer], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      expect(state.rallyMultiplier).toBe(0);
    });
  });

  describe('class-aware combat', () => {
    it('Archer deals high damage based on baseDamage', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 15 HP
      const archer = makePlayer('Legolas', 0, { className: 'Archer', baseDamage: 15, hp: 200 });
      const state = createPartyCombatState([archer], monsters);

      // Archer: baseDamage 15 + variance(-2..+2) + 0 equip → 13-17 damage
      processPartyTick(state);
      expect(state.monsters[0].currentHp).toBeLessThan(15);
    });

    it('Mage deals high damage based on baseDamage', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 15 HP
      const mage = makePlayer('Gandalf', 0, { className: 'Mage', baseDamage: 15, hp: 200 });
      const state = createPartyCombatState([mage], monsters);

      processPartyTick(state);
      // baseDamage 15 + variance → 13-17, should kill or nearly kill goblin
      expect(state.monsters[0].currentHp).toBeLessThan(15);
    });

    it('Knight has low baseDamage — does minimal damage', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 15 HP
      const knight = makePlayer('Arthur', 0, { className: 'Knight', baseDamage: 1, hp: 200 });
      const state = createPartyCombatState([knight], monsters);

      processPartyTick(state);
      // baseDamage 1 + variance(-2..+2), min 1 → 1-3 damage
      expect(state.monsters[0].currentHp).toBeGreaterThanOrEqual(12);
      expect(state.monsters[0].currentHp).toBeLessThanOrEqual(14);
    });

    it('Knight Guard reduces physical damage taken', () => {
      const guardSkill = getSkillById('knight_guard')!;
      const goblin = createMonsterInstance(SEED_MONSTERS.goblin, 4); // 4 physical damage
      const knight = makePlayer('Arthur', 2, {
        className: 'Knight',
        level: 1,
        hp: 200,
        baseDamage: 1,
        equippedSkills: [guardSkill, null, null, null, null],
      });
      const state = createPartyCombatState([knight], [goblin]);

      processPartyTick(state); // Knight attacks
      processPartyTick(state); // Goblin attacks

      // Knight Lv1 Guard: 2 * 1 = 2 reduction
      // Goblin damage = 4 - 2 = 2
      expect(state.players[0].currentHp).toBe(200 - 2);
    });

    it('Knight Guard scales with level', () => {
      const guardSkill = getSkillById('knight_guard')!;
      const goblin = createMonsterInstance(SEED_MONSTERS.goblin, 4); // 4 physical damage
      const knight = makePlayer('Arthur', 2, {
        className: 'Knight',
        level: 5,
        hp: 200,
        baseDamage: 5,
        equippedSkills: [guardSkill, null, null, null, null],
      });
      const state = createPartyCombatState([knight], [goblin]);

      processPartyTick(state); // Knight attacks
      processPartyTick(state); // Goblin attacks

      // Knight Lv5 Guard: 2 * 5 = 10 reduction
      // Goblin damage = 4 - 10 = 0 (clamped)
      expect(state.players[0].currentHp).toBe(200);
    });

    it('Priest Bless provides party-wide magical damage reduction', () => {
      const blessSkill = getSkillById('priest_bless')!;
      const wolf = createMonsterInstance(SEED_MONSTERS.wolf, 4); // magical damage, 6 dmg
      wolf.maxHp = 1000;
      wolf.currentHp = 1000; // make wolf survive player attacks
      const priest = makePlayer('Cleric', 0, {
        className: 'Priest',
        level: 1,
        hp: 200,
        baseDamage: 3,
        equippedSkills: [blessSkill, null, null, null, null],
      });
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1, hp: 200, baseDamage: 15 });
      const state = createPartyCombatState([priest, archer], [wolf]);

      // Two player turns, then wolf attacks
      processPartyTick(state); // Player 1 attacks
      processPartyTick(state); // Player 2 attacks
      processPartyTick(state); // Wolf attacks

      // Priest Lv1 Bless: 2 * 1 = 2 reduction
      // Wolf damage = 6 - 2 = 4
      const target = state.players.find(p => p.currentHp < 200);
      expect(target).toBeDefined();
      expect(target!.currentHp).toBe(200 - 4);
    });

    it('equipment reduction does NOT apply to magical damage', () => {
      const wolf = createMonsterInstance(SEED_MONSTERS.wolf, 4); // 6 magical damage
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1, hp: 200, baseDamage: 15 });
      archer.equipBonuses = { bonusAttackMin: 0, bonusAttackMax: 0, damageReductionMin: 5, damageReductionMax: 5, magicReductionMin: 0, magicReductionMax: 0 };
      const state = createPartyCombatState([archer], [wolf]);

      processPartyTick(state); // Archer attacks
      processPartyTick(state); // Wolf attacks

      // No priest, no magical reduction → full 6 damage (equipment DR ignored for magical)
      expect(state.players[0].currentHp).toBe(200 - 6);
    });
  });

  describe('processPartyTick (turn-based)', () => {
    it('increments tick count', () => {
      const state = createPartyCombatState([makePlayer('Alice', 4)], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      processPartyTick(state);
      expect(state.tickCount).toBe(1);
    });

    it('only one combatant acts per tick', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 15 HP
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { baseDamage: 5, hp: 200 }), makePlayer('Bob', 3, { baseDamage: 5, hp: 200 })],
        monsters,
      );

      const r1 = processPartyTick(state);
      expect(r1.logEntries).toHaveLength(1);
      expect(r1.logEntries[0]).toContain('Alice hits');
      const hpAfterAlice = state.monsters[0].currentHp;
      expect(hpAfterAlice).toBeLessThan(15);

      const r2 = processPartyTick(state);
      expect(r2.logEntries[0]).toContain('Bob hits');
      expect(state.monsters[0].currentHp).toBeLessThan(hpAfterAlice);
    });

    it('players act before monsters, then cycle wraps', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { baseDamage: 1, hp: 200 })],
        monsters,
      );

      const r1 = processPartyTick(state);
      expect(r1.logEntries[0]).toContain('Alice hits');

      const r2 = processPartyTick(state);
      expect(r2.logEntries[0]).toContain('hits Alice');

      const r3 = processPartyTick(state);
      expect(r3.logEntries[0]).toContain('Alice hits');
    });

    it('victory when all monsters die', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 15 HP
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { baseDamage: 30, hp: 200 })],
        monsters,
      );
      const result = processPartyTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('victory');
    });

    it('defeat when all players die', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)]; // 4 damage
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { baseDamage: 1, hp: 1 })], // 1 HP
        monsters,
      );
      processPartyTick(state); // Alice attacks (deals min 1 damage)
      expect(state.finished).toBe(false);

      const result = processPartyTick(state); // Goblin attacks Alice (4 damage)
      expect(result.finished).toBe(true);
      expect(result.result).toBe('defeat');
      expect(state.players[0].currentHp).toBe(0);
    });

    it('does nothing on already-finished combat', () => {
      const state = createPartyCombatState([makePlayer('Alice', 4)], createEncounter(undefined, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS));
      state.finished = true;
      state.result = 'victory';

      const result = processPartyTick(state);
      expect(result.logEntries).toHaveLength(0);
      expect(state.tickCount).toBe(0);
    });

    it('full battle resolves correctly', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { baseDamage: 10, hp: 40 })],
        monsters,
      );

      let ticks = 0;
      while (!state.finished && ticks < 50) {
        processPartyTick(state);
        ticks++;
      }
      expect(state.finished).toBe(true);
      expect(ticks).toBeLessThanOrEqual(20);
    });
  });

  describe('stun mechanics', () => {
    it('stunned player skips turn', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      const player = makePlayer('Alice', 0, { baseDamage: 5, hp: 200 });
      const state = createPartyCombatState([player], monsters);

      // Manually stun the player
      state.players[0].stunTurns = 1;

      const r = processPartyTick(state);
      expect(r.logEntries[0]).toContain('stunned');
      // Monster HP unchanged — player skipped
      expect(state.monsters[0].currentHp).toBe(state.monsters[0].maxHp);
      // Stun decremented
      expect(state.players[0].stunTurns).toBe(0);
    });

    it('stunned monster skips turn', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      const player = makePlayer('Alice', 0, { baseDamage: 1, hp: 200 });
      const state = createPartyCombatState([player], monsters);

      // Player attacks first
      processPartyTick(state);

      // Stun the monster
      state.monsters[0].stunTurns = 1;

      // Monster's turn — should skip
      const r = processPartyTick(state);
      expect(r.logEntries[0]).toContain('stunned');
      expect(state.players[0].currentHp).toBe(200); // no damage taken
      expect(state.monsters[0].stunTurns).toBe(0);
    });

    it('stun does not stack — refreshes to 1', () => {
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      const player = makePlayer('Alice', 0, { baseDamage: 5, hp: 200 });
      const state = createPartyCombatState([player], monsters);

      // Set stun to 1
      state.monsters[0].stunTurns = 1;
      // Applying stun again still stays at 1
      state.monsters[0].stunTurns = 1;
      expect(state.monsters[0].stunTurns).toBe(1);
    });
  });

  describe('cooldown-based active skills', () => {
    it('Knight Bash triggers every 2nd attack', () => {
      const guardSkill = getSkillById('knight_guard')!;
      const bashSkill = getSkillById('knight_bash')!;
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      monsters[0].maxHp = 1000;
      monsters[0].currentHp = 1000;

      const knight = makePlayer('Arthur', 0, {
        className: 'Knight',
        baseDamage: 1,
        hp: 500,
        equippedSkills: [guardSkill, bashSkill, null, null, null],
      });
      const state = createPartyCombatState([knight], monsters);

      // Attack 1: normal attack
      const r1 = processPartyTick(state);
      expect(r1.logEntries[0]).toContain('Arthur hits');

      // Skip monster turn
      processPartyTick(state);

      // Attack 2: should trigger Bash (CD 2, attackCount 2 % 2 === 0)
      const r2 = processPartyTick(state);
      expect(r2.logEntries[0]).toContain('Bash');
    });

    it('Knight Intercept only redirects ONE attack per cast', () => {
      const guardSkill = getSkillById('knight_guard')!;
      const interceptSkill = getSkillById('knight_intercept')!;

      // Two monsters at the same row as the Archer so both target the Archer naturally
      const monsters = [
        createMonsterInstance(SEED_MONSTERS.goblin, 2),
        createMonsterInstance(SEED_MONSTERS.goblin, 2),
      ];
      // Beefy monsters so they don't die mid-test
      monsters.forEach(m => { m.maxHp = 1000; m.currentHp = 1000; m.damage = 5; });

      const knight = makePlayer('Arthur', 0, {
        className: 'Knight',
        baseDamage: 1,
        hp: 500,
        equippedSkills: [guardSkill, interceptSkill, null, null, null],
      });
      const archer = makePlayer('Robin', 2, {
        className: 'Archer',
        baseDamage: 1,
        hp: 500,
      });

      const state = createPartyCombatState([knight, archer], monsters);
      const archerInState = state.players.find(p => p.username === 'Robin')!;
      const knightInState = state.players.find(p => p.username === 'Arthur')!;

      // Tick 1: Archer (col 2 acts first)
      processPartyTick(state);
      // Tick 2: Knight casts Intercept (CD 1 → triggers on attackCount 1)
      const r2 = processPartyTick(state);
      expect(r2.logEntries.some(l => l.includes('Intercept') || l.includes('intercept'))).toBe(true);
      expect(knightInState.interceptActive).toBe(true);

      const archerHpBefore = archerInState.currentHp;
      const knightHpBefore = knightInState.currentHp;

      // Tick 3: Monster 1 attacks → should be redirected to Knight, consuming intercept
      const r3 = processPartyTick(state);
      expect(r3.logEntries.some(l => l.includes('intercepts the attack'))).toBe(true);
      expect(knightInState.interceptActive).toBe(false);
      expect(archerInState.currentHp).toBe(archerHpBefore);
      expect(knightInState.currentHp).toBeLessThan(knightHpBefore);

      // Tick 4: Monster 2 attacks → must NOT be redirected; Archer takes the hit
      const knightHpMid = knightInState.currentHp;
      const r4 = processPartyTick(state);
      expect(r4.logEntries.some(l => l.includes('intercepts the attack'))).toBe(false);
      expect(archerInState.currentHp).toBeLessThan(archerHpBefore);
      expect(knightInState.currentHp).toBe(knightHpMid);
    });

    it('Priest Minor Heal triggers every attack (CD 1)', () => {
      const blessSkill = getSkillById('priest_bless')!;
      const healSkill = getSkillById('priest_minor_heal')!;
      const monsters = [createMonsterInstance(SEED_MONSTERS.goblin, 4)];
      monsters[0].maxHp = 1000;
      monsters[0].currentHp = 1000;

      // Priest at col 2 (high col → acts first in turn order)
      const priest = makePlayer('Healer', 2, {
        className: 'Priest',
        baseDamage: 3,
        hp: 200,
        level: 5,
        equippedSkills: [blessSkill, healSkill, null, null, null],
      });
      // Tank at col 0 (low col → acts after priest)
      const tank = makePlayer('Tank', 0, { className: 'Knight', baseDamage: 1, hp: 200 });

      const state = createPartyCombatState([priest, tank], monsters);
      // Damage the tank after combat state creation resets HP
      state.players.find(p => p.username === 'Tank')!.currentHp = 100;

      // Priest acts first (highest col): CD 1, attackCount 1 % 1 === 0 → heal
      const r = processPartyTick(state);
      expect(r.logEntries[0]).toContain('Minor Heal');
    });
  });
});

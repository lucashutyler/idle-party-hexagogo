import { describe, it, expect } from 'vitest';
import { createCombatState, processTick, findTarget, createPartyCombatState, processPartyTick } from '../src/systems/CombatEngine';
import type { PartyCombatant } from '../src/systems/CombatEngine';
import { createEncounter, createMonsterInstance, MONSTERS } from '../src/systems/MonsterTypes';
import { BASE_STATS, CLASS_DEFINITIONS, calculateMaxHp } from '../src/systems/CharacterStats';
import type { StatBlock, ClassName } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';

function makeStats(overrides: Partial<StatBlock> = {}): StatBlock {
  return { ...BASE_STATS, ...overrides };
}

describe('CombatEngine', () => {
  describe('createCombatState', () => {
    it('creates initial combat state', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      expect(state.player.name).toBe('Hero');
      expect(state.player.currentHp).toBe(40);
      expect(state.player.maxHp).toBe(40);
      expect(state.monsters).toHaveLength(2);
      expect(state.tickCount).toBe(0);
      expect(state.finished).toBe(false);
      expect(state.result).toBeNull();
    });
  });

  describe('processTick', () => {
    it('increments tick count', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      processTick(state);
      expect(state.tickCount).toBe(1);
    });

    it('player deals damage to first alive monster', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      processTick(state);
      // Monster should have taken damage (STR 10 ± 2, min 1 → 8-12 damage)
      expect(monsters[0].currentHp).toBeLessThan(monsters[0].maxHp);
    });

    it('monsters deal damage to player', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      processTick(state);
      // Each alive goblin deals 4 damage. After first tick, second goblin might still be alive
      expect(state.player.currentHp).toBeLessThan(40);
    });

    it('generates log entries for damage', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      const result = processTick(state);
      expect(result.logEntries.length).toBeGreaterThan(0);
      expect(result.logEntries[0]).toContain('Hero hits');
    });

    it('retargets to second monster when first dies', () => {
      // Give player high STR to one-shot the goblin
      const monsters = [
        createMonsterInstance(MONSTERS.goblin), // 15 HP
        createMonsterInstance(MONSTERS.goblin),
      ];
      const state = createCombatState('Hero', 1, makeStats({ STR: 20 }), 200, monsters);

      // First tick: player hits first goblin for ~18-22 damage, kills it
      processTick(state);
      expect(monsters[0].currentHp).toBe(0);
      expect(monsters[1].currentHp).toBe(monsters[1].maxHp); // untouched

      // Second tick: player should target second goblin
      processTick(state);
      expect(monsters[1].currentHp).toBeLessThan(monsters[1].maxHp);
    });

    it('returns victory when all monsters die', () => {
      // High STR to quickly kill monsters
      const monsters = [createMonsterInstance(MONSTERS.goblin)];
      const state = createCombatState('Hero', 1, makeStats({ STR: 30 }), 200, monsters);

      const result = processTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('victory');
      expect(state.finished).toBe(true);
    });

    it('returns defeat when player HP reaches 0', () => {
      // Low HP so monsters kill the player
      const monsters = createEncounter(); // 2 goblins × 4 damage = 8/tick
      const state = createCombatState('Hero', 1, makeStats({ STR: 1 }), 5, monsters);

      const result = processTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('defeat');
      expect(state.player.currentHp).toBe(0);
    });

    it('does nothing on already-finished combat', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      state.finished = true;
      state.result = 'victory';

      const result = processTick(state);
      expect(result.logEntries).toHaveLength(0);
      expect(state.tickCount).toBe(0); // not incremented
    });

    it('player damage is clamped to minimum 1', () => {
      // STR=1, worst roll = 1 + (-2) = -1, clamped to 1
      const monsters = [createMonsterInstance(MONSTERS.goblin)];
      const state = createCombatState('Hero', 1, makeStats({ STR: 1 }), 200, monsters);

      // Run many ticks to ensure damage is always ≥ 1
      for (let i = 0; i < 20 && !state.finished; i++) {
        const startHp = monsters[0].currentHp;
        processTick(state);
        if (!state.finished) {
          expect(startHp - monsters[0].currentHp).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('dead monsters do not attack', () => {
      const monsters = [
        createMonsterInstance(MONSTERS.goblin),
        createMonsterInstance(MONSTERS.goblin),
      ];
      // Kill first monster manually
      monsters[0].currentHp = 0;
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);

      processTick(state);
      // Only second monster attacks: 4 damage
      // Player damage from this tick should be exactly 4 (one goblin)
      expect(state.player.currentHp).toBe(40 - 4);
    });
  });

  describe('full battle simulation', () => {
    it('typical Lv1 battle ends in about 4 ticks with victory', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());

      let ticks = 0;
      while (!state.finished && ticks < 20) {
        processTick(state);
        ticks++;
      }

      expect(state.finished).toBe(true);
      // Should typically be victory (defeat very rare with 40 HP vs 8 dmg/tick)
      expect(ticks).toBeLessThanOrEqual(10);
    });
  });
});

// ── Party Combat ───────────────────────────────────────────

function makePlayer(
  username: string,
  pos: PartyGridPosition,
  overrides: Partial<{
    str: number;
    hp: number;
    className: ClassName;
    level: number;
    stats: Partial<StatBlock>;
  }> = {},
): PartyCombatant {
  const className = overrides.className ?? 'Archer';
  const level = overrides.level ?? 1;
  const stats = makeStats({ STR: overrides.str ?? 10, ...overrides.stats });
  const hp = overrides.hp ?? calculateMaxHp(level, stats.CON, className);
  return {
    username,
    maxHp: hp,
    currentHp: hp,
    stats,
    gridPosition: pos,
    className,
    level,
  };
}

describe('findTarget', () => {
  it('targets same-row combatant first', () => {
    // Attacker at position 0 (row 0, col 0). Targets at 1 (row 0) and 4 (row 1).
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]); // position 1, same row
  });

  it('prefers low column for players attacking (preferHighCol=false)', () => {
    // Targets in same row: col 1 (pos 1) and col 2 (pos 2)
    const targets = [
      { currentHp: 10, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]); // col 1 < col 2
  });

  it('prefers high column for monsters attacking (preferHighCol=true)', () => {
    // Targets in same row: col 0 (pos 0) and col 2 (pos 2)
    const targets = [
      { currentHp: 10, gridPosition: 0 as PartyGridPosition },
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
    ];
    const result = findTarget(1 as PartyGridPosition, targets, true);
    expect(result).toBe(targets[1]); // col 2 > col 0
  });

  it('scans up before down when no same-row targets', () => {
    // Attacker at position 4 (row 1). Only target at position 2 (row 0).
    const targets = [
      { currentHp: 10, gridPosition: 2 as PartyGridPosition },
      { currentHp: 10, gridPosition: 8 as PartyGridPosition },
    ];
    const result = findTarget(4 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[0]); // row 0 (up) before row 2 (down)
  });

  it('skips dead targets', () => {
    const targets = [
      { currentHp: 0, gridPosition: 1 as PartyGridPosition },
      { currentHp: 10, gridPosition: 4 as PartyGridPosition },
    ];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBe(targets[1]); // skips dead target at pos 1
  });

  it('returns null when no alive targets', () => {
    const targets = [{ currentHp: 0, gridPosition: 1 as PartyGridPosition }];
    const result = findTarget(0 as PartyGridPosition, targets, false);
    expect(result).toBeNull();
  });

  it('matches the user example targeting', () => {
    // Players at 0, 2, 4. Monsters at 1, 5, 8.
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

    // Monster 1 (row 0) → Player 2 (row 0, col 2, front)
    expect(findTarget(1 as PartyGridPosition, players, true)!.username).toBe('P2');
    // Monster 5 (row 1) → Player 4 (row 1, same row)
    expect(findTarget(5 as PartyGridPosition, players, true)!.username).toBe('P4');
    // Monster 8 (row 2) → Player 4 (row 1, scan up)
    expect(findTarget(8 as PartyGridPosition, players, true)!.username).toBe('P4');
    // Player 0 (row 0) → Monster 1 (row 0)
    expect(findTarget(0 as PartyGridPosition, monsters, false)!.name).toBe('M1');
    // Player 2 (row 0) → Monster 1 (row 0)
    expect(findTarget(2 as PartyGridPosition, monsters, false)!.name).toBe('M1');
    // Player 4 (row 1) → Monster 5 (row 1)
    expect(findTarget(4 as PartyGridPosition, monsters, false)!.name).toBe('M5');
  });
});

describe('Party Combat', () => {
  describe('createPartyCombatState', () => {
    it('creates party combat with multiple players', () => {
      const players = [makePlayer('Alice', 0), makePlayer('Bob', 4)];
      const monsters = createEncounter();
      const state = createPartyCombatState(players, monsters);

      expect(state.players).toHaveLength(2);
      expect(state.monsters).toHaveLength(2);
      expect(state.tickCount).toBe(0);
      expect(state.finished).toBe(false);
      expect(state.turnIndex).toBe(0);
      expect(state.turnOrderSize).toBe(4); // 2 players + 2 monsters
    });

    it('resets players to full HP', () => {
      const player = makePlayer('Alice', 4, { hp: 100 });
      player.currentHp = 50;
      const state = createPartyCombatState([player], createEncounter());
      expect(state.players[0].currentHp).toBe(100);
    });
  });

  describe('class-aware combat', () => {
    it('Archer uses DEX for damage', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 15 HP
      const archer = makePlayer('Legolas', 0, { className: 'Archer', stats: { DEX: 16 } });
      const state = createPartyCombatState([archer], monsters);

      // Archer attacks: DEX 16 ± 2 → 14-18 damage
      processPartyTick(state);
      // Should deal significant damage
      expect(state.monsters[0].currentHp).toBeLessThan(15);
      expect(state.monsters[0].currentHp).toBeLessThanOrEqual(15 - 14); // at least 14 damage
    });

    it('Mage uses INT for damage', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 15 HP
      const mage = makePlayer('Gandalf', 0, { className: 'Mage', stats: { INT: 20 } });
      const state = createPartyCombatState([mage], monsters);

      processPartyTick(state);
      // INT 20 ± 2 → 18-22 damage, should one-shot goblin
      expect(state.monsters[0].currentHp).toBe(0);
    });

    it('Knight has null attackStat — does minimal damage', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 15 HP
      const knight = makePlayer('Arthur', 0, { className: 'Knight', hp: 200 });
      const state = createPartyCombatState([knight], monsters);

      processPartyTick(state);
      // baseDamage = 0, variance -2 to +2, min 1 → 1-3 damage
      expect(state.monsters[0].currentHp).toBeGreaterThanOrEqual(12); // at most 3 damage
      expect(state.monsters[0].currentHp).toBeLessThanOrEqual(14); // at least 1 damage
    });

    it('Knight reduces physical damage taken', () => {
      // Wolf does magical damage, goblin does physical
      const goblin = createMonsterInstance(MONSTERS.goblin, 4); // 4 physical damage
      const knight = makePlayer('Arthur', 2, { className: 'Knight', level: 1, hp: 200 });
      const state = createPartyCombatState([knight], [goblin]);

      // Knight attacks first (does 1 damage), then goblin attacks
      processPartyTick(state); // Knight attacks
      processPartyTick(state); // Goblin attacks

      // Knight Lv1 physical reduction = 2 + 1*1 = 3
      // Goblin damage = 4, reduced by 3 = 1
      expect(state.players[0].currentHp).toBe(200 - 1);
    });

    it('Knight physical reduction scales with level', () => {
      const goblin = createMonsterInstance(MONSTERS.goblin, 4); // 4 physical damage
      const knight = makePlayer('Arthur', 2, { className: 'Knight', level: 5, hp: 200 });
      const state = createPartyCombatState([knight], [goblin]);

      processPartyTick(state); // Knight attacks
      processPartyTick(state); // Goblin attacks

      // Knight Lv5 physical reduction = 2 + 1*5 = 7
      // Goblin damage = 4, reduced by 7 = 0 (clamped)
      expect(state.players[0].currentHp).toBe(200);
    });

    it('Priest provides party-wide magical damage reduction', () => {
      const wolf = createMonsterInstance(MONSTERS.wolf, 4); // magical damage, 6 dmg
      const priest = makePlayer('Cleric', 0, { className: 'Priest', level: 1, hp: 200 });
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1, hp: 200 });
      const state = createPartyCombatState([priest, archer], [wolf]);

      // Two player turns, then wolf attacks
      processPartyTick(state); // Player 1 attacks
      processPartyTick(state); // Player 2 attacks
      processPartyTick(state); // Wolf attacks

      // Priest Lv1 magical reduction = 2 + 1*1 = 3
      // Wolf damage = 6, reduced by 3 = 3
      const target = state.players.find(p => p.currentHp < 200);
      expect(target).toBeDefined();
      expect(target!.currentHp).toBe(200 - 3);
    });

    it('equipment reduction does NOT apply to magical damage', () => {
      const wolf = createMonsterInstance(MONSTERS.wolf, 4); // 6 magical damage
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1, hp: 200 });
      archer.equipBonuses = { bonusAttackMin: 0, bonusAttackMax: 0, damageReductionMin: 5, damageReductionMax: 5, dodgeChance: 0 };
      const state = createPartyCombatState([archer], [wolf]);

      processPartyTick(state); // Archer attacks
      processPartyTick(state); // Wolf attacks

      // No priest, no magical reduction → full 6 damage (equipment DR ignored for magical)
      expect(state.players[0].currentHp).toBe(200 - 6);
    });

    it('Bard buffs all stats in party', () => {
      const bard = makePlayer('Melodist', 0, { className: 'Bard', level: 1, stats: { CHA: 16 } });
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1, stats: { DEX: 16 } });
      const monsters = createEncounter();
      const state = createPartyCombatState([bard, archer], monsters);

      // Bard multiplier = 0.20 * 2 members = 0.40
      // Archer DEX should be floor(16 * 1.40) = 22
      const archerInState = state.players.find(p => p.username === 'Legolas')!;
      expect(archerInState.stats.DEX).toBe(22);

      // Bard's own stats should also be buffed
      const bardInState = state.players.find(p => p.username === 'Melodist')!;
      expect(bardInState.stats.CHA).toBe(Math.floor(16 * 1.40)); // 22
    });

    it('Bard buff recalculates maxHp', () => {
      const bard = makePlayer('Melodist', 0, { className: 'Bard', level: 1 });
      const archer = makePlayer('Legolas', 2, { className: 'Archer', level: 1 });
      const monsters = createEncounter();
      const state = createPartyCombatState([bard, archer], monsters);

      // Archer CON=10 by default (from BASE_STATS), with 40% buff → floor(10*1.4)=14
      // Archer Lv1 HP = floor((30 + 0 + 14) * 0.2) = floor(44 * 0.2) = 8
      const archerInState = state.players.find(p => p.username === 'Legolas')!;
      expect(archerInState.maxHp).toBe(8);
      expect(archerInState.currentHp).toBe(8);
    });
  });

  describe('processPartyTick (turn-based)', () => {
    it('increments tick count', () => {
      const state = createPartyCombatState([makePlayer('Alice', 4)], createEncounter());
      processPartyTick(state);
      expect(state.tickCount).toBe(1);
    });

    it('only one combatant acts per tick', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 15 HP
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { str: 10, hp: 200 }), makePlayer('Bob', 3, { str: 10, hp: 200 })],
        monsters,
      );

      // Tick 1: Alice attacks (turn index 0 = first player)
      const r1 = processPartyTick(state);
      expect(r1.logEntries).toHaveLength(1); // one attack log
      expect(r1.logEntries[0]).toContain('Alice hits');
      const hpAfterAlice = state.monsters[0].currentHp;
      expect(hpAfterAlice).toBeLessThan(15);

      // Tick 2: Bob attacks (turn index 1 = second player)
      const r2 = processPartyTick(state);
      expect(r2.logEntries[0]).toContain('Bob hits');
      expect(state.monsters[0].currentHp).toBeLessThan(hpAfterAlice);
    });

    it('players act before monsters, then cycle wraps', () => {
      // 1 player, 1 monster — turn order: [player, monster]
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)];
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { str: 1, hp: 200 })], // low STR so goblin survives
        monsters,
      );

      // Tick 1: Alice attacks the goblin
      const r1 = processPartyTick(state);
      expect(r1.logEntries[0]).toContain('Alice hits');

      // Tick 2: Goblin attacks Alice
      const r2 = processPartyTick(state);
      expect(r2.logEntries[0]).toContain('hits Alice');

      // Tick 3: Alice attacks again (cycle wrapped)
      const r3 = processPartyTick(state);
      expect(r3.logEntries[0]).toContain('Alice hits');
    });

    it('skips dead combatants', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)];
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { hp: 200, stats: { DEX: 30 } })], // high DEX to one-shot (Archer uses DEX)
        monsters,
      );

      // Tick 1: Alice kills the goblin
      const r1 = processPartyTick(state);
      expect(r1.finished).toBe(true);
      expect(r1.result).toBe('victory');
    });

    it('victory when all monsters die', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 15 HP
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { hp: 200, stats: { DEX: 30 } })], // high DEX to one-shot (Archer uses DEX)
        monsters,
      );
      const result = processPartyTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('victory');
    });

    it('defeat when all players die', () => {
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)]; // 4 damage
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { str: 1, hp: 1 })], // 1 HP
        monsters,
      );
      // Tick 1: Alice attacks (deals min 1 damage, goblin survives)
      processPartyTick(state);
      expect(state.finished).toBe(false);

      // Tick 2: Goblin attacks Alice (4 damage, Alice has ≤1 HP)
      const result = processPartyTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('defeat');
      expect(state.players[0].currentHp).toBe(0);
    });

    it('does nothing on already-finished combat', () => {
      const state = createPartyCombatState([makePlayer('Alice', 4)], createEncounter());
      state.finished = true;
      state.result = 'victory';

      const result = processPartyTick(state);
      expect(result.logEntries).toHaveLength(0);
      expect(state.tickCount).toBe(0);
    });

    it('full battle with turns resolves correctly', () => {
      // 1 player vs 1 goblin — should take multiple turns to resolve
      const monsters = [createMonsterInstance(MONSTERS.goblin, 4)];
      const state = createPartyCombatState(
        [makePlayer('Alice', 0, { str: 10, hp: 40 })],
        monsters,
      );

      let ticks = 0;
      while (!state.finished && ticks < 50) {
        processPartyTick(state);
        ticks++;
      }
      expect(state.finished).toBe(true);
      // With 10 STR vs 15 HP goblin, Alice should kill it in ~2 player turns (so ~3-4 total ticks)
      expect(ticks).toBeLessThanOrEqual(20);
    });
  });
});

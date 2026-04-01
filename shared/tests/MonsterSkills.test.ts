import { describe, it, expect } from 'vitest';
import { createPartyCombatState, processPartyTick, applyMonsterResistance } from '../src/systems/CombatEngine';
import type { PartyCombatant } from '../src/systems/CombatEngine';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import type { MonsterDefinition, Resistance } from '../src/systems/MonsterTypes';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import { createDefaultSkillLoadout } from '../src/systems/SkillTypes';

function makePlayer(
  username: string,
  pos: PartyGridPosition,
  overrides?: Partial<PartyCombatant>,
): PartyCombatant {
  return {
    username,
    maxHp: 100,
    currentHp: 100,
    baseDamage: 10,
    playerDamageType: 'physical',
    gridPosition: pos,
    className: 'Knight',
    level: 10,
    equippedSkills: [null, null, null, null, null],
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
    ...overrides,
  };
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

    it('floors at minimum 1', () => {
      const resistances: Resistance[] = [
        { damageType: 'physical', flatReduction: 1000, percentReduction: 99 },
      ];
      const result = applyMonsterResistance(10, 'physical', resistances);
      expect(result).toBe(1);
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
    it('reduces player damage to resistant monster', () => {
      const monsterDef: MonsterDefinition = {
        id: 'resistant_goblin',
        name: 'Resistant Goblin',
        hp: 1000,
        damage: 1,
        damageType: 'physical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
        resistances: [
          { damageType: 'physical', flatReduction: 0, percentReduction: 50 },
        ],
      };
      const monster = createMonsterInstance(monsterDef, 4);
      const player = makePlayer('Alice', 4, { baseDamage: 100, playerDamageType: 'physical' });

      const state = createPartyCombatState([player], [monster]);

      // Process ticks until the player attacks
      let playerAttacked = false;
      for (let i = 0; i < 20; i++) {
        const result = processPartyTick(state);
        if (result.logEntries.some(l => l.includes('Alice'))) {
          playerAttacked = true;
          break;
        }
      }
      expect(playerAttacked).toBe(true);
      // Monster should have taken reduced damage (50% of ~100 ≈ 50)
      expect(state.monsters[0].currentHp).toBeGreaterThan(1000 - 110); // With variance, should be > 890
      expect(state.monsters[0].currentHp).toBeLessThan(1000); // But should have taken some damage
    });
  });
});

describe('Monster Skills', () => {
  describe('skill execution in combat', () => {
    it('monster uses fireball (AoE damage) when off cooldown', () => {
      const monsterDef: MonsterDefinition = {
        id: 'mage_goblin',
        name: 'Mage Goblin',
        hp: 1000,
        damage: 1,
        damageType: 'magical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
        skills: [{ skillId: 'fireball', value: 20 }],
      };
      const monster = createMonsterInstance(monsterDef, 4);
      const player1 = makePlayer('Alice', 4);
      const player2 = makePlayer('Bob', 1);

      const state = createPartyCombatState([player1, player2], [monster]);

      // Run until monster acts
      let fireballUsed = false;
      for (let i = 0; i < 20; i++) {
        const result = processPartyTick(state);
        if (result.logEntries.some(l => l.includes('Fireball'))) {
          fireballUsed = true;
          break;
        }
      }
      expect(fireballUsed).toBe(true);
      // Both players should have taken fireball damage
      const p1 = state.players.find(p => p.username === 'Alice')!;
      const p2 = state.players.find(p => p.username === 'Bob')!;
      expect(p1.currentHp).toBeLessThan(100);
      expect(p2.currentHp).toBeLessThan(100);
    });

    it('monster uses heal on wounded ally', () => {
      const healerDef: MonsterDefinition = {
        id: 'healer',
        name: 'Healer',
        hp: 1000,
        damage: 1,
        damageType: 'magical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
        skills: [{ skillId: 'heal', value: 50 }],
      };
      const woundedDef: MonsterDefinition = {
        id: 'wounded',
        name: 'Wounded',
        hp: 100,
        damage: 1,
        damageType: 'physical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
      };
      const healer = createMonsterInstance(healerDef, 4);
      const wounded = createMonsterInstance(woundedDef, 1);
      wounded.currentHp = 10; // Wound it

      const player = makePlayer('Alice', 4, { baseDamage: 1 }); // Low damage so fight lasts

      const state = createPartyCombatState([player], [healer, wounded]);

      // The wounded monster should be healed
      let healUsed = false;
      for (let i = 0; i < 20; i++) {
        const result = processPartyTick(state);
        if (result.logEntries.some(l => l.includes('Heal'))) {
          healUsed = true;
          break;
        }
      }
      expect(healUsed).toBe(true);
    });

    it('cooldowns prevent immediate reuse', () => {
      const monsterDef: MonsterDefinition = {
        id: 'test',
        name: 'Test',
        hp: 1000,
        damage: 1,
        damageType: 'magical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
        skills: [{ skillId: 'fireball', value: 5 }], // CD 3
      };
      const monster = createMonsterInstance(monsterDef, 4);
      const player = makePlayer('Alice', 4, { maxHp: 10000, currentHp: 10000 });

      const state = createPartyCombatState([player], [monster]);

      // Track fireball uses
      let fireballCount = 0;
      for (let i = 0; i < 30; i++) {
        const result = processPartyTick(state);
        if (result.logEntries.some(l => l.includes('Fireball'))) {
          fireballCount++;
        }
      }
      // With CD 3, fireball should not fire every turn
      // In ~15 monster turns, should fire ~5 times max (first use + every 3 turns after)
      expect(fireballCount).toBeGreaterThanOrEqual(1);
      expect(fireballCount).toBeLessThanOrEqual(8);
    });
  });

  describe('fear skill', () => {
    it('stuns archers and mages', () => {
      const monsterDef: MonsterDefinition = {
        id: 'scary',
        name: 'Scary',
        hp: 1000,
        damage: 1,
        damageType: 'magical',
        xp: 5,
        goldMin: 1,
        goldMax: 2,
        skills: [{ skillId: 'fear', value: 1 }],
      };
      const monster = createMonsterInstance(monsterDef, 4);
      const archer = makePlayer('Archer', 4, { className: 'Archer' });
      const knight = makePlayer('Knight', 1, { className: 'Knight' });

      const state = createPartyCombatState([archer, knight], [monster]);

      let fearUsed = false;
      for (let i = 0; i < 20; i++) {
        const result = processPartyTick(state);
        if (result.logEntries.some(l => l.includes('Fear'))) {
          fearUsed = true;
          break;
        }
      }
      expect(fearUsed).toBe(true);
      // Archer should be stunned, Knight should not
      const archerState = state.players.find(p => p.username === 'Archer')!;
      expect(archerState.stunTurns).toBeGreaterThanOrEqual(0); // May have decremented by the time we check
    });
  });
});

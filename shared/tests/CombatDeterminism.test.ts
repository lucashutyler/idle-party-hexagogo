import { afterEach, describe, it, expect, vi } from 'vitest';
import { advanceCombat, cloneCombatState, createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import type { PartyCombatantInit, PartyCombatState } from '../src/systems/CombatEngine';
import type { CombatEvent } from '../src/systems/CombatEvents';
import { createRng } from '../src/systems/combat/CombatRng';
import { createEncounter, resolveEncounter, SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';
import { SEED_ZONES } from '../src/systems/ZoneTypes';
import { SEED_MONSTERS } from '../src/systems/MonsterTypes';
import type { MonsterInstance } from '../src/systems/MonsterTypes';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import type { EquipmentBonuses } from '../src/systems/ItemTypes';
import { makeMonster, makePlayer } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

const GEAR: EquipmentBonuses = {
  bonusAttackMin: 1, bonusAttackMax: 6, damageReductionMin: 2, damageReductionMax: 8, magicReductionMin: 1, magicReductionMax: 4,
};

function richParty(hpScale = 1): PartyCombatantInit[] {
  const s = SEED_SKILLS;
  const hp = (base: number) => Math.round(base * hpScale);
  return [
    makePlayer('Knight', 5, {
      className: 'Knight', level: 12, hp: hp(900), baseDamage: 30, equipBonuses: GEAR,
      skills: [s.knight_guard, s.knight_bash, s.knight_shield_bash, s.knight_sunder, s.knight_intercept],
    }),
    makePlayer('Archer', 2, {
      className: 'Archer', level: 12, hp: hp(500), baseDamage: 35, equipBonuses: GEAR, mastery: { boss: 3 },
      skills: [s.archer_pierce, s.archer_triple_shot, s.archer_focus, s.archer_bleed, s.archer_crippling_shot],
    }),
    makePlayer('Priest', 0, {
      className: 'Priest', level: 12, hp: hp(450), baseDamage: 12, equipBonuses: GEAR,
      skills: [s.priest_bless, s.priest_minor_heal, s.priest_cure, s.priest_mending, s.priest_resurrection],
    }),
    makePlayer('Mage', 8, {
      className: 'Mage', level: 12, hp: hp(400), baseDamage: 32,
      skills: [s.mage_ignite, s.mage_overflow, s.mage_magic_missile, s.mage_scorch, s.mage_blizzard],
    }),
    makePlayer('Bard', 3, {
      className: 'Bard', level: 12, hp: hp(450), baseDamage: 18, isHenchman: true,
      skills: [s.bard_nimble, s.bard_drumroll, s.bard_war_song, s.bard_chaos, s.bard_lullaby],
    }),
  ];
}

function richMonsters(): MonsterInstance[] {
  return [
    makeMonster(4, {
      id: 'boss', name: 'Warlord', hp: 9000, damage: 600, tier: 'boss', level: 13, attackInterval: 1.2,
      resistances: [{ damageType: 'magical', flatReduction: 20, percentReduction: 10 }],
      skills: [
        { skillId: 'fireball', value: 30, cooldown: 6 },
        { skillId: 'fear', value: 0, cooldown: 9 },
        { skillId: 'rot', value: 8, cooldown: 4 },
      ],
      enrage: { afterSeconds: 6, stepSeconds: 3, stepPercent: 0.2, maxStacks: 6 },
    }),
    makeMonster(1, {
      id: 'shaman', name: 'Shaman', hp: 700, damage: 12,
      skills: [{ skillId: 'heal', value: 200, cooldown: 3 }, { skillId: 'assassinate', value: 160, cooldown: 5 }],
    }),
    makeMonster(0, { id: 'wall', name: 'Wall', hp: 500, passive: true }),
  ];
}

function richFight(hpScale = 1): PartyCombatState {
  return createPartyCombatState(richParty(hpScale), richMonsters(), { bossPhases: { thresholds: [0.75, 0.5, 0.25] } });
}

interface Replay {
  events: CombatEvent[];
  log: string[];
  final: string;
}

function playOut(state: PartyCombatState, rng: () => number, maxMs = 400000): Replay {
  const events: CombatEvent[] = [];
  const log: string[] = [];
  while (!state.finished && state.elapsedMs < maxMs) {
    const r = processCombatStep(state, 100, rng);
    events.push(...r.events);
    log.push(...r.logEntries);
  }
  return { events, log, final: JSON.stringify(state) };
}

/** Every object/array reachable from `root`, keyed by path, skipping read-only content and immutable combat refs. */
function mutableRefs(root: unknown): Map<object, string> {
  const shared = new Set([
    'equippedSkills', 'equipBonuses', 'setBonuses', 'resistances', 'skills', 'mastery', 'enrage',
    'source', 'target', 'stunSource', 'pace',
  ]);
  const seen = new Map<object, string>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.set(value, path);
    for (const [key, child] of Object.entries(value)) {
      if (shared.has(key)) continue;
      walk(child, `${path}.${key}`);
    }
  };
  walk(root, 'state');
  return seen;
}

describe('rng threading', () => {
  it('an explicit rng replaces every Math.random call in combat and encounter rolls', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used');
    });
    const rng = createRng(3);
    const state = richFight();
    playOut(state, rng);
    expect(state.finished).toBe(true);
    for (const zone of Object.values(SEED_ZONES)) {
      createEncounter(zone.id, SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS, undefined, rng);
    }
    const fight = createPartyCombatState(richParty(), richMonsters());
    advanceCombat(fight, 20000, rng);
    expect(fight.elapsedMs).toBeGreaterThan(0);
  });

  it('defaults to Math.random, read on every call', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const state = richFight();
    processCombatStep(state);
    for (let i = 0; i < 20; i++) processCombatStep(state);
    expect(spy).toHaveBeenCalled();
  });

  it('replays a whole fight identically from the same seed', () => {
    const a = playOut(richFight(), createRng(42));
    const b = playOut(richFight(), createRng(42));
    const c = playOut(richFight(), createRng(43));
    expect(a.events.length).toBeGreaterThan(200);
    expect(b).toEqual(a);
    expect(c.log).not.toEqual(a.log);
  });

  it('rolls identical encounters from the same seed', () => {
    const roll = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 20 }, () => createEncounter('darkwood', SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS, undefined, rng)
        .map(m => `${m.id}@${m.gridPosition}`).join(','));
    };
    expect(roll(7)).toEqual(roll(7));
    expect(new Set(roll(7)).size).toBeGreaterThan(3);
    const rng = createRng(1);
    const one = resolveEncounter(SEED_ENCOUNTERS.darkwood_wolves, SEED_MONSTERS, rng);
    expect(one.length).toBeGreaterThanOrEqual(1);
  });
});

describe('cloneCombatState', () => {
  it('shares only read-only content with the original', () => {
    const state = richFight();
    const rng = createRng(9);
    while (state.elapsedMs < 15000 && !state.finished) processCombatStep(state, 100, rng);
    const clone = cloneCombatState(state);
    const original = mutableRefs(state);
    for (const [ref, path] of mutableRefs(clone)) {
      expect(original.has(ref), `${path} is shared`).toBe(false);
    }
    expect(clone.players[0].equippedSkills[0]).toBe(state.players[0].equippedSkills[0]);
  });

  it('replays exactly with the same seed and never touches the original (phased, enraging boss)', () => {
    let phaseEvents = 0;
    let enrageEvents = 0;
    let points = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const original = richFight(0.6 + seed * 0.15);
      const main = createRng(seed);
      for (let step = 0; !original.finished && step < 4000; step++) {
        if (step % 37 === 0) {
          points++;
          const before = JSON.stringify(original);
          const a = playOut(cloneCombatState(original), createRng(seed * 1000 + step));
          expect(JSON.stringify(original)).toBe(before);
          const b = playOut(cloneCombatState(original), createRng(seed * 1000 + step));
          expect(b).toEqual(a);
          phaseEvents += a.events.filter(e => e.kind === 'phase').length;
          enrageEvents += a.events.filter(e => e.kind === 'enrage').length;
        }
        processCombatStep(original, 100, main);
      }
      const probe = cloneCombatState(original);
      expect(playOut(probe, createRng(77))).toEqual(playOut(original, createRng(77)));
    }
    expect(points).toBeGreaterThan(20);
    expect(phaseEvents).toBeGreaterThan(0);
    expect(enrageEvents).toBeGreaterThan(0);
  });

  it("replays the original's own future from any mid-fight step boundary", () => {
    for (const cut of [0, 1, 55, 140, 333]) {
      const original = richFight();
      const main = createRng(5);
      for (let i = 0; i < cut && !original.finished; i++) processCombatStep(original, 100, main);
      const copy = cloneCombatState(original);
      const tail = createRng(500 + cut);
      const tailCopy = createRng(500 + cut);
      expect(playOut(copy, tailCopy)).toEqual(playOut(original, tail));
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  advanceCombat,
  buildClientCombatSnapshot,
  cloneCombatState,
  createPartyCombatState,
  processCombatStep,
} from '../src/systems/CombatEngine';
import type { PartyCombatantInit, PartyCombatState } from '../src/systems/CombatEngine';
import type { CombatEvent } from '../src/systems/CombatEvents';
import { createRng } from '../src/systems/combat/CombatRng';
import { AUTHORED_PACE, COMBAT_PACE, paceEngineMs } from '../src/systems/CombatPace';
import { partyKey } from '../src/systems/Forecast';
import { buildHenchmanCombatant } from '../src/systems/HenchmanTypes';
import { validateSkillDefinition } from '../src/systems/SkillOptionCatalog';
import {
  canEquipSkill,
  createDefaultSkillLoadout,
  equipSkillInSlot,
  attackSkillsReplacedBySeed,
  findAttackSkill,
  getSkillCardType,
  getUnlockedSkillsForLevel,
  migrateLegacySkill,
  reconcileSkillLoadout,
  resolveActionOrder,
} from '../src/systems/SkillTypes';
import type { SkillContent, SkillDefinition } from '../src/systems/SkillTypes';
import type { ClassName } from '../src/systems/CharacterStats';
import { legacyFightDigests } from './combatLegacyFights';
import { activeSkill, makeMonster, makePlayer, passiveSkill, player, runTo } from './combatTestUtils';

const ATTACK_ID = 'test_attack';

function attackSkill(charge: number, recovery: number, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: ATTACK_ID, name: 'Attack', description: '', className: 'Knight', type: 'attack', unlockLevel: 1, sortOrder: -1, charge, recovery,
    ...overrides,
  };
}

function timedSkill(id: string, charge: number, recovery: number, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return activeSkill({ id, cooldown: undefined, charge, recovery, ...overrides });
}

function block(charge: number, recovery: number, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return timedSkill('block', charge, recovery, {
    activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }], trigger: 'self_hit', ...overrides,
  });
}

function hero(skills: (SkillDefinition | null)[], attack?: SkillDefinition, extra: Partial<PartyCombatantInit> = {}): PartyCombatantInit {
  const init = makePlayer('Hero', 2, { className: 'Knight', hp: 100000, skills });
  return { ...init, ...(attack ? { attack } : {}), ...extra };
}

/** One monster hitting for 1 at 1400 ms, then every `interval` seconds. Attacks at it don't land on a dummy with skills. */
function striker(interval: number) {
  return makeMonster(0, { hp: 1000000, damage: 1, attackInterval: interval });
}

function fight(p: PartyCombatantInit | PartyCombatantInit[], monsterInterval = 1000): PartyCombatState {
  return createPartyCombatState(Array.isArray(p) ? p : [p], [striker(monsterInterval)]);
}

function times(events: CombatEvent[], pred: (e: CombatEvent) => boolean): number[] {
  return events.filter(pred).map(e => e.t);
}

const isAttack = (e: CombatEvent): boolean => e.kind === 'attack' && e.src?.side === 'player' && e.skillId === ATTACK_ID;
const isUse = (id: string) => (e: CombatEvent): boolean => e.kind === 'attack' && e.src?.side === 'player' && e.skillId === id;
const isReaction = (e: CombatEvent): boolean => e.kind === 'reaction';

describe('time until the next action', () => {
  const uses = (events: CombatEvent[]) => events.filter(e => (e.kind === 'attack' || e.kind === 'cast_start') && e.src?.side === 'player' && e.nextActionMs !== undefined);
  const view = (state: PartyCombatState) => buildClientCombatSnapshot(state, 1, false).units.find(u => u.side === 'player')!;

  it.each([
    ['Attack alone, no recovery', [], attackSkill(2, 0)],
    ['Attack with recovery', [], attackSkill(1, 1)],
    ['a skill charging between Attacks', [timedSkill('strike', 3.5, 0.5)], attackSkill(1, 0.5)],
    ['a cast with recovery', [timedSkill('blast', 2, 0.5, { castTime: 1 })], attackSkill(1, 0.5)],
    ['a long recovery past the Attack charge', [timedSkill('slam', 1, 4)], attackSkill(1, 0)],
    ['an old-style cooldown skill', [activeSkill({ id: 'legacy', cooldown: 3, warmup: 0 })], attackSkill(1, 0)],
    ['an instant alongside', [block(0.5, 0), timedSkill('strike', 3, 0)], attackSkill(2, 0)],
    ['Attack listed above a skill', [timedSkill('strike', 3, 0)], attackSkill(2, 0.5), { actionOrder: [ATTACK_ID, 'strike'] }],
  ] as const)('predicts every gap exactly: %s', (_name, skills, attack, extra = {}) => {
    const { events } = runTo(fight(hero([...skills], attack, extra), 0.6), 30000);
    const actions = uses(events);
    expect(actions.length).toBeGreaterThan(5);
    actions.slice(0, -1).forEach((action, i) => expect(actions[i + 1].t - action.t, `action ${i} at ${action.t}`).toBe(action.nextActionMs));
  });

  it('predicts every gap exactly at the real pace', () => {
    const state = createPartyCombatState([hero([timedSkill('strike', 4.5, 0.9)], attackSkill(3.6, 0))], [striker(1)], { pace: COMBAT_PACE });
    const actions = uses(runTo(state, 60000).events);
    expect(actions.length).toBeGreaterThan(5);
    actions.slice(0, -1).forEach((action, i) => expect(actions[i + 1].t - action.t).toBe(action.nextActionMs));
  });

  it('runs the snapshot down from the last action, with no recovery to show', () => {
    const state = fight(hero([], attackSkill(2, 0)));
    runTo(state, 2500);
    expect(view(state)).toMatchObject({ actionMs: 1500, actionTotalMs: 2000 });
    expect(view(state).recoveryMs).toBeUndefined();
  });

  it('counts down to the first action from the start of the fight', () => {
    const state = fight(hero([], attackSkill(2, 0)));
    expect(view(state)).toMatchObject({ actionMs: 2000, actionTotalMs: 2000 });
    runTo(state, 500);
    expect(view(state)).toMatchObject({ actionMs: 1500, actionTotalMs: 2000 });
  });

  it('agrees between the event and the snapshot straight after an action', () => {
    const state = fight(hero([timedSkill('strike', 3, 0.5)], attackSkill(2, 0.5)));
    const { events } = runTo(state, 3000);
    const last = uses(events).at(-1)!;
    expect(view(state).actionTotalMs).toBe(last.nextActionMs);
    expect(view(state).actionMs).toBe(last.nextActionMs! - (3000 - last.t));
  });

  it('runs on through a cast and on to whatever comes after it', () => {
    const state = fight(hero([timedSkill('blast', 10, 0.5, { castTime: 1, warmup: 0 })], attackSkill(4, 0, { warmup: 3 })));
    const { events } = runTo(state, 200);
    expect(events.find(e => e.kind === 'cast_start')).toMatchObject({ t: 100, nextActionMs: 2900 });
    expect(view(state)).toMatchObject({ actionMs: 2800, actionTotalMs: 2900 });
  });

  it('ignores a skill nothing needs, and a need brings the action forward', () => {
    const heal = timedSkill('mend', 1, 0, { warmup: 1, activeEffects: [{ kind: 'heal_lowest', healMultiplier: 2 }] });
    const state = fight(hero([heal], attackSkill(5, 0)));
    expect(view(state)).toMatchObject({ actionMs: 5000, actionTotalMs: 5000 });
    player(state, 'Hero').currentHp = 1;
    expect(view(state)).toMatchObject({ actionMs: 1000, actionTotalMs: 5000 });
    const { events } = runTo(state, 1100);
    expect(times(events, isUse('mend'))).toEqual([1000]);
  });

  it('lengthens the total when an action moves further away', () => {
    const heal = timedSkill('mend', 1, 0, { warmup: 1, activeEffects: [{ kind: 'heal_lowest', healMultiplier: 2 }] });
    const state = fight(hero([heal], attackSkill(5, 0)));
    player(state, 'Hero').currentHp = 1;
    player(state, 'Hero').actionTotalMs = 1000;
    expect(view(state)).toMatchObject({ actionMs: 1000, actionTotalMs: 1000 });
    player(state, 'Hero').currentHp = player(state, 'Hero').maxHp;
    expect(view(state)).toMatchObject({ actionMs: 5000, actionTotalMs: 5000 });
    runTo(state, 500);
    expect(view(state)).toMatchObject({ actionMs: 4500, actionTotalMs: 5000 });
    runTo(state, 1000);
    expect(view(state)).toMatchObject({ actionMs: 4000, actionTotalMs: 5000 });
  });

  it('measures after the effect lands, so a heal that ends the need for the next one counts', () => {
    const heal = (id: string, warmup: number) => timedSkill(id, 20, 0, { warmup, activeEffects: [{ kind: 'heal_lowest', healMultiplier: 1000000 }] });
    const state = fight(hero([heal('first', 0), heal('second', 0.5)], attackSkill(6, 0)));
    player(state, 'Hero').currentHp = 1;
    const { events } = runTo(state, 100);
    expect(events.find(isUse('first'))).toMatchObject({ t: 100, nextActionMs: 5900 });
    expect(view(state)).toMatchObject({ actionMs: 5900, actionTotalMs: 5900 });
  });

  it('holds still through a stun, and an instant leaves it alone', () => {
    const state = fight(hero([block(0.5, 0)], attackSkill(4, 0)), 0.6);
    const { events } = runTo(state, 1500);
    expect(events.some(isReaction)).toBe(true);
    expect(view(state)).toMatchObject({ actionMs: 2500, actionTotalMs: 4000 });
    player(state, 'Hero').stunRemainingMs = 1000;
    runTo(state, 1900);
    expect(view(state).actionMs).toBe(2500);
  });

  it('leaves a player with no Attack skill on the action timer, and sends no extra field', () => {
    const state = fight(hero([timedSkill('strike', 3, 0.5, { warmup: 0 })]));
    const { events } = runTo(state, 1200);
    expect(events.find(isUse('strike'))).toBeDefined();
    expect(events.find(isUse('strike'))).not.toHaveProperty('nextActionMs');
    const hero_ = player(state, 'Hero');
    expect(view(state)).toMatchObject({ actionMs: hero_.actionRemainingMs, actionTotalMs: hero_.actionTotalMs });
  });

  it('changes nothing about when anyone acts', () => {
    const play = (withSnapshots: boolean) => {
      const heal = timedSkill('mend', 2, 0.5, { activeEffects: [{ kind: 'heal_lowest', healMultiplier: 2 }] });
      const state = fight(hero([timedSkill('strike', 3, 0.5), heal], attackSkill(2, 0.5)));
      const rng = createRng(7);
      const actions: string[] = [];
      while (state.elapsedMs < 20000) {
        for (const e of processCombatStep(state, 100, rng).events) actions.push(`${e.t}:${e.kind}:${e.skillId ?? ''}:${e.amount ?? ''}`);
        if (withSnapshots) buildClientCombatSnapshot(state, 1, true);
      }
      return actions;
    };
    expect(play(true).length).toBeGreaterThan(20);
    expect(play(true)).toEqual(play(false));
  });
});

describe('recovery gate', () => {
  it('an instant fires in the same step as an attack', () => {
    const state = fight(hero([block(1, 0, { warmup: 1.9 })], attackSkill(2, 0)), 0.6);
    const { events } = runTo(state, 2100);
    const attack = events.findIndex(isAttack);
    const reaction = events.findIndex(isReaction);
    expect(events[attack].t).toBe(2000);
    expect(events[reaction].t).toBe(2000);
    expect(attack).toBeLessThan(reaction);
  });

  it('an instant fires during Attack recovery', () => {
    const state = fight(hero([block(0.5, 0)], attackSkill(1, 1)), 0.6);
    const { events } = runTo(state, 2100);
    expect(times(events, isAttack)).toEqual([1000]);
    expect(times(events, e => e.kind === 'attack' && e.src?.side === 'monster')).toEqual([1400, 2000]);
    expect(times(events, isReaction)).toEqual([1400, 2000]);
  });

  it("an instant fires during another action skill's recovery", () => {
    const state = fight(hero([timedSkill('long', 50, 3, { warmup: 0 }), block(0.5, 0)], attackSkill(100, 0)), 0.6);
    const { events } = runTo(state, 2700);
    expect(times(events, isUse('long'))).toEqual([100]);
    expect(player(state, 'Hero').recoveryRemainingMs).toBeGreaterThan(0);
    expect(times(events, isReaction)).toEqual([1400, 2000, 2600]);
  });

  it('firing an instant leaves the recovery and action timers untouched', () => {
    const withBlock = fight(hero([block(0.5, 0)], attackSkill(1, 1)), 0.6);
    const without = fight(hero([], attackSkill(1, 1)), 0.6);
    const { events } = runTo(withBlock, 1500);
    runTo(without, 1500);
    expect(events.filter(isReaction)).toHaveLength(1);
    const [a, b] = [player(withBlock, 'Hero'), player(without, 'Hero')];
    expect(a.recoveryRemainingMs).toBe(500);
    expect(a.recoveryRemainingMs).toBe(b.recoveryRemainingMs);
    expect(a.recoveryTotalMs).toBe(b.recoveryTotalMs);
    expect(a.actionRemainingMs).toBe(b.actionRemainingMs);
    expect(a.actionTotalMs).toBe(b.actionTotalMs);
    expect(events.find(isReaction)).not.toHaveProperty('recoveryMs');
  });

  it('an instant does not delay the attack', () => {
    const state = fight(hero([block(50, 0, { warmup: 0 })], attackSkill(1, 0)), 1);
    const { events } = runTo(state, 4500);
    expect(times(events, isReaction)).toEqual([1400]);
    expect(times(events, isAttack)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('a stun still blocks an instant', () => {
    const state = fight(hero([block(0.5, 0)], attackSkill(100, 0)), 0.6);
    const { events } = runTo(state, 1300);
    const hero_ = player(state, 'Hero');
    hero_.stunRemainingMs = 500;
    hero_.stunTotalMs = 500;
    runTo(state, 1700, { events, log: [] });
    expect(times(events, isReaction)).toEqual([]);
    runTo(state, 2100, { events, log: [] });
    expect(times(events, isReaction)).toEqual([2000]);
  });

  it('an instant on charge does not re-fire', () => {
    const state = fight(hero([block(50, 0, { warmup: 0 })], attackSkill(100, 0)), 0.3);
    const { events } = runTo(state, 3000);
    expect(events.filter(e => e.kind === 'attack' && e.src?.side === 'monster').length).toBeGreaterThan(3);
    expect(events.filter(isReaction)).toHaveLength(1);
  });

  it('ignores a stale recovery on an instant in timers, cycle, events and snapshot', () => {
    const state = fight(hero([block(0.5, 9)], attackSkill(100, 0)), 0.6);
    const { events } = runTo(state, 2100);
    const hero_ = player(state, 'Hero');
    expect(times(events, isReaction)).toEqual([1400, 2000]);
    expect(hero_.recoveryRemainingMs).toBe(0);
    expect(hero_.skillCooldownTotals.block).toBe(500);
    expect(events.some(e => e.recoveryMs !== undefined && e.skillId === 'block')).toBe(false);
    const view = buildClientCombatSnapshot(state, 1, true).units[0].skills!.find(s => s.id === 'block')!;
    expect(view).toMatchObject({ chargeMs: 500, recoveryMs: 0, baseCooldownMs: 500, useCooldownMs: 500, cardType: 'instant' });
    expect(buildClientCombatSnapshot(state, 1, true).units[0].recoveryMs).toBeUndefined();
  });

  it('keeps an instant with no charge on a timer of one step', () => {
    const state = fight(hero([block(0, 0)], attackSkill(100, 0)), 0.3);
    const { events } = runTo(state, 1500);
    expect(player(state, 'Hero').skillCooldownTotals.block).toBe(100);
    expect(new Set(times(events, isReaction)).size).toBe(events.filter(isReaction).length);
  });

  it('fires a level trigger with no charge at most once a step', () => {
    const mending = timedSkill('mend', 0, 5, { trigger: 'ally_low_hp', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 0.001 }], warmup: 0 });
    const state = fight(hero([mending], attackSkill(100, 0)), 1);
    player(state, 'Hero').currentHp = 1;
    const { events } = runTo(state, 500);
    expect(times(events, isReaction)).toEqual([100, 200, 300, 400, 500]);
    expect(player(state, 'Hero').recoveryRemainingMs).toBe(0);
  });

  it('own charge starts after own recovery', () => {
    const skill = timedSkill('strike', 1, 1, { warmup: 0 });
    const state = fight(hero([skill], attackSkill(100, 0)));
    const { events } = runTo(state, 100);
    expect(player(state, 'Hero').skillCooldowns.strike).toBe(2000);
    runTo(state, 4200, { events, log: [] });
    expect(times(events, isUse('strike'))).toEqual([100, 2100, 4100]);
  });

  it("other skills' timers keep ticking during recovery", () => {
    const state = fight(hero([timedSkill('long', 50, 3, { warmup: 0 }), timedSkill('other', 2, 0)], attackSkill(1, 0)));
    const { events } = runTo(state, 2500);
    const hero_ = player(state, 'Hero');
    expect(hero_.recoveryRemainingMs).toBe(600);
    expect(hero_.skillCooldowns.other).toBe(0);
    expect(hero_.skillCooldowns[ATTACK_ID]).toBe(0);
    expect(times(events, isAttack)).toEqual([]);
    runTo(state, 3100, { events, log: [] });
    expect(times(events, isUse('other'))).toEqual([3100]);
  });

  it('recovery starts when a cast resolves, and instants fire during the cast and after', () => {
    const cast = timedSkill('cast', 1, 1, { castTime: 2, warmup: 0 });
    const state = fight(hero([cast, block(0, 0)], attackSkill(100, 0)), 1);
    const { events } = runTo(state, 5000);
    const hero_ = player(state, 'Hero');
    expect(times(events, e => e.kind === 'cast_start')).toEqual([100, 4100]);
    expect(events.find(e => e.kind === 'cast_start')?.nextActionMs).toBe(4000);
    expect(times(events, e => e.kind === 'cast_end')).toEqual([2100]);
    expect(events.find(e => e.kind === 'cast_end')?.recoveryMs).toBe(1000);
    expect(times(events, isReaction)).toEqual([1400, 2400, 3400, 4400]);
    expect(hero_.cast?.skillId).toBe('cast');
  });

  it('a stun freezes recovery and every timer', () => {
    const state = fight(hero([], attackSkill(1, 5)));
    const { events } = runTo(state, 2000);
    const hero_ = player(state, 'Hero');
    const recovery = hero_.recoveryRemainingMs;
    const charge = hero_.skillCooldowns[ATTACK_ID];
    hero_.stunRemainingMs = 1000;
    hero_.stunTotalMs = 1000;
    runTo(state, 3000, { events, log: [] });
    expect(hero_.recoveryRemainingMs).toBe(recovery);
    expect(hero_.skillCooldowns[ATTACK_ID]).toBe(charge);
    runTo(state, 8100, { events, log: [] });
    expect(times(events, isAttack)).toEqual([1000, 8000]);
  });

  it('commits a counter during recovery, leaving the timers alone', () => {
    const interrupt = timedSkill('counter', 0.1, 3, { trigger: 'enemy_cast' });
    const caster = makeMonster(0, { hp: 100000, damage: 1, skills: [{ skillId: 'fireball', value: 1, cooldown: 0, castTime: 5 }] });
    const state = createPartyCombatState([hero([interrupt], attackSkill(1, 1))], [caster]);
    const events: CombatEvent[] = [];
    while (state.elapsedMs < 1400) events.push(...processCombatStep(state).events);
    const reaction = events.find(isReaction);
    expect(reaction).toMatchObject({ t: 1400, cardType: 'instant' });
    expect(reaction).not.toHaveProperty('recoveryMs');
    expect(player(state, 'Hero').recoveryRemainingMs).toBe(600);
    expect(player(state, 'Hero').recoveryTotalMs).toBe(1000);
    while (state.elapsedMs < 1700) events.push(...processCombatStep(state).events);
    expect(events.find(e => e.kind === 'interrupt')).toMatchObject({ t: 1700, countered: true });
    expect(events.find(e => e.kind === 'interrupt')).not.toHaveProperty('cardType');
  });

  it('leaves a counter idle in a fight with no caster, with or without an attack skill', () => {
    const counter = timedSkill('counter', 3, 0, { trigger: 'enemy_cast', warmup: 0 });
    const withAttack = runTo(fight(hero([counter], attackSkill(1, 0))), 2100).events;
    expect(withAttack.some(isUse('counter'))).toBe(false);
    expect(times(withAttack, isAttack)).toEqual([1000, 2000]);

    const withoutAttack = runTo(fight(hero([counter])), 3200).events;
    expect(withoutAttack.some(isUse('counter'))).toBe(false);
    expect(times(withoutAttack, e => e.kind === 'attack' && e.src?.side === 'player' && !e.skillId)).toEqual([1000, 2000, 3000]);
  });
});

describe('initial charge and openers', () => {
  it('starts at the warmup when set, else at the full charge with no recovery', () => {
    const state = createPartyCombatState([
      hero([timedSkill('now', 5, 1, { warmup: 0 }), timedSkill('soon', 5, 1, { warmup: 0.5 }), timedSkill('full', 2, 1)], attackSkill(100, 0)),
    ], [striker(1)]);
    const { skillCooldowns } = player(state, 'Hero');
    expect(skillCooldowns).toMatchObject({ now: 0, soon: 500, full: 2000 });
  });

  it('reads a timed warmup in real seconds, and a legacy one as before', () => {
    const state = createPartyCombatState(
      [hero([timedSkill('real', 5, 1, { warmup: 1.8 }), activeSkill({ id: 'legacy', cooldown: 3, warmup: 0 })], attackSkill(3.6, 0))],
      [striker(1)],
      { pace: COMBAT_PACE },
    );
    const { skillCooldowns } = player(state, 'Hero');
    expect(skillCooldowns.real).toBe(1000);
    expect(skillCooldowns.legacy).toBe(0);
    expect(skillCooldowns[ATTACK_ID]).toBe(2000);
  });

  it('staggers the attack by sorted index, capped at 5, with no global opener', () => {
    const positions = [8, 5, 2, 7, 4, 1, 6] as const;
    const party = positions.map((pos, i) => ({
      ...makePlayer(`P${i}`, pos, { className: 'Knight' }),
      attack: attackSkill(1, 0),
    }));
    const state = createPartyCombatState(party, [striker(1)]);
    expect(state.players.map(p => p.skillCooldowns[ATTACK_ID])).toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1500]);
    expect(state.players.every(p => p.actionRemainingMs === 0)).toBe(true);
  });

  it('idling does not bank time: attacks land exactly on charge', () => {
    const state = fight(hero([], attackSkill(2, 0)));
    const { events } = runTo(state, 6100);
    expect(times(events, isAttack)).toEqual([2000, 4000, 6000]);
    const hero_ = player(state, 'Hero');
    expect(hero_.actionRemainingMs).toBe(0);
    expect(hero_.attackCount).toBe(3);
  });
});

describe('conversion to engine time', () => {
  it('snaps real seconds to the nearest step, keeping nonzero at one step', () => {
    const at = (seconds: number) => paceEngineMs(COMBAT_PACE, seconds);
    expect(at(0)).toBe(0);
    expect(at(0.01)).toBe(100);
    expect(at(0.4)).toBe(200);
    expect(at(1.6)).toBe(900);
    expect(at(3.6)).toBe(2000);
    expect(at(2.5)).toBe(1400);
    expect(at(0.9)).toBe(500);
    expect(at(14.3)).toBe(7900);
    for (let tenths = 1; tenths <= 1200; tenths++) expect(at(tenths / 10) % 100).toBe(0);
  });

  it('plays a fast attack on the step grid at clock 1.8, reporting real time', () => {
    const state = createPartyCombatState(
      [hero([], attackSkill(0.4, 1.6))],
      [striker(1)],
      { pace: COMBAT_PACE },
    );
    expect(player(state, 'Hero').skillCooldowns[ATTACK_ID]).toBe(200);
    const events: CombatEvent[] = [];
    for (let i = 0; i < 50; i++) events.push(...processCombatStep(state).events);
    expect(times(events, isAttack)).toEqual([360, 2340, 4320, 6300, 8280]);
    expect(events.find(isAttack)?.recoveryMs).toBe(1620);
    const snapshot = buildClientCombatSnapshot(state, 1, true);
    expect(snapshot.units[0].skills?.[0]).toMatchObject({ id: ATTACK_ID, chargeMs: 360, recoveryMs: 1620, cardType: 'basic' });
    expect(Object.values(player(state, 'Hero').skillCooldowns).every(ms => ms % 100 === 0)).toBe(true);
  });
});

describe('cooldown reduction', () => {
  const tempo = (flatValue: number, partyWide = false) => passiveSkill({ id: 'tempo', passiveEffects: [{ kind: 'cooldown_reduction', flatValue, partyWide }] });
  const useTotal = (skills: (SkillDefinition | null)[], extra: Partial<PartyCombatantInit> = {}, id = 'strike') => {
    const state = fight(hero(skills, attackSkill(100, 0), extra));
    runTo(state, 100);
    return player(state, 'Hero').skillCooldownTotals[id];
  };
  const strike = (charge: number, recovery: number, overrides: Partial<SkillDefinition> = {}) => timedSkill('strike', charge, recovery, { warmup: 0, ...overrides });

  it('takes N authored seconds off the charge, never off recovery', () => {
    expect(useTotal([strike(3, 0.5)])).toBe(3500);
    expect(useTotal([tempo(1), strike(3, 0.5)])).toBe(2500);
    expect(useTotal([strike(3, 0.5)], { setBonuses: { cooldownReduction: 2 } })).toBe(1500);
  });

  it('floors the cycle at min(base cycle, 1 authored second), and at recovery', () => {
    expect(useTotal([tempo(10), strike(3, 0.5)])).toBe(1000);
    expect(useTotal([tempo(10), strike(0.2, 0.3)])).toBe(500);
    expect(useTotal([tempo(10), strike(3, 2)])).toBe(2000);
  });

  it('counts a cast toward the cycle', () => {
    expect(useTotal([tempo(10), strike(3, 2, { castTime: 1 })])).toBe(3000);
  });

  it('is 1.8 real seconds per point at clock 1.8', () => {
    const state = createPartyCombatState([hero([tempo(1), strike(3.6, 0)], attackSkill(100, 0))], [striker(1)], { pace: COMBAT_PACE });
    runTo(state, 100);
    expect(player(state, 'Hero').skillCooldownTotals.strike).toBe(1000);
  });

  it('leaves Attack and Enemy-casts instants alone', () => {
    const state = createPartyCombatState(
      [hero([tempo(1), timedSkill('counter', 3.5, 0, { trigger: 'enemy_cast', warmup: 0 })], attackSkill(2, 0.5))],
      [makeMonster(0, { hp: 100000, damage: 1, skills: [{ skillId: 'fireball', value: 1, cooldown: 100, castTime: 5 }] })],
    );
    const { events } = runTo(state, 3000);
    const hero_ = player(state, 'Hero');
    expect(events.some(isReaction)).toBe(true);
    expect(hero_.skillCooldownTotals.counter).toBe(3500);
    expect(hero_.skillCooldownTotals[ATTACK_ID]).toBe(2500);
  });
});

describe('mixed and legacy content', () => {
  it('a missing field reads as 0 when the other is set, and cooldown is ignored', () => {
    const onlyRecovery = activeSkill({ id: 'a', cooldown: 50, recovery: 1, warmup: 0 });
    const onlyCharge = activeSkill({ id: 'b', cooldown: 50, charge: 1, warmup: 0 });
    const recovering = fight(hero([onlyRecovery], attackSkill(100, 0)));
    expect(times(runTo(recovering, 1200).events, isUse('a'))).toEqual([100, 1100]);
    expect(player(recovering, 'Hero').recoveryRemainingMs).toBe(900);
    const charging = fight(hero([onlyCharge], attackSkill(100, 0)));
    expect(times(runTo(charging, 1200).events, isUse('b'))).toEqual([100, 1100]);
    expect(player(charging, 'Hero').recoveryRemainingMs).toBe(0);
  });

  it('no attack skill keeps the opener and interval, and an auto fills the action', () => {
    const skill = timedSkill('strike', 50, 0.5, { warmup: 1 });
    const state = fight(hero([skill]));
    const { events } = runTo(state, 3700);
    expect(times(events, isUse('strike'))).toEqual([1000]);
    expect(times(events, e => e.kind === 'attack' && e.src?.side === 'player' && !e.skillId)).toEqual([1500, 2500, 3500]);
  });

  it('a 0-recovery timed skill on a player with no attack skill keeps later autos on the grid', () => {
    const state = fight(hero([timedSkill('strike', 50, 0, { warmup: 1 })]));
    const { events } = runTo(state, 3200);
    expect(times(events, e => e.kind === 'attack' && e.src?.side === 'player' && !e.skillId)).toEqual([1100, 2100, 3100]);
  });

  it('a legacy skill beside an attack skill takes the class interval, without blocking reactions', () => {
    const legacy = activeSkill({ id: 'legacy', cooldown: 50, warmup: 1 });
    const state = fight(hero([legacy, block(0, 0.1)], attackSkill(1.2, 0)), 0.4);
    const { events } = runTo(state, 2300);
    expect(times(events, isUse('legacy'))).toEqual([1000]);
    expect(times(events, isReaction)).toContain(1400);
    expect(times(events, isAttack)).toEqual([2000]);
    expect(player(state, 'Hero').actionIntervalMs).toBe(1000);
  });

  it('a legacy reaction fires during a recovery and starts none', () => {
    const legacyBlock = activeSkill({ id: 'block', cooldown: 1, warmup: 0, activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }], trigger: 'self_hit' });
    const state = fight(hero([legacyBlock], attackSkill(1, 1)), 0.6);
    const { events } = runTo(state, 4500);
    expect(times(events, isReaction)).toEqual([1400, 2600, 3800]);
    expect(player(state, 'Hero').recoveryRemainingMs).toBe(0);
  });

  it('an attack skill with neither field is ignored, so its player plays as legacy', () => {
    const state = fight(hero([], attackSkill(0, 0, { charge: undefined, recovery: undefined })));
    expect(player(state, 'Hero').attack).toBeUndefined();
    expect(player(state, 'Hero').actionRemainingMs).toBe(1000);
  });

  it('plays legacy content exactly as the engine did before charge and recovery existed', () => {
    expect(legacyFightDigests()).toEqual({
      'authored-1': 'victory@72600:d8633a6b',
      'paced-1': 'victory@79100:e74dde0b',
      'authored-2': 'victory@74700:c4452afb',
      'paced-2': 'victory@84600:3de0b1e1',
      'authored-3': 'victory@74100:d8ecdf1d',
      'paced-3': 'victory@80600:15836699',
    });
  });
});

describe('priority', () => {
  const a = timedSkill('a', 1, 0);
  const b = timedSkill('b', 1, 0);
  const instant = block(0, 0);
  const counter = timedSkill('counter', 1, 0, { trigger: 'enemy_cast' });
  const quiet = passiveSkill({ id: 'quiet', passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }] });
  const atk = attackSkill(1, 0);
  const ids = (list: SkillDefinition[]) => list.map(s => s.id);

  it('defaults to slot order, then Attack', () => {
    expect(ids(resolveActionOrder([quiet, a, instant, b, counter, null], atk, undefined))).toEqual(['a', 'b', ATTACK_ID]);
    expect(ids(resolveActionOrder([a, b], atk, []))).toEqual(['a', 'b', ATTACK_ID]);
  });

  it('lets Attack sit above skills', () => {
    expect(ids(resolveActionOrder([a, b], atk, [ATTACK_ID, 'b', 'a']))).toEqual([ATTACK_ID, 'b', 'a']);
  });

  it('ignores stale ids, and places missing skills after the listed ones, above Attack unless it is listed', () => {
    expect(ids(resolveActionOrder([a, b, counter], atk, ['gone', 'counter', 'b']))).toEqual(['b', 'a', ATTACK_ID]);
    expect(ids(resolveActionOrder([a, b], atk, [ATTACK_ID, 'gone', 'b']))).toEqual([ATTACK_ID, 'b', 'a']);
    expect(ids(resolveActionOrder([a, b], atk, ['a', ATTACK_ID]))).toEqual(['a', ATTACK_ID, 'b']);
  });

  it('never lists reactions or passives', () => {
    expect(ids(resolveActionOrder([quiet, instant, a], atk, ['block', 'quiet', 'a']))).toEqual(['a', ATTACK_ID]);
  });

  it('with no attack skill reorders actives and keeps autos as the fallback', () => {
    expect(ids(resolveActionOrder([a, b], undefined, [ATTACK_ID, 'b']))).toEqual(['b', 'a']);
    const legacyA = activeSkill({ id: 'a', cooldown: 50, warmup: 1 });
    const legacyB = activeSkill({ id: 'b', cooldown: 50, warmup: 1 });
    const state = fight(hero([legacyA, legacyB], undefined, { actionOrder: ['b', 'a'] }));
    const { events } = runTo(state, 3100);
    expect(times(events, isUse('b'))).toEqual([1000]);
    expect(times(events, isUse('a'))).toEqual([2000]);
    expect(times(events, e => e.kind === 'attack' && e.src?.side === 'player' && !e.skillId)).toEqual([3000]);
  });

  it('Attack first takes the tie, without starving a skill that is charged while it recharges', () => {
    const skill = timedSkill('strike', 3, 0, { warmup: 1 });
    const state = fight(hero([skill], attackSkill(1, 0, { charge: 2, warmup: 1 }), { actionOrder: [ATTACK_ID, 'strike'] }));
    const { events } = runTo(state, 4300);
    expect(times(events, isAttack)).toEqual([1000, 3000]);
    expect(times(events, isUse('strike'))).toEqual([1100, 4100]);
  });

  it('skills win the tie by default', () => {
    const skill = timedSkill('strike', 3, 0, { warmup: 1 });
    const state = fight(hero([skill], attackSkill(2, 0, { warmup: 1 })));
    const { events } = runTo(state, 1200);
    expect(times(events, isUse('strike'))).toEqual([1000]);
    expect(times(events, isAttack)).toEqual([1100]);
  });

  it('does not change passive first-match order or reaction order', () => {
    const critA = passiveSkill({ id: 'critA', passiveEffects: [{ kind: 'stacking_same_target', flatValue: 0.1 }] });
    const critB = passiveSkill({ id: 'critB', passiveEffects: [{ kind: 'stacking_same_target', flatValue: 0.9 }] });
    const first = block(0, 0);
    const state = fight(hero([critA, critB, first], attackSkill(1, 0), { actionOrder: ['critB', 'block', ATTACK_ID] }));
    expect(player(state, 'Hero').equippedSkills.map(s => s?.id)).toEqual(['critA', 'critB', 'block']);
  });

  it('a Knight under many fast monsters still lands Attack on schedule, before the block in its step', () => {
    const monsters = [0, 1, 3, 4, 6, 7].map(pos => makeMonster(pos as 0, { hp: 1000000, damage: 1, attackInterval: 0.3 }));
    const state = createPartyCombatState([hero([block(1, 0)], attackSkill(2.4, 0))], monsters);
    const { events } = runTo(state, 12500);
    const attacks = times(events, isAttack);
    const reactions = times(events, isReaction);
    expect(reactions[0]).toBe(1400);
    expect(reactions.slice(0, 5)).toEqual([1400, 2400, 3400, 4400, 5400]);
    expect(attacks).toEqual([2400, 4800, 7200, 9600, 12000]);
    const firstTied = events.findIndex(e => e.t === 2400 && isAttack(e));
    const tiedReaction = events.findIndex(e => e.t === 2400 && isReaction(e));
    expect(firstTied).toBeLessThan(tiedReaction);
  });
});

describe('snapshots', () => {
  it('shows recovery while it runs, and the ring runs on to the next action', () => {
    const state = fight(hero([], attackSkill(1, 1)));
    runTo(state, 1000);
    let unit = buildClientCombatSnapshot(state, 1, false).units[0];
    expect(unit).toMatchObject({ recoveryMs: 1000, recoveryTotalMs: 1000, actionMs: 2000, actionTotalMs: 2000 });
    runTo(state, 2000);
    unit = buildClientCombatSnapshot(state, 1, false).units[0];
    expect(unit.recoveryMs).toBeUndefined();
    expect(unit).toMatchObject({ actionMs: 1000, actionTotalMs: 2000 });

    const zero = fight(hero([], attackSkill(1, 0)));
    runTo(zero, 1000);
    const zeroUnit = buildClientCombatSnapshot(zero, 1, false).units[0];
    expect(zeroUnit.recoveryMs).toBeUndefined();
    expect(zeroUnit).toMatchObject({ actionMs: 1000, actionTotalMs: 1000 });
  });

  it('adds the attack card after the actives, with its charge sweep', () => {
    const state = fight(hero([timedSkill('strike', 1, 0.5)], attackSkill(2, 1)));
    const full = buildClientCombatSnapshot(state, 1, true).units[0].skills ?? [];
    expect(full.map(s => s.id)).toEqual(['strike', ATTACK_ID]);
    expect(full[1]).toMatchObject({ state: 'cooldown', remainingMs: 2000, cooldownMs: 2000, name: 'Attack', cardType: 'basic', baseCooldownMs: 3000, chargeMs: 2000, recoveryMs: 1000 });
    expect(full[0]).toMatchObject({ chargeMs: 1000, recoveryMs: 500, baseCooldownMs: 1500 });
    runTo(state, 2000);
    const part = buildClientCombatSnapshot(state, 1, false).units[0].skills ?? [];
    expect(part[1].name).toBeUndefined();
    expect(part[1].state).toBe('cooldown');
    expect(part[1].cooldownMs).toBe(3000);
  });

  it('adds nothing for legacy content', () => {
    const state = fight(hero([activeSkill({ id: 'legacy', cooldown: 2 })]));
    const unit = buildClientCombatSnapshot(state, 1, true).units[0];
    expect(unit.skills?.map(s => s.id)).toEqual(['legacy']);
    expect(unit.skills?.[0].chargeMs).toBeUndefined();
    expect(unit.recoveryMs).toBeUndefined();
  });
});

describe('forecasts and clones', () => {
  it('a clone replays a timed fight exactly and leaves the original alone', () => {
    const party = [
      hero([timedSkill('strike', 1, 0.5), block(0, 1), timedSkill('cast', 2, 0.5, { castTime: 1 })], attackSkill(1, 0.5), { actionOrder: [ATTACK_ID, 'cast'] }),
    ];
    const original = createPartyCombatState(party, [striker(0.5)], { pace: COMBAT_PACE });
    advanceCombat(original, 1700, createRng(1));
    const before = JSON.stringify(original);
    const a = advanceCombat(cloneCombatState(original), 5000, createRng(2));
    const b = advanceCombat(cloneCombatState(original), 5000, createRng(2));
    expect(JSON.stringify(original)).toBe(before);
    expect(b.events).toEqual(a.events);
    expect(a.events.length).toBeGreaterThan(10);
  });

  it('keys forecasts on the attack and the priority list', () => {
    const base = (): PartyCombatantInit => hero([timedSkill('strike', 1, 0.5)]);
    const key = partyKey([base()]);
    expect(partyKey([base()])).toBe(key);
    const withAttack = partyKey([{ ...base(), attack: attackSkill(2, 0) }]);
    expect(withAttack).not.toBe(key);
    expect(partyKey([{ ...base(), attack: attackSkill(1, 1) }])).not.toBe(withAttack);
    expect(partyKey([{ ...base(), actionOrder: ['strike'] }])).not.toBe(key);
  });

  it('hires carry the attack they are given', () => {
    const def = { id: 'h', name: 'H', className: 'Knight' as ClassName, level: 1, maxHp: 10, baseDamage: 1, skillIds: [], emoji: 'x' };
    const hired = { instanceId: 'i', henchmanId: 'h', gridPosition: 4 as const, mapId: 'm' };
    expect(buildHenchmanCombatant(def, hired, () => undefined, 'H').attack).toBeUndefined();
    const attack = attackSkill(1, 0);
    expect(buildHenchmanCombatant(def, hired, () => undefined, 'H', attack).attack).toBe(attack);
  });
});

describe('attack skills as content', () => {
  const attack = attackSkill(1, 0);
  const passive = passiveSkill({ id: 'guard', passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }] });
  const content: SkillContent = {
    skills: { [ATTACK_ID]: attack, guard: passive },
    slotSchedules: { Knight: [{ type: 'passive', unlocksAtLevel: 1 }, { type: 'active', unlocksAtLevel: 1 }] },
  };

  it('has its own card', () => {
    expect(getSkillCardType(attack)).toBe('basic');
  });

  it('unlocks, but never takes a slot', () => {
    expect(getUnlockedSkillsForLevel('Knight', 1, content)).toContain(ATTACK_ID);
    expect(canEquipSkill(ATTACK_ID, 0, 'Knight', 1, [ATTACK_ID], [], content)).toBe(false);
    expect(canEquipSkill(ATTACK_ID, 1, 'Knight', 1, [ATTACK_ID], [], content)).toBe(false);
    const loadout = { unlockedSkills: [ATTACK_ID], equippedSkills: [null, null] };
    expect(equipSkillInSlot(ATTACK_ID, 1, 'Knight', 1, loadout, [ATTACK_ID], content)).toBeNull();
    expect(createDefaultSkillLoadout('Knight', content).equippedSkills).toEqual(['guard', null]);
  });

  it('drops an attack id found in a slot of an old save', () => {
    const loadout = { unlockedSkills: [ATTACK_ID], equippedSkills: [ATTACK_ID, ATTACK_ID] };
    expect(reconcileSkillLoadout(loadout, 'Knight', 1, [], content).equippedSkills).toEqual([null, null]);
  });

  it('keeps the priority list through reconcile, without ids content no longer has', () => {
    const loadout = { unlockedSkills: [], equippedSkills: [null, null], actionOrder: [ATTACK_ID, 'gone'] };
    expect(reconcileSkillLoadout(loadout, 'Knight', 1, [], content).actionOrder).toEqual([ATTACK_ID]);
    expect(reconcileSkillLoadout({ ...loadout, actionOrder: ['gone'] }, 'Knight', 1, [], content).actionOrder).toBeUndefined();
  });

  it('names attacks a seed reset replaces, and only those', () => {
    const seed = { [ATTACK_ID]: attack };
    const mine = attackSkill(1, 0, { id: 'my_attack' });
    const mageAttack = attackSkill(1, 0, { id: 'mage_own', className: 'Mage' });
    expect(attackSkillsReplacedBySeed([attack, mine, mageAttack, timedSkill('strike', 1, 0)], seed)).toEqual(['my_attack']);
  });

  it('finds the class attack', () => {
    expect(findAttackSkill('Knight', content.skills)).toBe(attack);
    expect(findAttackSkill('Mage', content.skills)).toBeUndefined();
  });

  it('survives the content migration', () => {
    const skill = timedSkill('strike', 2, 1, { warmup: 0 });
    expect(migrateLegacySkill(skill)).toMatchObject({ charge: 2, recovery: 1, warmup: 0 });
    expect(migrateLegacySkill(attack)).toMatchObject({ type: 'attack', charge: 1, recovery: 0 });
  });

  describe('validation', () => {
    const valid = (def: SkillDefinition, c?: SkillContent) => validateSkillDefinition(def, c);

    it('accepts an attack with no options and timed actives with no cooldown', () => {
      expect(valid(attack)).toEqual([]);
      expect(valid(timedSkill('strike', 2, 1))).toEqual([]);
      expect(valid(activeSkill({ id: 'onlyRecovery', cooldown: undefined, recovery: 1 }))).toEqual([]);
      expect(valid(attackSkill(0, 1, { warmup: 0 }))).toEqual([]);
    });

    it('still requires a cooldown on an active with neither field', () => {
      expect(valid(activeSkill({ id: 'x', cooldown: undefined })).join()).toMatch(/cooldown/);
    });

    it('rejects options on an attack', () => {
      expect(valid(attackSkill(1, 0, { activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }] })).join()).toMatch(/options/);
      expect(valid(attackSkill(1, 0, { passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }] })).join()).toMatch(/options/);
    });

    it('rejects an attack with no timing, a later unlock, or active-only fields', () => {
      expect(valid(attackSkill(0, 0, { charge: undefined, recovery: undefined })).join()).toMatch(/charge or a recovery/);
      expect(valid(attackSkill(1, 0, { unlockLevel: 5 })).join()).toMatch(/level 1/);
      expect(valid(attackSkill(1, 0, { unlockLevel: null })).join()).toMatch(/level 1/);
      expect(valid(attackSkill(1, 0, { castTime: 1 })).join()).toMatch(/Cast time/);
      expect(valid(attackSkill(1, 0, { cooldown: 1 })).join()).toMatch(/Cooldown/);
      expect(valid(attackSkill(1, 0, { trigger: 'self_hit' })).join()).toMatch(/Trigger/);
    });

    it('rejects out-of-range or zero timing', () => {
      expect(valid(timedSkill('s', -1, 1)).join()).toMatch(/Charge/);
      expect(valid(timedSkill('s', 121, 1)).join()).toMatch(/Charge/);
      expect(valid(timedSkill('s', 1, 121)).join()).toMatch(/Recovery/);
      expect(valid(timedSkill('s', Number.NaN, 1)).join()).toMatch(/Charge/);
      expect(valid(timedSkill('s', 0, 0)).join()).toMatch(/both be 0/);
    });

    it('rejects a recovery on a skill with a trigger, explicit or inferred', () => {
      expect(valid(timedSkill('s', 2, 0, { trigger: 'enemy_cast' }))).toEqual([]);
      expect(valid(activeSkill({ id: 's', cooldown: undefined, charge: 2, trigger: 'ally_low_hp' }))).toEqual([]);
      expect(valid(timedSkill('s', 2, 1, { trigger: 'enemy_cast' })).join()).toMatch(/cannot have a recovery/);
      expect(valid(block(2, 1, { trigger: undefined })).join()).toMatch(/cannot have a recovery/);
      expect(valid(timedSkill('s', 2, 1, { activeEffects: [{ kind: 'redirect_hit' }] })).join()).toMatch(/cannot have a recovery/);
    });

    it('requires a charge above 0 on a timed instant', () => {
      expect(valid(timedSkill('s', 0, 0, { trigger: 'enemy_cast' })).join()).toMatch(/charge above 0/);
      expect(valid(activeSkill({ id: 's', cooldown: undefined, recovery: 1, trigger: 'self_hit', activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }] })).join()).toMatch(/charge above 0/);
    });

    it('keeps cooldown-timed triggers valid', () => {
      expect(valid(activeSkill({ id: 's', cooldown: 2, trigger: 'enemy_cast' }))).toEqual([]);
    });

    it('rejects charge and recovery on a passive', () => {
      expect(valid({ ...passive, charge: 1 }).join()).toMatch(/Charge/);
      expect(valid({ ...passive, recovery: 1 }).join()).toMatch(/Recovery/);
    });

    it('rejects a second attack for a class, but not its own update or another class', () => {
      expect(valid(attackSkill(2, 0), content)).toEqual([]);
      expect(valid(attackSkill(2, 0, { id: 'second' }), content).join()).toMatch(/already has an attack/);
      expect(valid(attackSkill(2, 0, { id: 'second', className: 'Mage' }), content)).toEqual([]);
    });
  });
});

describe('wall-only and stalemate endings', () => {
  const wall = (hp = 1000000) => makeMonster(0, { hp, damage: 0, passive: true });
  const mageCast = (id: string, recovery?: number): SkillDefinition => activeSkill({
    id, className: 'Mage', cooldown: undefined, charge: 2, castTime: 1, ...(recovery === undefined ? {} : { recovery }),
  });
  const mage = (skills: SkillDefinition[], attack: SkillDefinition): PartyCombatantInit => ({
    ...makePlayer('Hero', 2, { className: 'Mage', hp: 100000, skills }), attack,
  });
  const realFight = (p: PartyCombatantInit | PartyCombatantInit[], monster = wall()): PartyCombatState =>
    createPartyCombatState(Array.isArray(p) ? p : [p], [monster], { pace: COMBAT_PACE });
  const end = (state: PartyCombatState) => {
    let attacks = 0;
    while (!state.finished && state.elapsedMs < 2000000) {
      attacks += processCombatStep(state).events.filter(isAttack).length;
    }
    return { result: state.result, attacks };
  };

  it('ends a wall-only fight after the opening cast, even when casts chain with no recovery', () => {
    const state = realFight(mage([mageCast('x'), mageCast('y')], attackSkill(2, 0.5, { className: 'Mage' })));
    expect(end(state).result).toBe('victory');
    expect(state.elapsedMs).toBeLessThan(5000);
    expect(state.monsters[0].currentHp).toBeGreaterThan(0);
  });

  it('lets a chained cast of a skill with neither charge nor recovery resolve in a wall-only fight', () => {
    const legacyCast = (id: string) => activeSkill({ id, castTime: 1.5, cooldown: 30, warmup: 0 });
    const state = createPartyCombatState([makePlayer('Hero', 2, { hp: 100000, skills: [legacyCast('a'), legacyCast('b')] })], [wall()], { pace: AUTHORED_PACE });
    const events: CombatEvent[] = [];
    while (!state.finished && state.elapsedMs < 60000) events.push(...processCombatStep(state).events);
    expect(state.result).toBe('victory');
    expect(events.filter(e => e.kind === 'cast_start').map(e => e.skillId)).toEqual(['a', 'b']);
    expect(events.filter(e => e.kind === 'cast_end').map(e => e.skillId)).toEqual(['a', 'b']);
  });

  it('ends a two-player wall-only fight whose casts never line up', () => {
    const attack = attackSkill(2, 0.5, { className: 'Mage' });
    const second: PartyCombatantInit = { ...mage([mageCast('x'), mageCast('y')], attack), username: 'Other', gridPosition: 5 };
    const state = realFight([mage([mageCast('x'), mageCast('y')], attack), second]);
    expect(end(state).result).toBe('victory');
    expect(state.elapsedMs).toBeLessThan(5000);
  });

  it.each([
    ['a long charge', attackSkill(60, 0)],
    ['a long initial charge', attackSkill(1, 0, { warmup: 60 })],
  ])('wins a wall-only fight with %s rather than stalling out', (_label, attack) => {
    expect(end(realFight(hero([], attack), wall()))).toEqual({ result: 'victory', attacks: 1 });
  });

  it.each([
    ['a long charge', attackSkill(60, 0)],
    ['a long cycle', attackSkill(30, 30)],
  ])('keeps fighting a monster through %s', (_label, attack) => {
    const { result, attacks } = end(realFight(hero([], attack), makeMonster(0, { hp: 1, damage: 0 })));
    expect(result).toBe('victory');
    expect(attacks).toBe(1);
    const tougher = makeMonster(0, { hp: 1000000, damage: 0 });
    const long = realFight(hero([], attack), tougher);
    runTo(long, 150000);
    expect(long.finished).toBe(false);
    expect(long.players[0].attackCount).toBeGreaterThan(2);
  });

  it('still calls a stalemate when a slow Attack lands nothing', () => {
    const attack = attackSkill(60, 0);
    const state = realFight(hero([], attack), makeMonster(0, { hp: 100, damage: 0 }));
    state.players[0].baseDamage = 0;
    state.monsters[0].currentHp = state.monsters[0].maxHp;
    state.players[0].stunRemainingMs = 1000000;
    expect(end(state).result).toBe('defeat');
    expect(state.elapsedMs).toBe(2 * paceEngineMs(COMBAT_PACE, 60));
  });

  it('keeps the plain window for a quick Attack and for content with no attack skill', () => {
    const stunned = (p: PartyCombatantInit) => {
      const state = realFight(p, makeMonster(0, { hp: 100, damage: 0 }));
      state.players[0].stunRemainingMs = 1000000;
      end(state);
      return state;
    };
    expect(stunned(hero([], attackSkill(3.6, 0))).elapsedMs).toBe(30000);
    expect(stunned(hero([])).elapsedMs).toBe(30000);
  });
});

describe('priority through gear swaps', () => {
  const grant = activeSkill({ id: 'grant', className: 'Mage', unlockLevel: null, charge: 2, recovery: 1, cooldown: undefined });
  const attack = attackSkill(1, 0);
  const content: SkillContent = { skills: { [ATTACK_ID]: attack, grant }, slotSchedules: { Knight: [{ type: 'active', unlocksAtLevel: 1 }, { type: 'passive', unlocksAtLevel: 1 }] } };

  it('keeps a saved grant in its place while the item is off', () => {
    const worn = { unlockedSkills: [], equippedSkills: ['grant', null], actionOrder: ['grant', ATTACK_ID] };
    const off = reconcileSkillLoadout(worn, 'Knight', 1, [], content);
    expect(off.equippedSkills).toEqual([null, null]);
    expect(off.actionOrder).toEqual(['grant', ATTACK_ID]);
    const on = reconcileSkillLoadout({ ...off, equippedSkills: ['grant', null] }, 'Knight', 1, ['grant'], content);
    expect(resolveActionOrder([grant, null], attack, on.actionOrder).map(s => s.id)).toEqual(['grant', ATTACK_ID]);
  });
});

describe('AUTHORED_PACE default', () => {
  it('reads real seconds one to one', () => {
    expect(paceEngineMs(AUTHORED_PACE, 1.5)).toBe(1500);
  });
});

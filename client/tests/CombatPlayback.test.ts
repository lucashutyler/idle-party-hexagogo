import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientCombatSnapshot, ClientCombatUnit, CombatEvent, SkillDefinition } from '@idle-party-rpg/shared';
import {
  CATCH_UP_MS,
  CLOCK_SLEW_MS,
  CombatPlayback,
  ENRAGE_SOON_MS,
  enrageDisplay,
  guessCooldownMs,
  guessStatusKind,
  skillDisplayState,
  STALE_RESUME_MS,
  SYNC_WAIT_MS,
} from '../src/combat/CombatPlayback';
import type { PlaybackSkill } from '../src/combat/CombatPlayback';

const DELAY = 300;

let clock = 0;
const now = (): number => clock;

function player(overrides: Partial<ClientCombatUnit> = {}): ClientCombatUnit {
  return { side: 'player', pos: 4, hp: 100, maxHp: 100, actionMs: 800, actionTotalMs: 1000, ...overrides };
}

function monster(overrides: Partial<ClientCombatUnit> = {}): ClientCombatUnit {
  return { side: 'monster', pos: 1, hp: 50, maxHp: 50, actionMs: 600, actionTotalMs: 1000, ...overrides };
}

function snap(elapsedMs: number, units: ClientCombatUnit[], overrides: Partial<ClientCombatSnapshot> = {}): ClientCombatSnapshot {
  return { battleId: 1, elapsedMs, full: false, finished: false, result: null, units, ...overrides };
}

function fullSnap(elapsedMs: number, units: ClientCombatUnit[], battleId = 1): ClientCombatSnapshot {
  return snap(elapsedMs, units.map(u => ({ ...u, name: u.name ?? (u.side === 'player' ? 'Kay' : 'Goblin') })), { full: true, battleId });
}

let nextId = 1;
function ev(t: number, kind: CombatEvent['kind'], fields: Partial<CombatEvent> = {}): CombatEvent {
  return { id: nextId++, t, kind, ...fields };
}

const P = { side: 'player' as const, pos: 4 as const };
const M = { side: 'monster' as const, pos: 1 as const };

function startBattle(pb: CombatPlayback, units: ClientCombatUnit[] = [player(), monster()], elapsed = 1000, battleId = 1): void {
  pb.ingestMessage({ battleId, snapshot: fullSnap(elapsed, units, battleId), events: [] }, clock);
}

beforeEach(() => {
  clock = 10_000;
  nextId = 1;
});

describe('guessCooldownMs', () => {
  const skill = (fields: Partial<SkillDefinition>): SkillDefinition => ({
    id: 's', name: 'S', description: '', className: 'Knight', type: 'active', unlockLevel: 1, activeEffects: [], ...fields,
  } as SkillDefinition);

  it('reads the effective cooldown back from a derived warm-up', () => {
    expect(guessCooldownMs(skill({ cooldown: 3 }), 1000)).toBe(2000);
    expect(guessCooldownMs(skill({ cooldown: 2 }), 0)).toBe(1000);
    expect(guessCooldownMs(skill({ cooldown: 5, trigger: 'enemy_cast' }), 4000)).toBe(5000);
  });

  it('falls back to the base cooldown for explicit warm-ups, other reactions and unknown warm-ups', () => {
    expect(guessCooldownMs(skill({ cooldown: 3, warmup: 1 }), 1000)).toBe(3000);
    expect(guessCooldownMs(skill({ cooldown: 4, warmup: 0 }), 0)).toBe(4000);
    expect(guessCooldownMs(skill({ cooldown: 2, trigger: 'ally_targeted' }), 0)).toBe(2000);
    expect(guessCooldownMs(skill({ cooldown: 6 }), undefined)).toBe(6000);
    expect(guessCooldownMs(skill({ cooldown: 0.5 }), undefined)).toBe(1000);
    expect(guessCooldownMs(skill({}), undefined)).toBe(1000);
  });
});

describe('CombatPlayback clock', () => {
  it('snaps the offset on the first message and renders PLAYBACK_DELAY_MS behind server time', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    expect(pb.serverNow()).toBe(1000);
    clock += 16;
    expect(pb.tick().renderTime).toBe(1016 - DELAY);
  });

  it('slews small corrections by at most CLOCK_SLEW_MS per message', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    clock += 500;
    pb.ingestMessage({ battleId: 1, snapshot: snap(1600, [player(), monster()]), events: [] }, clock);
    expect(pb.serverNow()).toBe(1500 + CLOCK_SLEW_MS);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1600, [player(), monster()]), events: [] }, clock);
    expect(pb.serverNow()).toBe(1500 + 2 * CLOCK_SLEW_MS);
  });

  it('snaps when the estimate is off by more than 500 ms', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    clock += 500;
    pb.ingestMessage({ battleId: 1, snapshot: snap(2600, [player(), monster()]), events: [] }, clock);
    expect(pb.serverNow()).toBe(2600);
  });

  it('only moves the clock forward from event times when a message has no snapshot', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    clock += 200;
    pb.ingestMessage({ battleId: 1, events: [ev(1100, 'attack', { src: P, dst: M })] }, clock);
    expect(pb.serverNow()).toBe(1200);
    pb.ingestMessage({ battleId: 1, events: [ev(1260, 'attack', { src: M, dst: P })] }, clock);
    expect(pb.serverNow()).toBe(1200 + CLOCK_SLEW_MS);
  });

  it('never moves render time backwards', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    clock += 400;
    const before = pb.tick().renderTime;
    pb.ingestMessage({ battleId: 1, snapshot: snap(1300, [player(), monster()]), events: [] }, clock);
    expect(pb.tick().renderTime).toBeGreaterThanOrEqual(before);
  });
});

describe('CombatPlayback delayed application', () => {
  it('plays events only once render time reaches them', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.ingestMessage({ battleId: 1, events: [ev(1100, 'damage', { src: P, dst: M, amount: 10 })] }, clock);
    clock += 350;
    expect(pb.tick().events).toHaveLength(0);
    expect(pb.unit('monster', 1)!.hp).toBe(50);
    clock += 60;
    const played = pb.tick().events;
    expect(played.map(e => e.kind)).toEqual(['damage']);
    expect(pb.unit('monster', 1)!.hp).toBe(40);
  });

  it('applies a snapshot at its own elapsed time, after the events up to it', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.ingestMessage({
      battleId: 1,
      snapshot: snap(1200, [player({ hp: 90 }), monster({ hp: 35 })]),
      events: [ev(1150, 'damage', { src: P, dst: M, amount: 15 }), ev(1200, 'damage', { src: M, dst: P, amount: 10 })],
    }, clock + 200);
    clock += 200 + 250;
    pb.tick();
    expect(pb.unit('monster', 1)!.hp).toBe(35);
    expect(pb.unit('player', 4)!.hp).toBe(100);
    clock += 60;
    const tick = pb.tick();
    expect(tick.snapshotApplied).toBe(true);
    expect(pb.unit('player', 4)!.hp).toBe(90);
    expect(pb.unit('monster', 1)!.hp).toBe(35);
  });

  it('dedupes events by id within a battle', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    const hit = ev(1100, 'damage', { src: P, dst: M, amount: 5 });
    pb.ingestMessage({ battleId: 1, events: [hit] }, clock);
    pb.ingestMessage({ battleId: 1, events: [hit] }, clock);
    clock += 1000;
    expect(pb.tick().events).toHaveLength(1);
    expect(pb.unit('monster', 1)!.hp).toBe(45);
  });

  it('plays events older than an applied snapshot as FX only', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player(), monster({ hp: 30 })], 1000);
    pb.ingestMessage({ battleId: 1, events: [ev(900, 'damage', { src: P, dst: M, amount: 20 })] }, clock);
    clock += 1000;
    expect(pb.tick().events).toHaveLength(1);
    expect(pb.unit('monster', 1)!.hp).toBe(30);
  });
});

describe('CombatPlayback event model', () => {
  function ready(units?: ClientCombatUnit[]): CombatPlayback {
    const pb = new CombatPlayback({ now, delayMs: DELAY, cooldownHint: () => 4000 });
    pb.setActive(true);
    startBattle(pb, units);
    return pb;
  }

  function play(pb: CombatPlayback, events: CombatEvent[]): void {
    const last = Math.max(...events.map(e => e.t));
    while (pb.serverNow()! < last) {
      clock += Math.min(100, last - pb.serverNow()!);
      pb.tick();
    }
    pb.ingestMessage({ battleId: 1, events }, clock);
    clock += DELAY + 1;
    pb.tick();
  }

  it('tracks heal, shield, absorb, death and revive', () => {
    const pb = ready([player({ hp: 40 }), monster()]);
    play(pb, [ev(1010, 'heal', { dst: P, amount: 80 })]);
    expect(pb.unit('player', 4)!.hp).toBe(100);
    play(pb, [ev(1020, 'shield', { dst: P, amount: 30 }), ev(1030, 'absorb', { dst: P, amount: 12 })]);
    expect(pb.unit('player', 4)!.shield).toBe(18);
    play(pb, [ev(1040, 'death', { dst: P })]);
    const u = pb.unit('player', 4)!;
    expect(u.hp).toBe(0);
    expect(u.shield).toBe(0);
    play(pb, [ev(1050, 'revive', { dst: P, amount: 20 })]);
    expect(pb.unit('player', 4)!.hp).toBe(20);
  });

  it('resets the action ring on an attack and freezes timers while stunned', () => {
    const pb = ready();
    play(pb, [ev(1100, 'attack', { src: M, dst: P })]);
    const m = pb.unit('monster', 1)!;
    expect(m.actionTotalMs).toBe(1000);
    expect(m.actionMs).toBeGreaterThan(990);
    play(pb, [ev(1200, 'stun', { dst: M, durationMs: 1000 })]);
    const frozen = pb.unit('monster', 1)!.actionMs;
    clock += 500;
    pb.tick();
    expect(pb.unit('monster', 1)!.actionMs).toBe(frozen);
    expect(pb.unit('monster', 1)!.stunMs).toBeLessThan(600);
    clock += 700;
    pb.tick();
    expect(pb.unit('monster', 1)!.stunMs).toBe(0);
    expect(pb.unit('monster', 1)!.actionMs).toBeLessThan(frozen);
  });

  it('resets the ring to the unit\'s own interval from a full snapshot on the first attack', () => {
    const pb = ready([player(), monster({ actionMs: 500, actionTotalMs: 700, actionIntervalMs: 700 })]);
    play(pb, [ev(1100, 'attack', { src: M, dst: P })]);
    const m = pb.unit('monster', 1)!;
    expect(m.intervalMs).toBe(700);
    expect(m.actionTotalMs).toBe(700);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1200, [player(), monster({ actionMs: 600, actionTotalMs: 1500 })]), events: [] }, clock);
    clock += DELAY + 1;
    pb.tick();
    expect(pb.unit('monster', 1)!.intervalMs).toBe(700);
  });

  it('falls back to the base interval and infers it from observed waits without actionIntervalMs', () => {
    const pb = ready();
    play(pb, [ev(1100, 'attack', { src: M, dst: P })]);
    expect(pb.unit('monster', 1)!.intervalMs).toBe(1000);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1200, [player(), monster({ actionMs: 700, actionTotalMs: 800 })]), events: [] }, clock);
    clock += DELAY + 1;
    pb.tick();
    expect(pb.unit('monster', 1)!.intervalMs).toBe(800);
  });

  it('does not reset the ring on the attack that resolves a cast', () => {
    const pb = ready();
    play(pb, [ev(1100, 'cast_start', { src: M, dst: P, skill: 'Fireball', skillId: 'fireball', durationMs: 1500 })]);
    const m = pb.unit('monster', 1)!;
    expect(m.cast).toMatchObject({ skill: 'Fireball', totalMs: 1500, target: P });
    expect(m.actionTotalMs).toBe(1500);
    play(pb, [ev(2600, 'cast_end', { src: M, skillId: 'fireball' }), ev(2600, 'attack', { src: M, dst: P, skillId: 'fireball' })]);
    const after = pb.unit('monster', 1)!;
    expect(after.cast).toBeNull();
    expect(after.actionMs).toBe(0);
    expect(after.attacks).toBe(0);
  });

  it('drops a cast when its caster is revived mid-cast', () => {
    const pb = ready();
    play(pb, [ev(1100, 'cast_start', { src: P, dst: M, skill: 'Blizzard', skillId: 'mage_blizzard', durationMs: 1500 })]);
    play(pb, [ev(1200, 'revive', { dst: P, amount: 20 })]);
    expect(pb.unit('player', 4)!.cast).toBeNull();
  });

  it('removes a cast on interrupt and pauses a stunned player cast', () => {
    const pb = ready();
    play(pb, [ev(1100, 'cast_start', { src: M, dst: P, skill: 'Heal', skillId: 'heal', durationMs: 1000 })]);
    play(pb, [ev(1400, 'interrupt', { src: P, dst: M, skill: 'Heal', skillId: 'heal' })]);
    expect(pb.unit('monster', 1)!.cast).toBeNull();

    play(pb, [ev(1500, 'cast_start', { src: P, dst: M, skill: 'Blizzard', skillId: 'mage_blizzard', durationMs: 1500 })]);
    play(pb, [ev(1600, 'stun', { dst: P, durationMs: 1000 })]);
    const remaining = pb.unit('player', 4)!.cast!.remainingMs;
    clock += 400;
    pb.tick();
    expect(pb.unit('player', 4)!.cast!.remainingMs).toBe(remaining);
  });

  it('restarts a skill cooldown on attack, reaction and cast_start, from the hint until a snapshot reports one after a use', () => {
    const skills = [
      { id: 'bash', remainingMs: 0, cooldownMs: 1000, state: 'ready' as const },
      { id: 'intercept', remainingMs: 0, cooldownMs: 0, state: 'armed' as const },
    ];
    const pb = ready([player({ skills }), monster()]);
    play(pb, [ev(1100, 'attack', { src: P, dst: M, skill: 'Bash', skillId: 'bash' })]);
    const bash = (): PlaybackSkill => pb.unit('player', 4)!.skills!.find(s => s.id === 'bash')!;
    expect(bash().cooldownMs).toBe(4000);
    expect(bash().remainingMs).toBeGreaterThan(3990);
    play(pb, [ev(1120, 'reaction', { src: P, dst: P, skill: 'Intercept', skillId: 'intercept', cardType: 'instant' })]);
    const intercept = pb.unit('player', 4)!.skills!.find(s => s.id === 'intercept')!;
    expect(intercept.cooldownMs).toBe(4000);
    expect(skillDisplayState(pb.unit('player', 4)!, intercept, 'ally_targeted')).toBe('cooldown');

    pb.ingestMessage({ battleId: 1, snapshot: snap(1500, [player({ skills: [{ ...skills[0], remainingMs: 1600, cooldownMs: 2000, state: 'cooldown' }, skills[1]] }), monster()]), events: [] }, clock);
    clock += 500;
    pb.tick();
    expect(bash().useCooldownMs).toBe(2000);
    play(pb, [ev(3200, 'attack', { src: P, dst: M, skill: 'Bash', skillId: 'bash' })]);
    expect(bash().cooldownMs).toBe(2000);
  });

  it('passes the battle-start warm-up to the hint and ignores warm-ups as use cooldowns', () => {
    const seen: (number | undefined)[] = [];
    const pb = new CombatPlayback({ now, delayMs: DELAY, cooldownHint: (_id, warmupMs) => { seen.push(warmupMs); return 5000; } });
    pb.setActive(true);
    const skills = [{ id: 'dispel', remainingMs: 4000, cooldownMs: 4000, state: 'cooldown' as const }];
    pb.ingestMessage({ battleId: 1, snapshot: fullSnap(0, [player({ skills }), monster()]), events: [] }, clock);
    pb.ingestMessage({ battleId: 1, snapshot: snap(600, [player({ skills: [{ ...skills[0], remainingMs: 3400 }] }), monster()]), events: [] }, clock + 600);
    clock += 600 + DELAY + 400;
    pb.tick();
    const dispel = pb.unit('player', 4)!.skills![0];
    expect(dispel.warmupMs).toBe(4000);
    expect(dispel.useCooldownMs).toBe(0);
    play(pb, [ev(4100, 'reaction', { src: P, dst: M, skill: 'Dispel', skillId: 'dispel', cardType: 'interrupt' })]);
    expect(seen).toEqual([4000]);
    expect(pb.unit('player', 4)!.skills![0].cooldownMs).toBe(5000);
  });

  it('leaves the warm-up unknown when the first snapshot is mid-fight', () => {
    const pb = ready([player({ skills: [{ id: 'bash', remainingMs: 500, cooldownMs: 2000, state: 'cooldown' }] }), monster()]);
    expect(pb.unit('player', 4)!.skills![0].warmupMs).toBeUndefined();
  });

  it('adds statuses from events and cleanses player afflictions', () => {
    const pb = ready();
    play(pb, [ev(1100, 'status', { dst: P, name: 'Bleed' }), ev(1100, 'status', { dst: M, name: 'Ignite' }), ev(1110, 'status', { dst: M, name: 'Ignite' })]);
    expect(pb.unit('player', 4)!.statuses).toEqual([{ kind: 'dot', name: 'Bleed' }]);
    expect(pb.unit('monster', 1)!.statuses[0]).toMatchObject({ name: 'Ignite', stacks: 2 });
    play(pb, [ev(1200, 'stun', { dst: P, durationMs: 1000 }), ev(1250, 'cleanse', { src: P, dst: P })]);
    expect(pb.unit('player', 4)!.statuses).toEqual([]);
    expect(pb.unit('player', 4)!.stunMs).toBe(0);
  });

  it('marks the fight finished and stops timers at battle_end', () => {
    const pb = ready();
    play(pb, [ev(1500, 'battle_end', { result: 'victory' })]);
    expect(pb.finished).toBe(true);
    expect(pb.result).toBe('victory');
    const actionMs = pb.unit('player', 4)!.actionMs;
    clock += 2000;
    pb.tick();
    expect(pb.unit('player', 4)!.actionMs).toBe(actionMs);
    expect(pb.elapsedMs).toBe(1500);
  });

  it('guesses status kinds from names', () => {
    expect(guessStatusKind('Sunder')).toBe('mark');
    expect(guessStatusKind('War Song')).toBe('buff');
    expect(guessStatusKind('Mending')).toBe('hot');
    expect(guessStatusKind('Lullaby')).toBe('debuff');
  });
});

describe('CombatPlayback timers', () => {
  it('extrapolates timers from the last snapshot and holds a full ring', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player({ actionMs: 300, skills: [{ id: 's', remainingMs: 500, cooldownMs: 3000, state: 'cooldown' }] }), monster()]);
    clock += DELAY + 200;
    pb.tick();
    const u = pb.unit('player', 4)!;
    expect(u.actionMs).toBe(100);
    expect(u.skills![0].remainingMs).toBe(300);
    clock += 1000;
    pb.tick();
    expect(u.actionMs).toBe(0);
    expect(u.skills![0].remainingMs).toBe(0);
  });

  it('does not pull the action ring back for a snapshot only slightly behind it, but follows larger corrections', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    const cd = (remainingMs: number) => [{ id: 's', remainingMs, cooldownMs: 3000, state: 'cooldown' as const }];
    startBattle(pb, [player({ actionMs: 900, skills: cd(2000) }), monster()]);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1400, [player({ actionMs: 600, skills: cd(1700) }), monster()]), events: [] }, clock + 400);
    clock += DELAY + 400;
    pb.tick();
    expect(pb.unit('player', 4)!.actionMs).toBe(500);
    expect(pb.unit('player', 4)!.skills![0].remainingMs).toBe(1600);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1600, [player({ actionMs: 600 }), monster()]), events: [] }, clock);
    clock += 300;
    const rt = pb.tick().renderTime;
    expect(rt).toBeGreaterThanOrEqual(1600);
    expect(pb.unit('player', 4)!.actionMs).toBe(600 - (rt - 1600));
  });

  it('keeps dead units frozen', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player({ hp: 0, actionMs: 500 }), monster()]);
    clock += 2000;
    pb.tick();
    expect(pb.unit('player', 4)!.actionMs).toBe(500);
  });

  it('caches static fields per battle from full snapshots only', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player({ name: 'Kay', className: 'Knight', passives: ['knight_guard'] }), monster({ name: 'Wolf', id: 'wolf' })]);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1500, [player(), monster()]), events: [] }, clock);
    expect(pb.statics('player:4')).toMatchObject({ name: 'Kay', className: 'Knight', passives: ['knight_guard'] });
    expect(pb.statics('monster:1')).toMatchObject({ name: 'Wolf', id: 'wolf' });
  });
});

describe('CombatPlayback reconciliation', () => {
  it('resets model, queue and statics on a new battleId and applies its snapshot at once', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.ingestMessage({ battleId: 1, events: [ev(1100, 'damage', { dst: M, amount: 5 })] }, clock);
    const version = pb.version;
    pb.ingestMessage({ battleId: 2, snapshot: fullSnap(100, [player({ pos: 2 })], 2), events: [ev(100, 'battle_start')] }, clock);
    expect(pb.battleId).toBe(2);
    expect(pb.version).toBeGreaterThan(version);
    expect(pb.units.map(u => u.key)).toEqual(['player:2']);
    expect(pb.unit('monster', 1)).toBeUndefined();
    expect(pb.queuedEvents).toBe(1);
    clock += DELAY + 1;
    expect(pb.tick().events.map(e => e.kind)).toEqual(['battle_start']);
  });

  it('ignores an older snapshot of the same battle', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player({ hp: 70 }), monster()], 2000);
    pb.ingestState(fullSnap(1500, [player({ hp: 100 }), monster()]), clock);
    clock += 5000;
    pb.tick();
    expect(pb.unit('player', 4)!.hp).toBe(70);
  });

  it('clears the fight when a state arrives without combat', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.ingestState(undefined, clock);
    expect(pb.battleId).toBeNull();
    expect(pb.units).toHaveLength(0);
  });

  it('catches up when more than 1500 ms behind, keeping a pending battle_end', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    clock += 16;
    pb.tick();
    pb.ingestMessage({
      battleId: 1,
      snapshot: snap(4000, [player({ hp: 10 }), monster({ hp: 0 })], { finished: true, result: 'victory' }),
      events: [ev(1500, 'damage', { dst: M, amount: 5 }), ev(3900, 'battle_end', { result: 'victory' })],
    }, clock);
    clock += CATCH_UP_MS + 500;
    const tick = pb.tick();
    expect(tick.events.map(e => e.kind)).toEqual(['battle_end']);
    expect(pb.unit('monster', 1)!.hp).toBe(0);
    expect(pb.unit('player', 4)!.hp).toBe(10);
    expect(pb.finished).toBe(true);
  });

  it('keeps only the newest snapshot while inactive and applies it on activate', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    startBattle(pb);
    pb.ingestMessage({ battleId: 1, snapshot: snap(1500, [player({ hp: 80 }), monster()]), events: [ev(1400, 'damage', { dst: P, amount: 20 })] }, clock);
    pb.ingestMessage({ battleId: 1, snapshot: snap(2000, [player({ hp: 60 }), monster()]), events: [ev(1900, 'damage', { dst: P, amount: 20 })] }, clock);
    expect(pb.queuedEvents).toBe(0);
    pb.setActive(true);
    expect(pb.unit('player', 4)!.hp).toBe(60);
    clock += 50;
    expect(pb.tick().events).toHaveLength(0);
  });

  it('freezes a stale model on activate until a fresh snapshot arrives, then jumps to it', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb, [player({ hp: 100 }), monster({ hp: 50 })]);
    clock += 16;
    pb.tick();
    pb.setActive(false);
    clock += STALE_RESUME_MS + 3000;
    pb.setActive(true);
    expect(pb.syncing).toBe(true);
    const frozen = pb.tick();
    expect(frozen.jumped).toBe(true);
    expect(pb.unit('player', 4)!.actionMs).toBeGreaterThan(0);
    clock += 80;
    pb.ingestMessage({ battleId: 1, snapshot: fullSnap(5100, [player({ hp: 30 }), monster({ hp: 20 })]), events: [] }, clock);
    expect(pb.syncing).toBe(false);
    expect(pb.unit('player', 4)!.hp).toBe(30);
    expect(pb.renderTime).toBeGreaterThanOrEqual(5100);
    expect(pb.tick().jumped).toBe(true);
    clock += 16;
    expect(pb.tick().jumped).toBe(false);
  });

  it('does not wait on activate when the model is fresh, and gives up waiting after SYNC_WAIT_MS', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.setActive(false);
    clock += 200;
    pb.setActive(true);
    expect(pb.syncing).toBe(false);
    pb.setActive(false);
    clock += STALE_RESUME_MS + 500;
    pb.setActive(true);
    expect(pb.syncing).toBe(true);
    clock += SYNC_WAIT_MS + 1;
    pb.tick();
    expect(pb.syncing).toBe(false);
  });

  it('drops queued events on deactivate', () => {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    startBattle(pb);
    pb.ingestMessage({ battleId: 1, events: [ev(1100, 'damage', { dst: M, amount: 5 })] }, clock);
    pb.setActive(false);
    expect(pb.queuedEvents).toBe(0);
  });
});

describe('CombatPlayback bosses, enrage and retreat', () => {
  const B = { side: 'monster' as const, pos: 4 as const };
  const BOSS_PHASES = { bossPos: [4 as const], thresholds: [0.66, 0.33], phase: 0 };

  function boss(overrides: Partial<ClientCombatUnit> = {}): ClientCombatUnit {
    return monster({ pos: 4, hp: 900, maxHp: 1000, name: 'Chieftain', id: 'goblin_chieftain', level: 6, levelSource: 'authored', tier: 'boss', ...overrides });
  }

  function start(units: ClientCombatUnit[], bossPhases?: ClientCombatSnapshot['bossPhases']): CombatPlayback {
    const pb = new CombatPlayback({ now, delayMs: DELAY });
    pb.setActive(true);
    const full = { ...fullSnap(1000, units), ...(bossPhases ? { bossPhases } : {}) };
    pb.ingestMessage({ battleId: 1, snapshot: full, events: [] }, clock);
    return pb;
  }

  function play(pb: CombatPlayback, events: CombatEvent[], snapshot?: ClientCombatSnapshot): void {
    const last = Math.max(...events.map(e => e.t), snapshot?.elapsedMs ?? -Infinity);
    while (pb.serverNow()! < last) {
      clock += Math.min(100, last - pb.serverNow()!);
      pb.tick();
    }
    pb.ingestMessage({ battleId: 1, events, snapshot }, clock);
    clock += DELAY + 1;
    pb.tick();
  }

  it('ends a fight as a retreat from the battle_end event or a finished snapshot', () => {
    const pb = start([player(), monster()]);
    play(pb, [ev(1500, 'battle_end', { result: 'retreat' })]);
    expect(pb.finished).toBe(true);
    expect(pb.result).toBe('retreat');

    const other = start([player(), monster()]);
    play(other, [], snap(1400, [player(), monster()], { finished: true, result: 'retreat' }));
    expect(other.result).toBe('retreat');
  });

  it('caches level, level source and tier as statics', () => {
    const pb = start([player({ level: 7 }), boss(), monster({ level: 3, levelSource: 'derived', tier: 'elite' })], BOSS_PHASES);
    expect(pb.statics('monster:4')).toMatchObject({ level: 6, levelSource: 'authored', tier: 'boss' });
    expect(pb.statics('monster:1')).toMatchObject({ level: 3, levelSource: 'derived', tier: 'elite' });
    expect(pb.statics('player:4')).toMatchObject({ level: 7 });
  });

  it('is not a boss fight without bossPhases', () => {
    const pb = start([player(), monster()]);
    expect(pb.bossPhases).toBeNull();
    expect(pb.bossHpFraction()).toBeNull();
  });

  it('reads thresholds from the full snapshot and follows the phase from events and dynamic snapshots', () => {
    const pb = start([player(), boss()], BOSS_PHASES);
    expect(pb.bossPhases).toEqual({ bossPos: [4], thresholds: [0.66, 0.33], phase: 0 });
    play(pb, [ev(1200, 'phase', { amount: 1 })]);
    expect(pb.bossPhases!.phase).toBe(1);
    play(pb, [], snap(1600, [player(), boss({ hp: 300 })], { bossPhases: { bossPos: [4], phase: 2 } }));
    expect(pb.bossPhases).toMatchObject({ thresholds: [0.66, 0.33], phase: 2 });
  });

  it('recovers a checkpoint whose event was dropped from the next dynamic snapshot', () => {
    const pb = start([player(), boss()], BOSS_PHASES);
    play(pb, [], snap(1500, [player(), boss({ hp: 600 })], { bossPhases: { bossPos: [4], phase: 1 } }));
    expect(pb.bossPhases!.phase).toBe(1);
  });

  it('keeps the resume point and cleans up authored thresholds', () => {
    const pb = start([player(), boss({ hp: 660 })], { bossPos: [4], thresholds: [0.33, Number.NaN, 0.66, 1.2], phase: 1, resumedFromPhase: 1 });
    expect(pb.bossPhases).toEqual({ bossPos: [4], thresholds: [0.66, 0.33], phase: 1, resumedFromPhase: 1 });
  });

  it('pools boss HP across all boss units', () => {
    const units = [player(), boss({ pos: 1, hp: 300, maxHp: 1000 }), boss({ pos: 4, hp: 500, maxHp: 1000 }), monster({ pos: 7, hp: 5, maxHp: 50 })];
    const pb = start(units, { bossPos: [1, 4], thresholds: [0.5], phase: 0 });
    expect(pb.bossHpFraction()).toBeCloseTo(0.4);
    play(pb, [ev(1200, 'damage', { dst: B, amount: 500 })]);
    expect(pb.bossHpFraction()).toBeCloseTo(0.15);
  });

  it('tracks enrage from snapshots and events and never cleanses it as a buff', () => {
    const enrage = { atMs: 2000, stacks: 0, stepMs: 1000, stepPercent: 0.1, maxStacks: 30 };
    const pb = start([player(), boss({ enrage })], BOSS_PHASES);
    const unit = pb.unit('monster', 4)!;
    expect(enrageDisplay(unit.enrage, pb.elapsedMs)).toMatchObject({ state: 'soon', stacks: 0, multiplier: 1 });
    play(pb, [ev(1500, 'status', { dst: B, name: 'Rally' }), ev(2000, 'enrage', { src: B, amount: 1 })]);
    expect(unit.enrage!.stacks).toBe(1);
    expect(unit.statuses).toContainEqual({ kind: 'enrage', name: 'Enraged', stacks: 1 });
    expect(enrageDisplay(unit.enrage, pb.elapsedMs)).toMatchObject({ state: 'on', stacks: 1, multiplier: 1.1 });
    play(pb, [ev(2100, 'cleanse', { src: P, dst: B })]);
    expect(unit.statuses.map(s => s.kind)).toEqual(['enrage']);
    play(pb, [ev(3000, 'enrage', { src: B, amount: 2 })]);
    expect(unit.statuses).toEqual([{ kind: 'enrage', name: 'Enraged', stacks: 2 }]);
    expect(enrageDisplay(unit.enrage, pb.elapsedMs)!.multiplier).toBeCloseTo(1.2);
  });

  it('builds an enrage clock from the event when no snapshot carried one', () => {
    const pb = start([player(), boss()], BOSS_PHASES);
    play(pb, [ev(1400, 'enrage', { src: B, amount: 1 })]);
    expect(pb.unit('monster', 4)!.enrage).toMatchObject({ atMs: 1400, stacks: 1 });
  });

  it('picks the boss that enrages first as the enrage source', () => {
    const add = monster({ pos: 1, enrage: { atMs: 1000, stacks: 0, stepMs: 1000, stepPercent: 0.1, maxStacks: 5 } });
    const late = boss({ pos: 7, enrage: { atMs: 9000, stacks: 0, stepMs: 1000, stepPercent: 0.1, maxStacks: 5 } });
    const early = boss({ enrage: { atMs: 5000, stacks: 0, stepMs: 1000, stepPercent: 0.1, maxStacks: 5 } });
    const pb = start([player(), add, late, early], { bossPos: [4, 7], thresholds: [], phase: 0 });
    expect(pb.enrageSource()?.key).toBe('monster:4');
    play(pb, [ev(1100, 'death', { dst: B })]);
    expect(pb.enrageSource()?.key).toBe('monster:7');
  });

  it('describes the enrage countdown and multiplier', () => {
    const clock0 = { atMs: 480_000, stacks: 0, stepMs: 30_000, stepPercent: 0.1, maxStacks: 30 };
    expect(enrageDisplay(null, 0)).toBeNull();
    expect(enrageDisplay(clock0, 0)).toEqual({ state: 'pending', remainingMs: 480_000, stacks: 0, multiplier: 1 });
    expect(enrageDisplay(clock0, 480_000 - ENRAGE_SOON_MS)!.state).toBe('soon');
    expect(enrageDisplay(clock0, 500_000)).toMatchObject({ state: 'soon', remainingMs: 0 });
    expect(enrageDisplay({ ...clock0, stacks: 6 }, 650_000)).toMatchObject({ state: 'on', stacks: 6 });
    expect(enrageDisplay({ ...clock0, stacks: 6 }, 650_000)!.multiplier).toBeCloseTo(1.6);
  });

  it('guesses the enrage status kind from its name', () => {
    expect(guessStatusKind('Enraged')).toBe('enrage');
  });
});

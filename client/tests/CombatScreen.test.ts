import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientCombatSkill,
  ClientCombatSnapshot,
  ClientCombatUnit,
  CombatEvent,
  CombatLogEntry,
  ServerCombatMessage,
  ServerStateMessage,
  SkillDefinition,
} from '@idle-party-rpg/shared';
import { COMBAT_PACE, paceActionSeconds } from '@idle-party-rpg/shared';
import { CombatScreen, laneTracks, usedGridTracks } from '../src/screens/CombatScreen';
import { formatDuration } from '../src/combat/CombatFormat';
import { CombatLogBuffer } from '../src/combat/CombatLogBuffer';
import { dismissTop } from '../src/ui/ModalStack';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type CombatListener = (msg: ServerCombatMessage, receivedAt: number) => void;

const ALICE: ClientCombatUnit = { side: 'player', pos: 4, hp: 10, maxHp: 10, actionMs: 800, actionTotalMs: 1000, name: 'alice', className: 'Knight' };
const GOBLIN: ClientCombatUnit = { side: 'monster', pos: 1, hp: 5, maxHp: 5, actionMs: 600, actionTotalMs: 1000, name: 'Goblin', id: 'goblin' };
const WOLF: ClientCombatUnit = { ...GOBLIN, pos: 2, name: 'Wolf', id: 'wolf' };
const FRAME_MS = 16;
const PLAYBACK_DUE_MS = 400;
const LOG_REPAINT_MS = 300;

function snapshot(battleId: number, monster: ClientCombatUnit, elapsedMs = 1000): ClientCombatSnapshot {
  return { battleId, elapsedMs, full: true, finished: false, result: null, units: [ALICE, monster] };
}

function makeState(battleId: number, monster: ClientCombatUnit, log: CombatLogEntry[]): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: 0, row: 0, path: [] },
    unlocked: ['room-1'],
    zoneName: 'Meadow',
    currentMapId: 'overworld',
    combatLog: log,
    character: { className: 'Knight', level: 3, xp: 10, xpForNextLevel: 100, gold: 50, skillLoadout: { equippedSkills: [] } },
    social: { party: { members: [{ username: 'alice', role: 'owner', gridPosition: 4 }], henchmen: [] } },
    battle: { state: 'battle', visual: 'fighting', combat: snapshot(battleId, monster) },
  } as unknown as ServerStateMessage;
}

function setup(initial?: ServerStateMessage, skills: Record<string, SkillDefinition> = {}) {
  document.body.innerHTML = '<div id="combat"></div>';
  const stateListeners = new Set<StateListener>();
  const combatListeners = new Set<CombatListener>();
  const combatLog = new CombatLogBuffer();
  let lastState: ServerStateMessage = initial ?? makeState(1, GOBLIN, []);

  const gameClient = {
    get lastState() { return lastState; },
    lastCombat: null,
    lastBestiary: null,
    combatLog,
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onCombat: (l: CombatListener) => { combatListeners.add(l); return () => { combatListeners.delete(l); }; },
    onForecast: () => () => {},
    peekForecast: () => null,
    sendCombatView: vi.fn(),
    sendRun: vi.fn(),
    sendLeaveDungeon: vi.fn(),
  } as unknown as GameClient;
  const worldCache = {
    getTileOn: () => ({ id: 'room-1', name: 'Old Mill', zone: 'meadow' }),
    getSkill: (id: string) => skills[id],
    getSkillContent: () => ({ skills }),
    getSlotSchedule: () => [],
  } as unknown as WorldCache;

  const screen = new CombatScreen('combat', gameClient, worldCache);
  screen.onActivate();
  vi.advanceTimersByTime(FRAME_MS);

  const pushState = (battleId: number, monster: ClientCombatUnit, log: CombatLogEntry[] = []) => {
    lastState = makeState(battleId, monster, log);
    combatLog.ingestJournal(log);
    for (const l of stateListeners) l(lastState);
  };
  const push = (next: ServerStateMessage) => {
    lastState = next;
    for (const l of stateListeners) l(lastState);
  };
  const playEvents = (events: CombatEvent[], battleId = 1) => {
    const msg: ServerCombatMessage = { type: 'combat', battleId, events, log: [] };
    for (const l of combatListeners) l(msg, performance.now());
    vi.advanceTimersByTime(PLAYBACK_DUE_MS);
  };
  const playerCard = () => document.querySelector('.combat-player-side .combat-card[data-grid="4"]') as HTMLElement;
  const enemyCard = (pos: number) => document.querySelector(`.combat-enemy-side .combat-card[data-grid="${pos}"]`) as HTMLElement | null;

  return { screen, pushState, push, playEvents, playerCard, enemyCard };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

function withBattle(base: ServerStateMessage, battle: object, extra: object = {}): ServerStateMessage {
  return { ...base, ...extra, battle: { ...base.battle, ...battle } } as ServerStateMessage;
}

const statusText = () => document.querySelector('.combat-status')!.textContent;
const statusShown = () => document.querySelector('.combat-status')!.classList.contains('show');
const stage = () => document.querySelector('.combat-stage')!;

describe('CombatScreen', () => {
  let active: CombatScreen | null = null;
  const start = (initial?: ServerStateMessage, skills?: Record<string, SkillDefinition>) => {
    const t = setup(initial, skills);
    active = t.screen;
    return t;
  };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    active?.onDeactivate();
    active = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('draws a live combat event on the unit it hit', () => {
    const t = start();
    const flash = t.enemyCard(1)!.querySelector('.combat-card-flash')!;
    const animate = vi.fn();
    (flash as unknown as { animate: unknown }).animate = animate;

    t.playEvents([{ id: 1, t: 1100, kind: 'damage', src: { side: 'player', pos: 4 }, dst: { side: 'monster', pos: 1 }, amount: 3, dmgType: 'physical' }]);

    expect(animate).toHaveBeenCalled();
    expect(document.querySelector('.combat-floater.live')?.textContent).toContain('3');
  });

  it('keeps the card icon nodes across updates', () => {
    const t = start();
    const initials = t.playerCard().querySelector('.combat-card-icon')!;
    const classIcon = t.playerCard().querySelector('.combat-card-classicon')!;
    expect(classIcon.getAttribute('src')).toBe('/class-icons/Knight.png');
    const setAttr = vi.spyOn(classIcon, 'setAttribute');

    t.pushState(1, GOBLIN);
    t.playEvents([{ id: 1, t: 1100, kind: 'dodge', src: { side: 'monster', pos: 1 }, dst: { side: 'player', pos: 4 } }]);

    expect(t.playerCard().querySelector('.combat-card-icon')).toBe(initials);
    expect(t.playerCard().querySelector('.combat-card-classicon')).toBe(classIcon);
    expect(setAttr).not.toHaveBeenCalled();
    expect(document.querySelector('.combat-floater.live')?.textContent).toBe('DODGE');
  });

  it('holds a new-battle rebuild while a monster card is pressed', () => {
    const t = start();
    const card = t.enemyCard(1)!;

    press(card);
    t.pushState(2, WOLF);
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(t.enemyCard(1)).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(t.enemyCard(2)).toBeNull();

    card.click();
    expect(document.querySelector('.monster-popup-name')?.textContent).toBe('Goblin');

    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(t.enemyCard(1)).toBeNull();
    expect(t.enemyCard(2)!.querySelector('.combat-card-name')!.textContent).toBe('Wolf');
  });

  it('keeps appending and colouring the combat log while a card is pressed', () => {
    const t = start();
    press(t.enemyCard(1)!);

    t.pushState(2, WOLF, [{ id: 1, text: 'Wolf attacks alice for 3 physical damage', type: 'damage' } as CombatLogEntry]);
    vi.advanceTimersByTime(LOG_REPAINT_MS);

    expect(t.enemyCard(2)).toBeNull();
    const entry = document.querySelector('.combat-log-ticker .log-entry')!;
    expect(entry.textContent).toBe('Wolf attacks you for 3 physical damage');
    expect(entry.querySelector('.log-name-enemy')?.textContent).toBe('Wolf');
    expect(entry.querySelector('.log-name-self')?.textContent).toBe('you');
  });

  it('draws no placeholder slots: an empty seat is just the plate', () => {
    start();
    expect(document.querySelectorAll('.combat-grid-empty')).toHaveLength(0);
    expect(document.querySelectorAll('.combat-card')).toHaveLength(2);
  });

  it('keeps party cards across battles and replaces only the monsters', () => {
    const t = start();
    const party = t.playerCard();
    const monster = t.enemyCard(1);

    t.pushState(2, GOBLIN);
    vi.advanceTimersByTime(FRAME_MS * 2);

    expect(t.playerCard()).toBe(party);
    expect(t.enemyCard(1)).not.toBe(monster);
  });

  it('shows whoever now sits in a seat when the next battle starts', () => {
    const t = start();
    const bob: ClientCombatUnit = { ...ALICE, name: 'bob' };
    t.push(withBattle(makeState(2, GOBLIN, []), { combat: { ...snapshot(2, GOBLIN), units: [bob, GOBLIN] } }));
    vi.advanceTimersByTime(FRAME_MS * 2);

    expect(t.playerCard().querySelector('.combat-card-name')!.textContent).toBe('bob');
    expect(t.playerCard().classList.contains('self')).toBe(false);
  });

  it('clears a target reticle from a card that stays for the next battle', () => {
    const t = start();
    const caster = { ...GOBLIN, cast: { skill: 'Slam', skillId: 'slam', totalMs: 5000, remainingMs: 4000, target: { side: 'player' as const, pos: 4 } } };
    t.push(withBattle(makeState(1, caster, []), { combat: snapshot(1, caster, 2000) }));
    vi.advanceTimersByTime(PLAYBACK_DUE_MS * 3);
    expect(t.playerCard().classList.contains('targeted')).toBe(true);

    t.pushState(2, GOBLIN);
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(t.playerCard().classList.contains('targeted')).toBe(false);
  });

  it('dims the board instead of emptying it when the fight is cleared', () => {
    const t = start();
    const party = t.playerCard();
    const monster = t.enemyCard(1);
    t.push(withBattle(makeState(1, GOBLIN, []), { visual: 'none', combat: undefined }));
    vi.advanceTimersByTime(FRAME_MS * 2);

    expect(stage().classList.contains('no-combat')).toBe(true);
    expect(t.playerCard()).toBe(party);
    expect(t.enemyCard(1)).toBe(monster);
    expect(statusText()).toBe('Regrouping');
    expect(statusShown()).toBe(true);

    monster!.click();
    expect(document.querySelector('.monster-popup-overlay')).toBeNull();

    t.pushState(2, WOLF);
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(stage().classList.contains('no-combat')).toBe(false);
    expect(t.playerCard()).toBe(party);
    expect(t.enemyCard(1)).toBeNull();
    expect(t.enemyCard(2)).not.toBeNull();
  });

  it('draws the party from the roster on a first load with no fight', () => {
    const base = withBattle(makeState(1, GOBLIN, []), { visual: 'none', combat: undefined }, {
      social: {
        party: {
          members: [{ username: 'alice', role: 'owner', gridPosition: 4 }, { username: 'bob', role: 'member', gridPosition: 3, className: 'Mage' }],
          henchmen: [{ gridPosition: 5, name: 'Squire', emoji: 'S', level: 1 }],
        },
      },
    });
    const t = start(base);

    expect(stage().classList.contains('no-combat')).toBe(true);
    expect(t.playerCard().classList.contains('self')).toBe(true);
    expect(t.playerCard().querySelector<HTMLImageElement>('.combat-card-classicon')!.getAttribute('src')).toBe('/class-icons/Knight.png');
    expect(document.querySelector('.combat-card[data-grid="3"] .combat-card-name')!.textContent).toBe('bob');
    const henchman = document.querySelector('.combat-card[data-grid="5"]')!;
    expect(henchman.classList.contains('henchman')).toBe(true);
    expect(henchman.querySelector('.combat-card-name')!.textContent).toBe('Squire');
  });

  it('says what the party is doing through a whole fight cycle', () => {
    const t = start();
    expect(statusShown()).toBe(false);

    const finished = { ...snapshot(1, { ...GOBLIN, hp: 0 }), finished: true, result: 'victory' as const };
    const base = makeState(1, GOBLIN, []);
    const earned = { character: { ...base.character!, xp: 25, gold: 57 } };
    const onward = { party: { col: 0, row: 0, path: [{ col: 1, row: 0 }] } };

    t.push(withBattle(base, { state: 'result', visual: 'victory', combat: finished }, { ...earned, ...onward }));
    vi.advanceTimersByTime(PLAYBACK_DUE_MS);
    expect(statusShown()).toBe(true);
    expect(statusText()).toBe('Victory+15 XP+7 goldWalking to Old Mill');
    expect(document.querySelector('.combat-status')!.getAttribute('data-tone')).toBe('victory');
    expect(stage().classList.contains('victory')).toBe(true);

    t.push(withBattle(base, { state: 'result', visual: 'none', combat: finished }, earned));
    expect(statusText()).toBe('Victory+15 XP+7 goldWalking to Old Mill');
    expect(stage().classList.contains('victory')).toBe(false);

    t.push(withBattle(makeState(2, WOLF, []), {}, earned));
    expect(statusShown()).toBe(false);
  });

  it('keeps the big banners and sparkles for tough fights but always announces', () => {
    const t = start();
    t.playEvents([{ id: 1, t: 1100, kind: 'battle_end', result: 'victory' }]);
    expect(document.querySelector('.combat-banner')!.classList.contains('show')).toBe(false);
    expect(document.querySelector('.combat-spark')).toBeNull();
    vi.advanceTimersByTime(100);
    expect(document.querySelector('.combat-announcer')!.textContent).toBe('VICTORY!');

    const elite: ClientCombatUnit = { ...GOBLIN, tier: 'elite' };
    t.push(withBattle(makeState(3, elite, []), { combat: snapshot(3, elite) }));
    vi.advanceTimersByTime(FRAME_MS * 2);
    t.playEvents([{ id: 7, t: 1100, kind: 'battle_end', result: 'victory' }], 3);
    expect(document.querySelector('.combat-banner .combat-banner-text')!.textContent).toBe('VICTORY!');
  });

  it('holds a ticker repaint while the ticker itself is pressed', () => {
    const t = start();
    t.pushState(1, GOBLIN, [{ id: 1, text: 'First line', type: 'damage' } as CombatLogEntry]);
    vi.advanceTimersByTime(LOG_REPAINT_MS);
    const ticker = document.querySelector('.combat-log-ticker')!;
    const line = ticker.querySelector('.log-entry')!;

    press(line);
    t.pushState(1, GOBLIN, [{ id: 2, text: 'Second line', type: 'damage' } as CombatLogEntry]);
    vi.advanceTimersByTime(LOG_REPAINT_MS);
    expect(line.isConnected).toBe(true);
    expect(ticker.textContent).not.toContain('Second line');

    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(ticker.textContent).toContain('Second line');
  });

  it('closes the full log with Back, and when the player leaves the screen', () => {
    const t = start();
    const wrapper = document.querySelector('.combat-log-wrapper')!;
    const expand = document.querySelector<HTMLElement>('.log-fullscreen-btn')!;

    expand.click();
    expect(wrapper.classList.contains('fullscreen')).toBe(true);
    expect(dismissTop()).toBe(true);
    expect(wrapper.classList.contains('fullscreen')).toBe(false);
    expect(dismissTop()).toBe(false);

    expand.click();
    t.screen.onDeactivate();
    expect(wrapper.classList.contains('fullscreen')).toBe(false);
    expect(dismissTop()).toBe(false);
    t.screen.onActivate();
  });

  it('lets Back close a monster popup', () => {
    const t = start();
    t.enemyCard(1)!.click();
    expect(document.querySelector('.monster-popup-overlay')).not.toBeNull();
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.monster-popup-overlay')).toBeNull();
  });

  it('turns the empty skill bar note into a link to the Skills view', () => {
    const t = start();
    const unskilled: ClientCombatUnit = { ...ALICE, skills: [] };
    t.push(withBattle(makeState(2, GOBLIN, []), { combat: { ...snapshot(2, GOBLIN), units: [unskilled, GOBLIN] } }));
    vi.advanceTimersByTime(FRAME_MS * 2);
    const note = document.querySelector<HTMLElement>('.combat-skillbar-note')!;
    expect(note.tagName).toBe('BUTTON');
    expect(note.dataset.nav).toBe('items:skills');
    expect(document.querySelector('.combat-skillbar')!.classList.contains('empty')).toBe(true);
  });

  describe('Attack card', () => {
    const ATTACK = { id: 'knight_attack', name: 'Attack', description: 'Swing.', className: 'Knight', type: 'attack', unlockLevel: 1, sortOrder: 0, charge: 3.6, recovery: 0.9 } as SkillDefinition;
    const attackView: ClientCombatSkill = { id: 'knight_attack', remainingMs: 1800, cooldownMs: 3600, state: 'cooldown', name: 'Attack', cardType: 'basic', chargeMs: 3600, recoveryMs: 900, useCooldownMs: 4500, baseCooldownMs: 4500 };
    const fightWith = (unit: ClientCombatUnit) => withBattle(makeState(1, GOBLIN, []), { combat: { ...snapshot(1, GOBLIN), units: [unit, GOBLIN] } });
    const card = () => document.querySelector<HTMLElement>('.combat-skill[data-skill-id="knight_attack"]')!;

    it('sits on the bar with its charge sweep', () => {
      start(fightWith({ ...ALICE, skills: [attackView] }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(card().dataset.cardType).toBe('basic');
      expect(card().dataset.state).toBe('cooldown');
      expect(card().querySelector<HTMLElement>('.combat-skill-sweep')!.style.getPropertyValue('--cd')).not.toBe('');
    });

    it('still says when the first active unlocks, beside it', () => {
      start(fightWith({ ...ALICE, skills: [attackView] }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(document.querySelector('.combat-skillbar-note')).not.toBeNull();
      expect(document.querySelector('.combat-skillbar')!.classList.contains('empty')).toBe(false);
    });

    it('is on the bar between fights too', () => {
      start(withBattle(makeState(1, GOBLIN, []), { combat: undefined }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(card()).not.toBeNull();
    });

    it('opens the popover with charge and recovery', () => {
      start(fightWith({ ...ALICE, skills: [attackView] }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      card().click();
      expect([...document.querySelectorAll('.combat-skill-popover-stats span')].map(s => s.textContent)).toEqual(['Charge 3.6s', 'Recovery 0.9s']);
    });

    it('marks a charge cooldown reduction took down against its base', () => {
      const bash: ClientCombatSkill = { id: 'bash', remainingMs: 0, cooldownMs: 0, state: 'ready', chargeMs: 6300, recoveryMs: 900, useCooldownMs: 5400, baseCooldownMs: 7200, castTimeMs: 0 };
      start(fightWith({ ...ALICE, skills: [bash] }));
      vi.advanceTimersByTime(FRAME_MS * 2);
      document.querySelector<HTMLElement>('.combat-skill[data-skill-id="bash"]')!.click();
      expect([...document.querySelectorAll('.combat-skill-popover-stats span')].map(s => s.textContent)).toEqual(['Charge 4.5s (base 6.3s)', 'Recovery 0.9s']);
    });

    it('never locks an instant during recovery, and shows it no recovery', () => {
      const dispel: ClientCombatSkill = { id: 'dispel', remainingMs: 0, cooldownMs: 0, state: 'armed', name: 'Dispel', cardType: 'instant', trigger: 'enemy_cast', chargeMs: 9900, recoveryMs: 0, useCooldownMs: 9900, baseCooldownMs: 9900, castTimeMs: 0 };
      start(fightWith({ ...ALICE, recoveryMs: 900, recoveryTotalMs: 900, skills: [dispel, attackView] }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      const dispelCard = document.querySelector<HTMLElement>('.combat-skill[data-skill-id="dispel"]')!;
      expect(dispelCard.classList.contains('locked')).toBe(false);
      expect(dispelCard.querySelector('.combat-skill-status')!.textContent).toBe('ARMED');
      expect(card().classList.contains('locked')).toBe(true);
      dispelCard.click();
      expect([...document.querySelectorAll('.combat-skill-popover-stats span')].map(s => s.textContent)).toEqual(['Charge 9.9s']);
      expect(document.querySelector('.combat-skill-popover-type')!.textContent).toBe('Instant');
      expect(document.querySelector('.combat-skill-popover-trigger')!.textContent).toContain('Enemy casts');
    });

    it('locks every card that uses the turn during recovery', () => {
      const bash: ClientCombatSkill = { id: 'bash', remainingMs: 0, cooldownMs: 0, state: 'ready' };
      start(fightWith({ ...ALICE, recoveryMs: 900, recoveryTotalMs: 900, skills: [bash, attackView] }), { knight_attack: ATTACK });
      vi.advanceTimersByTime(FRAME_MS * 2);
      const bashCard = document.querySelector<HTMLElement>('.combat-skill[data-skill-id="bash"]')!;
      expect(bashCard.classList.contains('locked')).toBe(true);
      expect(bashCard.querySelector('.combat-skill-status')!.textContent).toBe('LOCKED');
      expect(card().classList.contains('locked')).toBe(true);
    });
  });

  describe('action ring', () => {
    const fightWith = (unit: ClientCombatUnit, foe: ClientCombatUnit = GOBLIN) => withBattle(makeState(1, foe, []), { combat: { ...snapshot(1, foe), units: [unit, foe] } });
    const act = (el: Element) => (el.querySelector('.combat-card-ring') as HTMLElement).style.getPropertyValue('--act');

    it('is complete for a player with no wait', () => {
      const t = start(fightWith({ ...ALICE, actionMs: 0, actionTotalMs: 0 }));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(act(t.playerCard())).toBe('1.00');
    });

    it('stays empty on a passive monster, whose timer is also 0', () => {
      const wall: ClientCombatUnit = { ...GOBLIN, actionMs: 0, actionTotalMs: 0, passive: true };
      const t = start(fightWith(ALICE, wall));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(act(t.enemyCard(1)!)).not.toBe('1.00');
    });
  });

  describe('skill popover', () => {
    const BASH = { id: 'bash', name: 'Bash', description: '', className: 'Knight', type: 'active', unlockLevel: 1, cooldown: 2, castTime: 1, activeEffects: [] } as unknown as SkillDefinition;

    const openBash = (statics: Partial<ClientCombatSkill>, ownerClass = 'Knight') => {
      const knight: ClientCombatUnit = { ...ALICE, skills: [{ id: 'bash', remainingMs: 0, cooldownMs: 0, state: 'ready', ...statics }] };
      const base = makeState(1, GOBLIN, []);
      start(withBattle(base, { combat: { ...snapshot(1, GOBLIN), units: [knight, GOBLIN] } }, { character: { ...base.character, className: ownerClass } }), { bash: BASH });
      vi.advanceTimersByTime(FRAME_MS * 2);
      document.querySelector<HTMLElement>('.combat-skill[data-skill-id="bash"]')!.click();
      return [...document.querySelectorAll('.combat-skill-popover-stats span')].map(s => s.textContent);
    };

    it('reads cooldown and cast from the snapshot before the authored skill', () => {
      expect(openBash({ baseCooldownMs: 7000, useCooldownMs: 7000, castTimeMs: 3500 })).toEqual(['Cooldown 7s', 'Cast 3.5s']);
    });

    it('marks a reduced cooldown against the snapshot\'s base', () => {
      expect(openBash({ baseCooldownMs: 7000, useCooldownMs: 5600, castTimeMs: 3500 })).toEqual(['Cooldown 5.6s (base 7s)', 'Cast 3.5s']);
    });

    const realTimes = (className: string): string[] => {
      const actionMs = paceActionSeconds(COMBAT_PACE, className) * 1000;
      return [`Cooldown ${formatDuration(BASH.cooldown! * actionMs)}`, `Cast ${formatDuration(BASH.castTime! * actionMs)}`];
    };

    it('falls back to real time for the owner\'s class when the snapshot has no times', () => {
      expect(openBash({})).toEqual(realTimes('Knight'));
    });

    it('times that fallback by the wearer\'s class, not the skill\'s', () => {
      expect(realTimes('Priest')).not.toEqual(realTimes('Knight'));
      expect(openBash({}, 'Priest')).toEqual(realTimes('Priest'));
    });
  });

  it('ends the stage background with generated art so a missing picture still has a place', () => {
    start();
    const bg = document.querySelector<HTMLElement>('.combat-stage-bg')!;
    expect(bg.dataset.bgKey).toContain('/zone-artwork/meadow.png');
    expect(bg.dataset.bgKey!.split(', ').pop()).toContain('data:image/svg+xml');
  });

  describe('board shape', () => {
    const block = (selector: string) => document.querySelector<HTMLElement>(selector)!;
    const fightOf = (monsters: ClientCombatUnit[]) => {
      const base = makeState(2, GOBLIN, []);
      const combat = { ...snapshot(2, GOBLIN), units: [ALICE, ...monsters] };
      return withBattle(base, { combat });
    };

    it('marks a side of one or two units and collapses the tracks it does not use', () => {
      const t = start();
      expect(block('.combat-block-enemy').dataset.roomy).toBe('1');
      expect(block('.combat-block-party').dataset.roomy).toBe('1');

      t.push(fightOf([{ ...GOBLIN, pos: 0 }, { ...WOLF, pos: 8 }]));
      vi.advanceTimersByTime(FRAME_MS * 2);
      const side = block('.combat-enemy-side');
      expect(block('.combat-block-enemy').dataset.roomy).toBe('2');
      expect(side.style.getPropertyValue('--track-col2')).toBe('minmax(0, 1fr)');
      expect(side.style.getPropertyValue('--track-col1')).toBe('0');
    });

    it('shares its lanes across both sides, so a unit lines up with what it faces', () => {
      const t = start();
      const lane = (line: number) => block('.combat-stage-grid').style.getPropertyValue(`--lane${line}`);
      t.push(fightOf([{ ...GOBLIN, pos: 1 }]));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect([lane(0), lane(1), lane(2)]).toEqual(['minmax(0, 1fr)', 'minmax(0, 1fr)', 'minmax(0, 0.25fr)']);

      const nextFight = { ...snapshot(3, GOBLIN), units: [ALICE, { ...GOBLIN, pos: 8 }] };
      t.push(withBattle(makeState(3, GOBLIN, []), { combat: nextFight }));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect([lane(0), lane(1), lane(2)]).toEqual(['minmax(0, 0.25fr)', 'minmax(0, 1fr)', 'minmax(0, 1fr)']);
    });

    it('draws a strip for every lane on both sides', () => {
      start();
      expect(document.querySelectorAll('.combat-block-enemy .combat-lanes > span')).toHaveLength(3);
      expect(document.querySelectorAll('.combat-block-party .combat-lanes > span')).toHaveLength(3);
    });

    it('leaves a larger group on the full grid', () => {
      const t = start();
      t.push(fightOf([{ ...GOBLIN, pos: 0 }, { ...WOLF, pos: 3 }, { ...WOLF, pos: 6, name: 'Bat', id: 'bat' }]));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(block('.combat-block-enemy').dataset.roomy).toBeUndefined();
    });

    it('keeps its shape when a monster dies', () => {
      const t = start();
      t.push(fightOf([{ ...GOBLIN, hp: 0 }]));
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(block('.combat-block-enemy').dataset.roomy).toBe('1');
      expect(t.enemyCard(1)!.classList.contains('dead')).toBe(true);
    });

    it('works out which tracks a side uses', () => {
      expect(usedGridTracks([1, 4])).toEqual({ rows: [true, true, false], cols: [false, true, false] });
      expect(usedGridTracks([])).toEqual({ rows: [false, false, false], cols: [false, false, false] });
    });

    it('narrows lanes nobody stands in, and leaves all three even on an empty board', () => {
      const used = 'minmax(0, 1fr)';
      const empty = 'minmax(0, 0.25fr)';
      expect(laneTracks([4])).toEqual([empty, used, empty]);
      expect(laneTracks([0, 8])).toEqual([used, empty, used]);
      expect(laneTracks([0, 3, 6])).toEqual([used, used, used]);
      expect(laneTracks([])).toEqual([used, used, used]);
    });
  });

  describe('frame loop', () => {
    const noFight = () => withBattle(makeState(1, GOBLIN, []), { state: 'battle', visual: 'none', combat: undefined });
    const framesRequested = () => vi.spyOn(globalThis, 'requestAnimationFrame');

    it('stops once there is no fight to draw', () => {
      const t = start();
      t.push(noFight());
      vi.advanceTimersByTime(FRAME_MS * 3);
      const raf = framesRequested();
      vi.advanceTimersByTime(FRAME_MS * 5);
      expect(raf).not.toHaveBeenCalled();
    });

    it('wakes for the next fight', () => {
      const t = start();
      t.push(noFight());
      vi.advanceTimersByTime(FRAME_MS * 3);
      t.pushState(2, WOLF);
      vi.advanceTimersByTime(FRAME_MS * 2);
      expect(t.enemyCard(2)!.querySelector('.combat-card-name')!.textContent).toBe('Wolf');
    });

    it('keeps running through a fight in progress', () => {
      start();
      const raf = framesRequested();
      vi.advanceTimersByTime(FRAME_MS * 5);
      expect(raf).toHaveBeenCalled();
    });
  });

  describe('hit motion on a crowded board', () => {
    const crowded = () => {
      const monsters = [0, 1, 2, 3, 5, 6, 7].map(pos => ({ ...GOBLIN, pos, name: `Goblin ${pos}`, id: `goblin${pos}` }));
      return withBattle(makeState(1, GOBLIN, []), { combat: { ...snapshot(1, GOBLIN), units: [ALICE, ...monsters] } });
    };
    const spyAnimate = (el: Element) => {
      const animate = vi.fn();
      (el as unknown as { animate: unknown }).animate = animate;
      return animate;
    };

    it('plays only on the player\'s own card, and the number still shows', () => {
      const t = start();
      t.push(crowded());
      vi.advanceTimersByTime(PLAYBACK_DUE_MS);
      const enemyFlash = spyAnimate(t.enemyCard(1)!.querySelector('.combat-card-flash')!);
      const enemyBody = spyAnimate(t.enemyCard(2)!.querySelector('.combat-card-body')!);
      const ownFlash = spyAnimate(t.playerCard().querySelector('.combat-card-flash')!);

      t.playEvents([
        { id: 1, t: 1100, kind: 'attack', src: { side: 'monster', pos: 2 } },
        { id: 2, t: 1100, kind: 'damage', src: { side: 'player', pos: 4 }, dst: { side: 'monster', pos: 1 }, amount: 3, dmgType: 'physical' },
        { id: 3, t: 1100, kind: 'damage', src: { side: 'monster', pos: 2 }, dst: { side: 'player', pos: 4 }, amount: 2, dmgType: 'physical' },
      ]);

      expect(enemyFlash).not.toHaveBeenCalled();
      expect(enemyBody).not.toHaveBeenCalled();
      expect(ownFlash).toHaveBeenCalled();
      expect(document.querySelector('.combat-floater.live')).not.toBeNull();
    });
  });

  it('opens the log from the header on a short screen unless a chat sheet covers it', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    start();
    const wrapper = document.querySelector('.combat-log-wrapper')!;
    const header = document.querySelector<HTMLElement>('.combat-header')!;

    document.body.dataset.chatOpen = '1';
    document.body.dataset.chatLayout = 'sheet';
    header.click();
    expect(wrapper.classList.contains('fullscreen')).toBe(false);

    document.body.dataset.chatLayout = 'column';
    header.click();
    expect(wrapper.classList.contains('fullscreen')).toBe(true);

    delete document.body.dataset.chatOpen;
    delete document.body.dataset.chatLayout;
    vi.unstubAllGlobals();
  });
});

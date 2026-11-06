import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage, SkillDefinition } from '@idle-party-rpg/shared';
import { CharItemsScreen } from '../src/screens/CharItemsScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

function active(id: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id, name: id.toUpperCase(), description: '', className: 'Knight', type: 'active', unlockLevel: 1, sortOrder: 1,
    charge: 2, recovery: 1, activeEffects: [{ kind: 'aoe_damage', valuePerLevel: 1 } as never], ...overrides,
  };
}

const ATTACK: SkillDefinition = {
  id: 'knight_attack', name: 'Attack', description: 'Swing.', className: 'Knight', type: 'attack', unlockLevel: 1, sortOrder: 0, charge: 3.6, recovery: 0,
};

const CATALOG: Record<string, SkillDefinition> = {
  knight_attack: ATTACK,
  bash: active('bash'),
  sunder: active('sunder'),
  intercept: active('intercept', { charge: 0, recovery: 1.8, trigger: 'ally_targeted' }),
};

function setup(loadout: object, skills: Record<string, SkillDefinition> = CATALOG, serverCatalog = true) {
  document.body.innerHTML = '<div id="charitems"></div>';
  const listeners = new Set<StateListener>();
  const makeState = (next: object): ServerStateMessage => ({
    username: 'me',
    character: {
      className: 'Knight', level: 10, xp: 0, xpForNextLevel: 100, gold: 0, baseDamage: 1, maxHp: 20, inventory: {},
      equipment: { mainhand: null, offhand: null }, skillLoadout: next, xpRate: { startTime: 0, totalXp: 0 },
    },
    itemDefinitions: {},
    setDefinitions: {},
    social: { mailbox: [], proposedTrades: [] },
  } as unknown as ServerStateMessage);
  let lastState = makeState(loadout);
  const sendSetActionOrder = vi.fn();
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onEquipBlocked: () => () => {},
    onBestiary: () => () => {},
    requestBestiary: vi.fn(),
    sendEquipSkill: vi.fn(),
    sendSetActionOrder,
  } as unknown as GameClient;
  const worldCache = {
    getSkillContent: () => ({ skills }),
    getSlotSchedule: () => [{ type: 'active', unlocksAtLevel: 1 }, { type: 'active', unlocksAtLevel: 1 }, { type: 'active', unlocksAtLevel: 1 }],
    getSkill: (id: string) => skills[id] ?? null,
    hasServerSkillCatalog: () => serverCatalog,
    contentGeneration: 0,
  } as unknown as WorldCache;
  new CharItemsScreen('charitems', gameClient, worldCache).onActivate();
  const push = (next: object) => {
    lastState = makeState(next);
    for (const l of listeners) l(lastState);
  };
  return { sendSetActionOrder, push };
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.hero-priority-row')];
const names = () => rows().map(r => r.querySelector('.hero-priority-name')!.textContent);
const moveBtn = (index: number, dir: 'up' | 'down') => rows()[index].querySelector<HTMLButtonElement>(`[data-priority-move="${dir}"]`)!;

describe('Hero Attack card', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows Attack as always on, with its timing, and tapping it opens no picker', () => {
    setup({ equippedSkills: [null, null, null], unlockedSkills: ['knight_attack'] });
    const card = document.querySelector<HTMLElement>('.charitems-skill-slot.attack')!;
    expect(card.textContent).toContain('Always on');
    expect(card.textContent).toContain('Charge 3.6s');
    expect(card.textContent).toContain('Recovery 0s');
    expect(card.dataset.slotIndex).toBeUndefined();
    expect(card.getAttribute('role')).toBeNull();
    card.click();
    expect(document.querySelector('.charitems-skill-popup')).toBeNull();
  });

  it('never offers Attack in a skill slot\'s picker, even when listed as unlocked', () => {
    setup({ equippedSkills: [null, null, null], unlockedSkills: ['knight_attack', 'bash'] });
    document.querySelector<HTMLElement>('.charitems-skill-slot[data-slot-index="0"]')!.click();
    const offered = [...document.querySelectorAll<HTMLElement>('.charitems-skill-row')].map(r => r.dataset.skillId);
    expect(offered).toContain('bash');
    expect(offered).not.toContain('knight_attack');
  });

  it('shows no Attack card for content without one', () => {
    const { knight_attack: _attack, ...legacy } = CATALOG;
    setup({ equippedSkills: ['bash', null, null] }, legacy);
    expect(document.querySelector('.charitems-skill-slot.attack')).toBeNull();
  });

  it('shows no Attack card for an attack skill the engine ignores, with neither charge nor recovery', () => {
    const { charge: _charge, recovery: _recovery, ...untimed } = ATTACK;
    setup({ equippedSkills: ['bash', null, null] }, { ...CATALOG, knight_attack: untimed });
    expect(document.querySelector('.charitems-skill-slot.attack')).toBeNull();
    expect(names()).toEqual([]);
  });
});

describe('Hero priority list', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('defaults to slot order then Attack, and leaves out instants', () => {
    setup({ equippedSkills: ['bash', 'intercept', 'sunder'] });
    expect(names()).toEqual(['BASH', 'SUNDER', 'Attack']);
    expect(document.querySelector('.hero-priority-note')!.textContent).toBe('Instant skills fire on their own. Changes apply from the next fight.');
  });

  it('follows the saved order', () => {
    setup({ equippedSkills: ['bash', null, 'sunder'], actionOrder: ['knight_attack', 'sunder'] });
    expect(names()).toEqual(['Attack', 'SUNDER', 'BASH']);
  });

  it('sends the whole list with the pressed row moved, and the push repaints it', () => {
    const t = setup({ equippedSkills: ['bash', null, 'sunder'] });
    moveBtn(2, 'up').click();
    expect(t.sendSetActionOrder).toHaveBeenCalledWith(['bash', 'knight_attack', 'sunder']);
    expect(names()).toEqual(['BASH', 'SUNDER', 'Attack']);

    t.push({ equippedSkills: ['bash', null, 'sunder'], actionOrder: ['bash', 'knight_attack', 'sunder'] });
    expect(names()).toEqual(['BASH', 'Attack', 'SUNDER']);
    expect(document.activeElement).toBe(moveBtn(1, 'up'));
  });

  it('builds a quick second tap on the first, before the push arrives', () => {
    const t = setup({ equippedSkills: ['bash', null, 'sunder'] });
    moveBtn(2, 'up').click();
    moveBtn(2, 'up').click();
    expect(t.sendSetActionOrder).toHaveBeenLastCalledWith(['knight_attack', 'bash', 'sunder']);
  });

  it('goes back to the server order once a pending order has had time to arrive', () => {
    vi.useFakeTimers();
    try {
      const t = setup({ equippedSkills: ['bash', null, 'sunder'] });
      moveBtn(2, 'up').click();
      vi.advanceTimersByTime(5000);
      moveBtn(2, 'up').click();
      expect(t.sendSetActionOrder).toHaveBeenLastCalledWith(['bash', 'knight_attack', 'sunder']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending order when the equipped skills change', () => {
    const t = setup({ equippedSkills: ['bash', null, 'sunder'] });
    moveBtn(2, 'up').click();
    t.push({ equippedSkills: ['bash', null, null] });
    moveBtn(1, 'up').click();
    expect(t.sendSetActionOrder).toHaveBeenLastCalledWith(['knight_attack', 'bash']);
  });

  it('hides without the server catalog, since an order built from the fallback would be wrong', () => {
    setup({ equippedSkills: ['bash', null, 'sunder'] }, CATALOG, false);
    expect(document.querySelector('.hero-priority')!.textContent!.trim()).toBe('');
  });

  it('disables moves off either end', () => {
    const t = setup({ equippedSkills: ['bash', null, null] });
    expect(moveBtn(0, 'up').disabled).toBe(true);
    expect(moveBtn(1, 'down').disabled).toBe(true);
    moveBtn(0, 'down').click();
    expect(t.sendSetActionOrder).toHaveBeenCalledWith(['knight_attack', 'bash']);
  });

  it('hides with nothing to order', () => {
    setup({ equippedSkills: ['intercept', null, null] });
    expect(document.querySelector('.hero-priority')!.textContent!.trim()).toBe('');
  });

  it('orders actives alone on content with no Attack to place', () => {
    const { knight_attack: _attack, ...legacy } = CATALOG;
    setup({ equippedSkills: ['bash', null, 'sunder'], actionOrder: ['sunder'] }, legacy);
    expect(names()).toEqual(['SUNDER', 'BASH']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamePartyMember, QuestStepInfo, RoomLockInfo } from '@idle-party-rpg/shared';
import { LOCK_OPEN_NOW_TEXT, LOCK_SPOILER_TEXT, NO_WAY_YET_TEXT, lockCardAction, lockCardTitle, renderLockCard, showLockDialog } from '../src/ui/LockCard';
import type { LockCardContext } from '../src/ui/LockCard';
import { dismissTop } from '../src/ui/ModalStack';

const member = (username: string, role: GamePartyMember['role']): GamePartyMember => ({ username, role, gridPosition: 0 } as GamePartyMember);

function context(overrides: Partial<LockCardContext> = {}): LockCardContext {
  return { viewer: 'ana', humans: [member('ana', 'owner')], viewerLevel: 4, canMove: true, ...overrides };
}

const step = (overrides: Partial<QuestStepInfo> = {}): QuestStepInfo => ({
  questId: 'q_lantern', questName: 'Light the Lantern', state: 'available', remaining: 1,
  giver: { npcName: 'Mossy Ida', roomId: 'r-mill', mapId: 'm-vale', mapName: 'Vale', roomName: 'Old Mill', zoneName: 'Reedlands' },
  ...overrides,
});

const questLock = (nextStep?: QuestStepInfo, questLevel?: number): RoomLockInfo => ({
  roomId: 'r-gate',
  requirements: [{
    kind: 'quest', questId: 'q_gate', questName: 'Open the Floodgate', ...(questLevel !== undefined ? { questLevel } : {}),
    members: [{ username: 'ana', met: false, ...(nextStep ? { nextStep } : {}) }],
  }],
});

function render(lock: RoomLockInfo, ctx = context()): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderLockCard(lock, ctx);
  return host;
}

const texts = (host: HTMLElement, selector: string) => [...host.querySelectorAll(selector)].map(el => el.textContent);
const actions = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-lock-action]')].map(el => el.textContent);

describe('renderLockCard', () => {
  it('speaks to a lone player about each requirement', () => {
    const host = render({
      roomId: 'r-gate',
      requirements: [
        { kind: 'item', itemName: 'Brass Key', members: [{ username: 'ana', met: false }] },
        { kind: 'level', minLevel: 9, members: [{ username: 'ana', met: false, level: 4 }] },
        { kind: 'quest', questId: 'q_gate', questName: 'Open the Floodgate', members: [{ username: 'ana', met: false }] },
      ],
    });
    expect(texts(host, '.lock-card-title')).toEqual(['🔒 Locked']);
    expect(texts(host, '.lock-card-need-text')).toEqual([
      'You need Brass Key equipped',
      "You need level 9 (you're level 4)",
      'You need to complete "Open the Floodgate"',
    ]);
    expect(host.querySelector('.lock-card-members')).toBeNull();
  });

  it('gives a party a tick or a cross for each member, with their level and next step', () => {
    const humans = [member('ana', 'owner'), member('bo', 'member'), member('cy', 'member')];
    const host = render({
      roomId: 'r-gate',
      requirements: [
        { kind: 'level', minLevel: 9, members: [{ username: 'ana', met: true, level: 9 }, { username: 'bo', met: false, level: 5 }, { username: 'cy', met: true, level: 12 }] },
        {
          kind: 'quest', questId: 'q_gate', questName: 'Open the Floodgate',
          members: [{ username: 'ana', met: true }, { username: 'bo', met: true }, { username: 'cy', met: false, nextStep: step() }],
        },
      ],
    }, context({ humans }));
    expect(texts(host, '.lock-card-need-text')).toEqual(['Needs level 9', 'Needs "Open the Floodgate" completed']);
    expect(texts(host, '.lock-card-member')).toEqual([
      '✓You', '✗bolevel 5', '✓cy',
      '✓You', '✓bo', '✗cynext: Light the Lantern',
    ]);
    expect(host.querySelector('.lock-card-step')).toBeNull();
  });

  it('shows the viewer\'s next step and where it is given', () => {
    const host = render(questLock(step({ remaining: 3 })));
    expect(texts(host, '.lock-card-step-line')).toEqual(['Your next step: Light the Lantern · Mossy Ida, Old Mill, Vale']);
    expect(texts(host, '.lock-card-step-note')).toEqual(['3 quests to go']);
    expect(actions(host)).toEqual(['Walk there', 'Show on map']);
  });

  it('names the zone when the viewer hasn\'t found the giver\'s room', () => {
    const giver = { npcName: 'Mossy Ida', roomId: 'r-mill', mapId: 'm-vale', mapName: 'Vale', zoneName: 'Reedlands' };
    expect(texts(render(questLock(step({ giver }))), '.lock-card-step-place')).toEqual([' · Mossy Ida, Reedlands, Vale']);
  });

  it('offers Walk there for a giver on any map, but only to a player who can move the party', () => {
    const elsewhere = step({ giver: { npcName: 'Mossy Ida', roomId: 'r-far', mapId: 'm-other', mapName: 'Far Isle' } });
    expect(actions(render(questLock(elsewhere)))).toEqual(['Walk there', 'Show on map']);
    expect(actions(render(questLock(elsewhere), context({ canMove: false })))).toEqual(['Show on map']);
  });

  it('offers the Quest Log for an active step and says how far a level-locked one is', () => {
    expect(actions(render(questLock(step({ state: 'active', giver: undefined }))))).toEqual(['Quest Log']);
    expect(texts(render(questLock(step({ state: 'active', giver: undefined }))), '.lock-card-step-note')).toEqual(["It's in your Quest Log."]);

    const levelLocked = render(questLock(step({ state: 'needs_level', requiredLevel: 7 })));
    expect(texts(levelLocked, '.lock-card-step-note')).toEqual(['Reach level 7 to take it.']);
    expect(actions(levelLocked)).toEqual(['Show on map']);

    expect(texts(render(questLock(step({ state: 'unavailable', giver: undefined }))), '.lock-card-step-note')).toEqual(['No one offers it yet.']);
  });

  it('keeps a gate quest ten or more levels above the viewer unnamed, and still shows the next step', () => {
    const near = render(questLock(step(), 13), context({ viewerLevel: 4 }));
    expect(texts(near, '.lock-card-need-text')).toEqual(['You need to complete "Open the Floodgate"']);

    const far = render(questLock(step(), 14), context({ viewerLevel: 4 }));
    expect(texts(far, '.lock-card-need-text')).toEqual([LOCK_SPOILER_TEXT]);
    expect(far.textContent).not.toContain('Open the Floodgate');
    expect(texts(far, '.lock-card-step-line')).toEqual(['Your next step: Light the Lantern · Mossy Ida, Old Mill, Vale']);

    const gateItself = step({ questId: 'q_gate', questName: 'Open the Floodgate', state: 'needs_level', requiredLevel: 14 });
    const hidden = render(questLock(gateItself, 14), context({ viewerLevel: 4 }));
    expect(hidden.textContent).not.toContain('Open the Floodgate');
    expect(texts(hidden, '.lock-card-step-quest')).toEqual(['Reach level 14']);
  });

  it('drops the main-story prefix from quest names', () => {
    const host = render({ ...questLock(), requirements: [{ ...questLock().requirements[0], questName: 'Progress: Open the Floodgate' }] });
    expect(texts(host, '.lock-card-need-text')).toEqual(['You need to complete "Open the Floodgate"']);
  });

  it('offers to remove only the missing members the viewer may kick', () => {
    const humans = [member('ana', 'leader'), member('bo', 'owner'), member('cy', 'member'), member('dee', 'member')];
    const lock: RoomLockInfo = {
      roomId: 'r-gate',
      requirements: [{
        kind: 'level', minLevel: 9,
        members: [{ username: 'ana', met: false }, { username: 'bo', met: false }, { username: 'cy', met: false }, { username: 'dee', met: true }],
      }],
    };
    expect(actions(render(lock, context({ humans })))).toEqual(['Remove cy from the party']);
    expect(actions(render(lock, context({ humans, viewer: 'cy' })))).toEqual([]);
    expect(actions(render(lock, context({ humans, viewer: 'bo' })))).toEqual(['Remove ana from the party', 'Remove cy from the party']);
  });

  it('escapes what content and players named', () => {
    const host = render({ roomId: 'r', requirements: [{ kind: 'item', itemName: '<b>Key</b>', members: [{ username: 'ana', met: false }] }] });
    expect(host.querySelector('b')).toBeNull();
    expect(texts(host, '.lock-card-need-text')).toEqual(['You need <b>Key</b> equipped']);
  });
});

describe('lockCardTitle', () => {
  it('says what is locked: the room, a room on the way, a door on the way, or no way at all', () => {
    const base: RoomLockInfo = { roomId: 'r', requirements: [] };
    expect(lockCardTitle(base)).toBe('🔒 Locked');
    expect(lockCardTitle({ ...base, onRoute: true, roomName: 'Old Gate' })).toBe('🔒 The way there passes Old Gate, which is locked');
    expect(lockCardTitle({ ...base, onRoute: true })).toBe('🔒 The way there passes a locked room');
    expect(lockCardTitle({ ...base, onRoute: true, door: true, roomName: 'Cellar' })).toBe('🔒 The way there passes a locked door in Cellar');
    expect(lockCardTitle({ ...base, door: true })).toBe('🔒 Locked');
    expect(lockCardTitle({ ...base, unreachable: true })).toBe(NO_WAY_YET_TEXT);
  });
});

describe('lockCardAction', () => {
  it('reads the button a click landed on', () => {
    const host = render(questLock(step()));
    const walk = host.querySelector('[data-lock-action="walk"]')!;
    expect(lockCardAction(walk)).toEqual({ kind: 'walk', roomId: 'r-mill' });
    expect(lockCardAction(host.querySelector('.lock-card-title'))).toBeNull();
    expect(lockCardAction(null)).toBeNull();
  });
});

describe('showLockDialog', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { while (dismissTop()) { /* drain */ } });

  it('shows the client\'s lines until the card arrives, and stays until closed', () => {
    const onAction = vi.fn();
    const dialog = showLockDialog({ title: 'Travel to Far Isle', lines: ["Needs level 9 (you're level 4)"], context: () => context(), onAction });
    expect(document.querySelector('.lock-dialog .confirm-title')!.textContent).toBe('Travel to Far Isle');
    expect(texts(document.body, '.lock-card-need-text')).toEqual(["Needs level 9 (you're level 4)"]);

    dialog.setLock(questLock(step()));
    expect(texts(document.body, '.lock-card-need-text')).toEqual(['You need to complete "Open the Floodgate"']);
    document.querySelector<HTMLElement>('[data-lock-action="show"]')!.click();
    expect(onAction).toHaveBeenCalledWith({ kind: 'show', roomId: 'r-mill' });
    expect(dialog.isOpen).toBe(true);

    expect(dismissTop()).toBe(true);
    expect(dialog.isOpen).toBe(false);
    expect(document.querySelector('.lock-dialog')).toBeNull();
  });

  it('offers to travel when the server finds nothing in the way', () => {
    const onOpen = vi.fn();
    const dialog = showLockDialog({ title: 'Travel', lines: [], context: () => context(), onAction: vi.fn(), onOpen });
    dialog.setLock(null);
    expect(document.querySelector('.lock-card-title')!.textContent).toBe(LOCK_OPEN_NOW_TEXT);
    document.querySelector<HTMLElement>('.lock-dialog-travel')!.click();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(dialog.isOpen).toBe(false);
  });
});

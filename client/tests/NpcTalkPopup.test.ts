import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompletedQuestEntry,
  NpcDefinition,
  QuestDefinition,
  QuestProgressEntry,
  ServerErrorCode,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { SOLO_QUEST_IN_PARTY_REASON } from '@idle-party-rpg/shared';
import {
  NO_REPLY_NOTICE,
  NPC_NOTICE_MS,
  NpcTalkPopup,
  QUEST_REPLY_TIMEOUT_MS,
} from '../src/ui/NpcTalkPopup';
import { OFFLINE_NOTICE, type GameClient, type ServerErrorDetail } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: ServerErrorCode, detail?: ServerErrorDetail) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
const GIVER: NpcDefinition = { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Well met.', questIds: ['q1', 'q2', 'q3'] };

function quest(id: string, overrides: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id,
    name: `Quest ${id}`,
    description: `About ${id}`,
    scope: 'party',
    objectives: [{ kind: 'kill', monsterId: 'm-goblin', count: 3 }],
    rewards: [{ kind: 'gold', amount: 10 }],
    ...overrides,
  };
}

function active(questId: string, status: QuestProgressEntry['status'], progress: number[]): QuestProgressEntry {
  return { questId, status, progress, acceptedAt: '2026-01-01T00:00:00.000Z' };
}

interface StateParts {
  activeQuests?: QuestProgressEntry[];
  completedQuests?: CompletedQuestEntry[];
  weeklyCompletions?: Record<string, string>;
  questDefinitions?: Record<string, QuestDefinition>;
  offeredQuestIds?: string[];
  /** Defaults to the shown NPC; null for a room without one. */
  questGiverNpcId?: string | null;
  partyMembers?: number;
  level?: number;
  combatRound?: number;
}

function makeState(parts: StateParts): ServerStateMessage {
  const members = Array.from({ length: parts.partyMembers ?? 0 }, (_, i) => ({ username: `p${i}`, role: 'member' }));
  return {
    character: { level: parts.level ?? 5 },
    battle: { round: parts.combatRound ?? 0 },
    activeQuests: parts.activeQuests ?? [],
    completedQuests: parts.completedQuests ?? [],
    weeklyCompletions: parts.weeklyCompletions ?? {},
    questDefinitions: parts.questDefinitions ?? {},
    offeredQuestIds: parts.offeredQuestIds ?? [],
    questGiverNpcId: parts.questGiverNpcId === null ? undefined : parts.questGiverNpcId ?? GIVER.id,
    questResolutions: { monsters: { 'm-goblin': 'Goblin' }, items: {}, tiles: {} },
    social: members.length > 0 ? { party: { members } } : undefined,
  } as unknown as ServerStateMessage;
}

function setup(initial: StateParts) {
  const stateListeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState = makeState(initial);
  const sendAcceptQuest = vi.fn((_questId: string) => true);
  const sendTurnInQuest = vi.fn((_questId: string) => true);

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    sendAcceptQuest,
    sendTurnInQuest,
  } as unknown as GameClient;

  const push = (parts: StateParts) => {
    lastState = makeState(parts);
    for (const l of [...stateListeners]) l(lastState);
  };
  const serverError = (message: string, code?: ServerErrorCode, detail?: ServerErrorDetail) => {
    for (const l of [...errorListeners]) l(message, code, detail);
  };

  const popup = new NpcTalkPopup(gameClient);
  return {
    popup,
    push,
    serverError,
    sendAcceptQuest,
    sendTurnInQuest,
    listenerCount: () => stateListeners.size + errorListeners.size,
  };
}

const overlay = () => document.querySelector('.npc-talk-overlay') as HTMLElement;
const acceptButton = (id: string) => document.querySelector<HTMLButtonElement>(`[data-action="accept"][data-quest-id="${id}"]`);
const turnInButton = (id: string) => document.querySelector<HTMLButtonElement>(`[data-action="turnin"][data-quest-id="${id}"]`);
const card = (id: string) => document.querySelector<HTMLElement>(`.quest-card[data-quest-id="${id}"]`);
const noticeText = () => document.querySelector('.npc-talk-notice')!.textContent ?? '';
const isOpen = () => overlay().style.display !== 'none';

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

/** A full press, plus the macrotask after the click in which held repaints flush. */
function tap(target: HTMLElement): void {
  press(target);
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  target.click();
  vi.advanceTimersByTime(0);
}

function isBusy(button: HTMLButtonElement | null): boolean {
  return button?.getAttribute('aria-disabled') === 'true' && button.classList.contains('npc-talk-btn-busy');
}

describe('NpcTalkPopup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('splits the giver\'s quests into Ready, In Progress and Available', () => {
    const t = setup({
      offeredQuestIds: ['q1', 'q2', 'q3'],
      activeQuests: [active('q2', 'in_progress', [1]), active('q3', 'ready', [3])],
      questDefinitions: { q1: quest('q1'), q2: quest('q2'), q3: quest('q3') },
    });
    t.popup.show(GIVER);

    expect(document.querySelector('.npc-talk-name')!.textContent).toBe('Mara');
    expect(document.querySelector('.npc-talk-greeting')!.textContent).toBe('"Well met."');
    expect(document.querySelector('.npc-quest-ready')!.textContent).toContain('Ready to Turn In');
    expect(turnInButton('q3')!.textContent).toBe('Turn In');
    expect(document.querySelector('.npc-quest-progress')!.textContent).toContain('Kill Goblin (1/3)');
    expect(acceptButton('q1')!.textContent).toBe('Accept');
    expect(noticeText()).toBe('');
  });

  it('keeps the same Accept button across combat pushes and progress on another quest', () => {
    const parts: StateParts = {
      offeredQuestIds: ['q1', 'q2'],
      activeQuests: [active('q2', 'in_progress', [1])],
      questDefinitions: { q1: quest('q1'), q2: quest('q2') },
    };
    const t = setup(parts);
    t.popup.show(GIVER);
    const button = acceptButton('q1');

    t.push({ ...parts, combatRound: 7 });
    expect(acceptButton('q1')).toBe(button);

    t.push({ ...parts, activeQuests: [active('q2', 'in_progress', [2])] });
    expect(document.querySelector('.npc-quest-progress')!.textContent).toContain('Kill Goblin (2/3)');
    expect(acceptButton('q1')).toBe(button);
  });

  it('holds a repaint while Accept is pressed so the click lands, then applies it', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    const button = acceptButton('q1')!;

    press(button);
    t.push({ offeredQuestIds: ['q1', 'q2'], questDefinitions: { q1: quest('q1'), q2: quest('q2') } });
    expect(button.isConnected).toBe(true);
    expect(acceptButton('q2')).toBeNull();

    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    button.click();
    expect(t.sendAcceptQuest).toHaveBeenCalledTimes(1);
    expect(t.sendAcceptQuest).toHaveBeenCalledWith('q1');

    vi.advanceTimersByTime(0);
    expect(acceptButton('q2')!.textContent).toBe('Accept');
    expect(isBusy(acceptButton('q1'))).toBe(true);
  });

  it('applies a held repaint once a press elsewhere in the popup is released', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    const greeting = document.querySelector('.npc-talk-greeting') as HTMLElement;

    press(greeting);
    t.push({ offeredQuestIds: ['q1', 'q2'], questDefinitions: { q1: quest('q1'), q2: quest('q2') } });
    expect(acceptButton('q2')).toBeNull();

    greeting.click();
    vi.advanceTimersByTime(0);
    expect(acceptButton('q2')).not.toBeNull();
    expect(isOpen()).toBe(true);
  });

  it('sends Accept once and shows it busy until the quest turns up as active', () => {
    const parts: StateParts = { offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } };
    const t = setup(parts);
    t.popup.show(GIVER);

    tap(acceptButton('q1')!);
    const busy = acceptButton('q1');
    expect(isBusy(busy)).toBe(true);
    expect(busy!.textContent).toBe('Accepting…');
    expect(busy!.hasAttribute('disabled')).toBe(false);

    tap(busy!);
    expect(t.sendAcceptQuest).toHaveBeenCalledTimes(1);

    t.push({ ...parts, activeQuests: [active('q1', 'accepted', [0])] });
    expect(acceptButton('q1')).toBeNull();
    expect(card('q1')!.closest('.npc-quest-progress')).not.toBeNull();

    vi.advanceTimersByTime(QUEST_REPLY_TIMEOUT_MS);
    expect(noticeText()).toBe('');
  });

  it('shows a refusal for the pending quest and lets the player try again', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);

    tap(acceptButton('q1')!);
    t.serverError("That quest isn't offered in this room.", 'quest_refused', { questId: 'q1' });

    expect(noticeText()).toBe("That quest isn't offered in this room.");
    expect(isBusy(acceptButton('q1'))).toBe(false);
    expect(acceptButton('q1')!.textContent).toBe('Accept');

    tap(acceptButton('q1')!);
    expect(t.sendAcceptQuest).toHaveBeenCalledTimes(2);
    expect(noticeText()).toBe('');
  });

  it('ignores errors that are not a refusal of a pending quest', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    t.serverError('Too early.', 'quest_refused', { questId: 'q1' });
    expect(noticeText()).toBe('');

    tap(acceptButton('q1')!);
    t.serverError('Other quest.', 'quest_refused', { questId: 'q2' });
    t.serverError('No code.', undefined, { questId: 'q1' });
    t.serverError('Trade.', 'trade_nonce_mismatch', { questId: 'q1' });
    t.serverError('No detail.', 'quest_refused');

    expect(noticeText()).toBe('');
    expect(isBusy(acceptButton('q1'))).toBe(true);
  });

  it('says so when the click could not be sent, without going busy', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.sendAcceptQuest.mockReturnValue(false);
    t.popup.show(GIVER);

    tap(acceptButton('q1')!);
    expect(noticeText()).toBe(OFFLINE_NOTICE);
    expect(isBusy(acceptButton('q1'))).toBe(false);

    vi.advanceTimersByTime(NPC_NOTICE_MS);
    expect(noticeText()).toBe('');
  });

  it('gives up waiting after the reply timeout', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);

    tap(acceptButton('q1')!);
    vi.advanceTimersByTime(QUEST_REPLY_TIMEOUT_MS - 1);
    expect(isBusy(acceptButton('q1'))).toBe(true);
    expect(noticeText()).toBe('');

    vi.advanceTimersByTime(1);
    expect(noticeText()).toBe(NO_REPLY_NOTICE);
    expect(isBusy(acceptButton('q1'))).toBe(false);
  });

  it('turns in once, then shows the completion speech until dismissed', () => {
    const def = quest('q3', { completionText: 'You have my thanks.' });
    const t = setup({ offeredQuestIds: ['q3'], activeQuests: [active('q3', 'ready', [3])], questDefinitions: { q3: def } });
    t.popup.show(GIVER);

    tap(turnInButton('q3')!);
    expect(turnInButton('q3')!.textContent).toBe('Turning in…');
    tap(turnInButton('q3')!);
    expect(t.sendTurnInQuest).toHaveBeenCalledTimes(1);
    expect(t.sendTurnInQuest).toHaveBeenCalledWith('q3');

    t.push({
      offeredQuestIds: ['q3'],
      completedQuests: [{ questId: 'q3', completedAt: new Date().toISOString() }],
      questDefinitions: { q3: def },
    });
    expect(turnInButton('q3')).toBeNull();
    const speech = document.querySelector('.npc-talk-completion')!;
    expect(speech.textContent).toContain('Quest complete: Quest q3');
    expect(speech.textContent).toContain('"You have my thanks."');

    tap(speech.querySelector('[data-action="dismiss-completion"]') as HTMLElement);
    expect(document.querySelector('.npc-talk-completion')).toBeNull();
    expect(isOpen()).toBe(true);
  });

  it('shows a turn-in refusal and re-enables Turn In', () => {
    const t = setup({ offeredQuestIds: ['q3'], activeQuests: [active('q3', 'ready', [3])], questDefinitions: { q3: quest('q3') } });
    t.popup.show(GIVER);

    tap(turnInButton('q3')!);
    t.serverError('Your bags are full.', 'quest_refused', { questId: 'q3' });
    expect(noticeText()).toBe('Your bags are full.');
    expect(turnInButton('q3')!.textContent).toBe('Turn In');
  });

  it('lists a solo quest with the reason in place of Accept while in a party', () => {
    const parts: StateParts = { offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1', { scope: 'solo' }) } };
    const t = setup({ ...parts, partyMembers: 2 });
    t.popup.show(GIVER);

    expect(card('q1')).not.toBeNull();
    expect(acceptButton('q1')).toBeNull();
    expect(card('q1')!.querySelector('.quest-card-blocked')!.textContent).toBe(SOLO_QUEST_IN_PARTY_REASON);

    t.push({ ...parts, partyMembers: 1 });
    expect(acceptButton('q1')).not.toBeNull();
    expect(card('q1')!.querySelector('.quest-card-blocked')).toBeNull();

    t.push(parts);
    expect(acceptButton('q1')).not.toBeNull();
  });

  it('still hides quests blocked for other reasons', () => {
    const t = setup({
      offeredQuestIds: ['q1', 'q2'],
      completedQuests: [{ questId: 'q2', completedAt: '2026-01-01T00:00:00.000Z' }],
      questDefinitions: { q1: quest('q1', { requiredLevel: 10 }), q2: quest('q2') },
      level: 5,
    });
    t.popup.show(GIVER);
    expect(card('q1')).toBeNull();
    expect(card('q2')).toBeNull();
    expect(document.querySelector('.npc-quest-section-empty')!.textContent).toBe('Nothing for you right now.');
  });

  it('says the NPC is no longer nearby and drops the buttons when the party moves on', () => {
    const parts: StateParts = {
      offeredQuestIds: ['q1', 'q3'],
      activeQuests: [active('q3', 'ready', [3])],
      questDefinitions: { q1: quest('q1'), q3: quest('q3') },
    };
    const t = setup(parts);
    t.popup.show(GIVER);

    t.push({ ...parts, questGiverNpcId: 'hermit' });
    expect(isOpen()).toBe(true);
    expect(noticeText()).toBe('Mara is no longer nearby.');
    expect(document.querySelector('[data-action="accept"], [data-action="turnin"]')).toBeNull();
    expect(document.querySelector('.quest-card')).toBeNull();

    t.push({ ...parts, questGiverNpcId: null });
    expect(noticeText()).toBe('Mara is no longer nearby.');

    t.push(parts);
    expect(noticeText()).toBe('');
    expect(acceptButton('q1')).not.toBeNull();
    expect(turnInButton('q3')).not.toBeNull();
  });

  it('closes on the backdrop only when the press started there too', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);

    press(document.querySelector('.npc-talk-greeting')!);
    overlay().click();
    expect(isOpen()).toBe(true);

    overlay().click();
    expect(isOpen()).toBe(true);

    tap(overlay());
    expect(isOpen()).toBe(false);
  });

  it('closes from the Close button and skips a repaint held from before', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    const close = document.querySelector('.npc-talk-close') as HTMLElement;

    press(close);
    t.push({ offeredQuestIds: ['q1', 'q2'], questDefinitions: { q1: quest('q1'), q2: quest('q2') } });
    close.click();
    vi.advanceTimersByTime(0);

    expect(isOpen()).toBe(false);
    expect(document.querySelector('.quest-card')).toBeNull();
  });

  it('renders again when reopened with the same state', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    t.popup.hide();
    expect(document.querySelector('.npc-talk-name')).toBeNull();

    t.popup.show(GIVER);
    expect(document.querySelector('.npc-talk-name')!.textContent).toBe('Mara');
    expect(acceptButton('q1')).not.toBeNull();
  });

  it('forgets pending requests and notices when hidden', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    tap(acceptButton('q1')!);
    t.popup.hide();

    t.popup.show(GIVER);
    expect(isBusy(acceptButton('q1'))).toBe(false);
    vi.advanceTimersByTime(QUEST_REPLY_TIMEOUT_MS);
    expect(noticeText()).toBe('');
  });

  it('joins the modal stack and unsubscribes on hide', () => {
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1') } });
    t.popup.show(GIVER);
    t.popup.show(GIVER);
    expect(t.listenerCount()).toBe(2);
    expect(Number(overlay().style.zIndex)).toBeGreaterThanOrEqual(1500);

    t.popup.hide();
    expect(t.listenerCount()).toBe(0);
    expect(overlay().style.zIndex).toBe('');
  });

  it('escapes author-supplied text', () => {
    const npc: NpcDefinition = { ...GIVER, name: '<b>Mara</b>', greeting: '<img src=x>' };
    const t = setup({ offeredQuestIds: ['q1'], questDefinitions: { q1: quest('q1', { name: '<img src=y>' }) } });
    t.popup.show(npc);
    expect(document.querySelector('.npc-talk-modal img')).toBeNull();
    expect(document.querySelector('.npc-talk-name')!.textContent).toBe('<b>Mara</b>');
    expect(card('q1')!.querySelector('.quest-card-name')!.textContent).toBe('<img src=y>');
  });
});

describe('NpcTalkPopup weekly cooldown', () => {
  const giver: NpcDefinition = { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Hi', questIds: ['q-weekly'] };
  const weekly = quest('q-weekly', { repeat: 'weekly' });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function showWithLastCompletion(daysAgo: number): void {
    const completedAt = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    const t = setup({
      completedQuests: [{ questId: 'q-weekly', completedAt }],
      weeklyCompletions: { 'q-weekly': completedAt },
      questDefinitions: { 'q-weekly': weekly },
      offeredQuestIds: ['q-weekly'],
    });
    t.popup.show(giver);
  }

  it('does not offer a weekly quest that is still on cooldown', () => {
    showWithLastCompletion(2);
    expect(acceptButton('q-weekly')).toBeNull();
  });

  it('offers it again once the week has passed', () => {
    showWithLastCompletion(8);
    expect(acceptButton('q-weekly')).not.toBeNull();
  });

  it('follows the server cooldown, not the history, for a quest finished before it became weekly', () => {
    const t = setup({
      completedQuests: [{ questId: 'q-weekly', completedAt: new Date(Date.now() - DAY_MS).toISOString() }],
      weeklyCompletions: {},
      questDefinitions: { 'q-weekly': weekly },
      offeredQuestIds: ['q-weekly'],
    });
    t.popup.show(giver);
    expect(acceptButton('q-weekly')).not.toBeNull();
  });
});

describe('quest and NPC popup font sizes', () => {
  const OWNED_SELECTOR = /\.(npc-talk|npc-quest|quest-card|quest-pill|quest-objective|quest-log)/;
  const SMALLEST_TOKEN_PX = 11;

  it('never set quest or NPC text below the smallest font token', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/pixel-theme.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const tooSmall: string[] = [];
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!OWNED_SELECTOR.test(selector)) continue;
      for (const [, size] of body.matchAll(/font-size:\s*([\d.]+)px/g)) {
        if (Number(size) < SMALLEST_TOKEN_PX) tooSmall.push(`${selector.trim()} ${size}px`);
      }
    }
    expect(tooSmall).toEqual([]);
  });
});

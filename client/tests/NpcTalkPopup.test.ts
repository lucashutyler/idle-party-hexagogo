import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpcDefinition, QuestDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { NpcTalkPopup } from '../src/ui/NpcTalkPopup';
import type { GameClient } from '../src/network/GameClient';

const QUEST: QuestDefinition = {
  id: 'pelts',
  name: 'Pelts for the Tanner',
  description: 'Bring me some pelts.',
  scope: 'solo',
  objectives: [{ kind: 'collect', itemId: 'mangy_pelt', count: 3 }],
  rewards: [{ kind: 'gold', amount: 50 }],
};

const NPC: NpcDefinition = { id: 'healer', name: 'Healer', emoji: '🧙', greeting: 'Hello.', questIds: ['pelts'] };

function makeState(): ServerStateMessage {
  return {
    offeredQuestIds: ['pelts'],
    questDefinitions: { pelts: QUEST },
    activeQuests: [],
    completedQuests: [],
    character: { level: 10 },
  } as unknown as ServerStateMessage;
}

function makeClient() {
  const stateListeners = new Set<(s: ServerStateMessage) => void>();
  const errorListeners = new Set<(m: string) => void>();
  const client = {
    lastState: makeState(),
    subscribe: (fn: (s: ServerStateMessage) => void) => { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    onServerError: (fn: (m: string) => void) => { errorListeners.add(fn); return () => errorListeners.delete(fn); },
    sendAcceptQuest: vi.fn(),
    sendTurnInQuest: vi.fn(),
  };
  return {
    client: client as unknown as GameClient,
    raw: client,
    pushState: () => stateListeners.forEach(fn => fn(client.lastState)),
    pushError: (m: string) => errorListeners.forEach(fn => fn(m)),
  };
}

function overlay(): HTMLElement {
  return document.querySelector('.npc-talk-overlay') as HTMLElement;
}

describe('NpcTalkPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the rendered modal when a state push changes nothing', () => {
    const { client, pushState } = makeClient();
    new NpcTalkPopup(client).show(NPC);
    const modal = overlay().querySelector('.npc-talk-modal');
    pushState();
    expect(overlay().querySelector('.npc-talk-modal')).toBe(modal);
  });

  it('accepts a quest through the delegated click handler, even after a re-render', () => {
    const { client, raw, pushState } = makeClient();
    new NpcTalkPopup(client).show(NPC);
    raw.lastState = { ...makeState(), character: { level: 11 } } as unknown as ServerStateMessage;
    pushState();
    (overlay().querySelector('[data-quest-accept]') as HTMLButtonElement).click();
    expect(raw.sendAcceptQuest).toHaveBeenCalledWith('pelts');
  });

  it('shows a server refusal that follows an accept', () => {
    const { client, pushError } = makeClient();
    new NpcTalkPopup(client).show(NPC);
    (overlay().querySelector('[data-quest-accept]') as HTMLButtonElement).click();
    pushError('Solo quest — leave your party first.');
    expect(overlay().querySelector('.npc-talk-notice')?.textContent).toBe('Solo quest — leave your party first.');
  });

  it('ignores server errors it did not cause', () => {
    const { client, pushError } = makeClient();
    new NpcTalkPopup(client).show(NPC);
    pushError('Something unrelated');
    expect(overlay().querySelector('.npc-talk-notice')).toBeNull();
  });

  it('closes from the Close button and clears its content', () => {
    const { client } = makeClient();
    new NpcTalkPopup(client).show(NPC);
    (overlay().querySelector('.npc-talk-close') as HTMLButtonElement).click();
    expect(overlay().style.display).toBe('none');
    expect(overlay().innerHTML).toBe('');
  });
});

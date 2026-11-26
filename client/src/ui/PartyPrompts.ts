import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml } from './ItemIcon';
import { deferWhilePressed, setHtml } from './render';

export const LEADER_PROMPTS_STORAGE_KEY = 'partyLeaderPromptsAnswered';
const MAX_REMEMBERED = 100;

function promptKey(partyId: string, username: string): string {
  return `${partyId}\n${username}`;
}

function readAnswered(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEADER_PROMPTS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writeAnswered(keys: string[]): void {
  try { localStorage.setItem(LEADER_PROMPTS_STORAGE_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED))); } catch { /* private mode */ }
}

/**
 * Asks a party's owner or a leader, once per joiner, whether a new plain member may move the party too.
 * See docs/architecture/client.md → Party invite cards.
 */
export class PartyPrompts {
  readonly root: HTMLElement;
  private answered = new Set(readAnswered());

  constructor(private gameClient: GameClient) {
    this.root = document.createElement('div');
    this.root.className = 'party-prompts';
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.gameClient.subscribe((state) => {
      deferWhilePressed(this.root, () => this.render(state));
    }, { replay: true });
  }

  private render(state: ServerStateMessage): void {
    const joiner = this.pickJoiner(state);
    if (!joiner) {
      setHtml(this.root, '');
      return;
    }
    const name = escapeHtml(joiner.username);
    setHtml(this.root, `
      <div class="party-invite-card party-prompt-card" role="group" aria-label="${name} joined your party">
        <div class="party-invite-body">
          <span class="party-invite-title"><strong>${name}</strong> joined. Let them move the party too?</span>
          <span class="party-invite-where">Leaders can move the party, invite and remove members.</span>
        </div>
        <div class="party-invite-actions">
          <button type="button" class="party-invite-btn party-prompt-promote" data-party-id="${escapeHtml(joiner.partyId)}" data-username="${name}">Make leader</button>
          <button type="button" class="party-invite-btn party-prompt-dismiss" data-party-id="${escapeHtml(joiner.partyId)}" data-username="${name}">Not now</button>
        </div>
      </div>
    `);
  }

  /** The first plain member this viewer hasn't been asked about. Members seen as leaders count as asked. */
  private pickJoiner(state: ServerStateMessage): { partyId: string; username: string } | null {
    const party = state.social?.party;
    const self = state.username;
    const role = party?.members.find(m => m.username === self)?.role;
    if (!party || (role !== 'owner' && role !== 'leader')) return null;

    for (const m of party.members) {
      if (m.username !== self && m.role !== 'member') this.remember(party.id, m.username);
    }
    const joiner = party.members.find(m => m.role === 'member' && !this.answered.has(promptKey(party.id, m.username)));
    return joiner ? { partyId: party.id, username: joiner.username } : null;
  }

  private remember(partyId: string, username: string): void {
    const key = promptKey(partyId, username);
    if (this.answered.has(key)) return;
    this.answered.add(key);
    const stored = readAnswered().filter(k => k !== key);
    stored.push(key);
    writeAnswered(stored);
  }

  private onClick(e: Event): void {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.party-prompt-promote, .party-prompt-dismiss');
    const partyId = btn?.dataset.partyId;
    const username = btn?.dataset.username;
    if (!btn || !partyId || !username) return;
    if (btn.matches('.party-prompt-promote')) this.gameClient.sendPromotePartyLeader(username);
    this.remember(partyId, username);
    const state = this.gameClient.lastState;
    if (state) this.render(state);
  }
}

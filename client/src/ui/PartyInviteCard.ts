import type { PartyInvite, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml } from './ItemIcon';
import { PartyPrompts } from './PartyPrompts';
import { acceptInviteWithConfirm, inviteWhereText } from './partyInviteActions';
import { deferWhilePressed, setHtml } from './render';

const MAX_CARDS = 2;

/**
 * Pending party invites as cards over every screen, with the party prompts under them.
 * See docs/architecture/client.md → Party invite cards.
 */
export class PartyInviteCard {
  readonly root: HTMLElement;
  private invitesEl: HTMLElement;
  /** Party ids the player put off with Later, for this page only. */
  private later = new Set<string>();
  private onScreen = new Set<string>();

  constructor(private gameClient: GameClient, private openParty: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'party-invite-overlay';
    this.invitesEl = document.createElement('div');
    this.invitesEl.className = 'party-invite-list';
    this.invitesEl.setAttribute('aria-live', 'polite');
    this.invitesEl.setAttribute('aria-relevant', 'additions');
    this.root.append(this.invitesEl, new PartyPrompts(gameClient).root);
    this.invitesEl.addEventListener('click', (e) => this.onClick(e));
    this.gameClient.subscribe((state) => {
      deferWhilePressed(this.invitesEl, () => this.render(state));
    }, { replay: true });
  }

  private render(state: ServerStateMessage): void {
    const invites = state.social?.pendingInvites;
    if (!invites) return;
    const live = new Set(invites.map(i => i.partyId));
    for (const partyId of this.later) {
      if (!live.has(partyId)) this.later.delete(partyId);
    }
    const shown = invites.filter(i => !this.later.has(i.partyId)).sort((a, b) => b.timestamp - a.timestamp);
    const cards = shown.slice(0, MAX_CARDS);
    const more = shown.length - MAX_CARDS;
    const rebuilt = setHtml(this.invitesEl, cards.map(invite => this.cardHtml(invite)).join('')
      + (more > 0 ? `<button type="button" class="party-invite-more">+${more} more</button>` : ''));
    this.invitesEl.querySelectorAll<HTMLElement>('.party-invite-card').forEach((el, i) => {
      const where = el.querySelector('.party-invite-where');
      if (where) where.textContent = inviteWhereText(cards[i]);
      if (rebuilt && !this.onScreen.has(cards[i].partyId)) el.classList.add('party-invite-card-enter');
    });
    this.onScreen = new Set(cards.map(i => i.partyId));
  }

  /** The location line is filled in after, so a party on the move updates its card in place. */
  private cardHtml(invite: PartyInvite): string {
    const inviter = escapeHtml(invite.inviterUsername);
    const partyId = escapeHtml(invite.partyId);
    return `
      <div class="party-invite-card" role="group" aria-label="Party invite from ${inviter}" data-party-id="${partyId}">
        <div class="party-invite-body">
          <span class="party-invite-title"><strong>${inviter}</strong> invited you to their party</span>
          ${inviteWhereText(invite) ? '<span class="party-invite-where"></span>' : ''}
        </div>
        <div class="party-invite-actions">
          <button type="button" class="party-invite-btn party-invite-join" data-party-id="${partyId}">Join</button>
          <button type="button" class="party-invite-btn party-invite-decline" data-party-id="${partyId}">Decline</button>
          <button type="button" class="party-invite-later" data-party-id="${partyId}">Later</button>
        </div>
      </div>
    `;
  }

  private onClick(e: Event): void {
    const btn = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!btn) return;
    if (btn.matches('.party-invite-more')) {
      this.openParty();
      return;
    }
    const partyId = btn.dataset.partyId;
    if (!partyId) return;
    if (btn.matches('.party-invite-join')) {
      void acceptInviteWithConfirm(this.gameClient, partyId, this.gameClient.lastState);
    } else if (btn.matches('.party-invite-decline')) {
      this.gameClient.sendDeclinePartyInvite(partyId);
    } else if (btn.matches('.party-invite-later')) {
      this.later.add(partyId);
      const state = this.gameClient.lastState;
      if (state) this.render(state);
    }
  }
}

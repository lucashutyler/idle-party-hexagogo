import type { GameClient } from '../network/GameClient';
import { navIconHtml, readyQuestCount } from './BottomNav';

export interface UtilityStripActions {
  onOpenChat(): void;
  onOpenQuests(): void;
}

function countText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Phone row above the nav: the chat slot and the Quests button. CSS hides it while chat is open and on the desktop grid. */
export class UtilityStrip {
  private questBadge: HTMLElement;
  private chatCount: HTMLElement;
  private questButton: HTMLElement;
  private chatButton: HTMLElement;

  constructor(gameClient: GameClient, actions: UtilityStripActions) {
    const container = document.getElementById('utility-strip')!;
    container.innerHTML = `
      <div id="chat-strip-slot">
        <button type="button" class="chat-strip-open" aria-label="Open chat">
          <span class="chat-strip-open-icon" aria-hidden="true">💬</span>
          <span class="chat-strip-open-label">Chat</span>
          <span class="chat-strip-open-count"></span>
        </button>
      </div>
      <button type="button" class="utility-quests" aria-label="Quests">
        <span class="nav-icon">${navIconHtml('quests', 'Quests', '📜')}</span>
        <span class="utility-quests-badge"></span>
      </button>
    `;
    this.questBadge = container.querySelector('.utility-quests-badge')!;
    this.chatCount = container.querySelector('.chat-strip-open-count')!;
    this.questButton = container.querySelector('.utility-quests')!;
    this.chatButton = container.querySelector('.chat-strip-open')!;
    this.chatButton.addEventListener('click', () => actions.onOpenChat());
    this.questButton.addEventListener('click', () => actions.onOpenQuests());

    gameClient.subscribe((state) => {
      const ready = readyQuestCount(state.activeQuests);
      this.questBadge.textContent = ready > 0 ? countText(ready) : '';
      this.questBadge.classList.toggle('visible', ready > 0);
      this.questButton.setAttribute('aria-label', ready > 0 ? `Quests, ${countText(ready)} ready` : 'Quests');
    }, { replay: true });
  }

  setChatUnread(count: number): void {
    this.chatCount.textContent = count > 0 ? countText(count) : '';
    this.chatCount.classList.toggle('visible', count > 0);
    this.chatButton.setAttribute('aria-label', count > 0 ? `Open chat, ${countText(count)} unread` : 'Open chat');
  }
}

import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { countText } from './countText';
import { questOfferedHere } from './QuestLogModel';
import { isTravelling } from './routeSummary';

export const NEW_QUEST_HERE_TEXT = 'new quest here';

export interface NavTabConfig {
  id: string;
  label: string;
  glyph: string;
  /** Shown only on the desktop rail. */
  railOnly?: boolean;
}

/** Nav art is content (/nav-icons/{id}.png); the glyph shows until, or unless, it loads. */
export function navIconHtml(id: string, label: string, glyph: string): string {
  return `<span class="nav-icon-glyph" aria-hidden="true">${glyph}</span>`
    + `<img class="nav-icon-img" src="/nav-icons/${id}.png" alt="${label}" style="opacity:0"`
    + ` onload="this.style.opacity='1';this.parentElement.classList.add('has-art')"`
    + ` onerror="this.remove()" />`;
}

export function readyQuestCount(activeQuests: readonly { status: string }[] | undefined): number {
  return (activeQuests ?? []).filter(q => q.status === 'ready').length;
}

/** Someone in the party's room has a quest the player can take, or holds the next main-story step. */
export function newQuestHere(
  state: Pick<ServerStateMessage, 'offeredQuestIds' | 'availableQuestIds' | 'questGuide' | 'questGiverNpcId'> | null | undefined,
): boolean {
  if (questOfferedHere(state)) return true;
  const first = state?.questGuide?.steps[0];
  return first?.status === 'available' && !!state?.questGiverNpcId && !!first.giverNpcIds?.includes(state.questGiverNpcId);
}

/** Phone tab bar and, at desktop widths, the side rail: same element, laid out by CSS. */
export class BottomNav {
  private container: HTMLElement;
  private tabButtons = new Map<string, HTMLElement>();
  private tabLabels = new Map<string, string>();
  private activeId: string | null = null;

  constructor(
    tabs: readonly NavTabConfig[],
    defaultTab: string,
    /** `wasActive` is true when the player re-tapped the current tab. */
    onSelect: (tabId: string, wasActive: boolean) => void,
    gameClient: GameClient,
  ) {
    this.container = document.getElementById('bottom-nav')!;
    this.container.setAttribute('aria-label', 'Main');
    this.container.innerHTML = '';

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-tab';
      button.dataset.screen = tab.id;
      if (tab.railOnly) button.dataset.railOnly = '';
      button.setAttribute('aria-label', tab.label);
      button.innerHTML = `
        <span class="nav-tab-bg"></span>
        <span class="nav-icon">${navIconHtml(tab.id, tab.label, tab.glyph)}</span>
        <span class="nav-label">${tab.label}</span>
        <span class="nav-badge"></span>
        <span class="nav-active-bar"></span>
      `;
      button.addEventListener('click', () => onSelect(tab.id, this.activeId === tab.id));
      this.container.appendChild(button);
      this.tabButtons.set(tab.id, button);
      this.tabLabels.set(tab.id, tab.label);
    }

    this.setActive(defaultTab);
    this.wireStatusIndicators(gameClient);
  }

  setActive(id: string): void {
    if (this.activeId === id) return;
    if (this.activeId) {
      const prev = this.tabButtons.get(this.activeId);
      prev?.classList.remove('active');
      prev?.removeAttribute('aria-current');
    }
    const next = this.tabButtons.get(id);
    next?.classList.add('active');
    next?.setAttribute('aria-current', 'page');
    this.activeId = id;
  }

  /** Lights a tab that toggles something rather than changing screen (Chat). */
  setOverlayActive(id: string, active: boolean): void {
    this.tabButtons.get(id)?.classList.toggle('overlay-active', active);
  }

  setChatUnread(count: number): void {
    this.setCountBadge('chat', count, 'unread');
  }

  private setCountBadge(id: string, count: number, noun: string): void {
    const badge = this.tabButtons.get(id)?.querySelector('.nav-badge');
    if (!badge) return;
    const text = count > 0 ? countText(count) : '';
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle('nav-badge-count', count > 0);
    badge.classList.toggle('visible', count > 0);
    this.setTabName(id, text && `${text} ${noun}`);
  }

  /** The ready count wins; with nothing ready, a green dot says someone here has a quest. */
  private setQuestBadge(state: ServerStateMessage): void {
    const ready = readyQuestCount(state.activeQuests);
    this.setCountBadge('quests', ready, 'ready');
    const badge = this.tabButtons.get('quests')?.querySelector('.nav-badge');
    const fresh = ready === 0 && newQuestHere(state);
    badge?.classList.toggle('nav-badge-new', fresh);
    if (!fresh) return;
    badge?.classList.add('visible');
    this.setTabName('quests', NEW_QUEST_HERE_TEXT);
  }

  private setDotBadge(id: string, visible: boolean): void {
    this.tabButtons.get(id)?.querySelector('.nav-badge')?.classList.toggle('visible', visible);
    this.setTabName(id, visible ? 'needs attention' : '');
  }

  private setTabName(id: string, detail: string): void {
    const label = this.tabLabels.get(id) ?? '';
    this.tabButtons.get(id)?.setAttribute('aria-label', detail ? `${label}, ${detail}` : label);
  }

  private wireStatusIndicators(gameClient: GameClient): void {
    let lastVisual = '';

    gameClient.subscribe((state) => {
      const visual = state.battle.visual;
      const combatTab = this.tabButtons.get('combat');
      if (combatTab) {
        combatTab.classList.toggle('fighting-pulse', visual === 'fighting');
        // 'none' follows a result at once while Autorun walks; the flash keeps playing through it.
        if (visual !== 'none') {
          combatTab.classList.toggle('victory-flash', visual === 'victory' && lastVisual === 'fighting');
          combatTab.classList.toggle('defeat-flash', visual === 'defeat' && lastVisual === 'fighting');
        }
      }
      this.tabButtons.get('map')?.classList.toggle('has-path', isTravelling(state.party));
      this.setQuestBadge(state);

      const social = state.social;
      if (social) {
        const friendRequests = (social.incomingFriendRequests?.length ?? 0) > 0;
        const partyInvites = (social.pendingInvites?.length ?? 0) > 0;
        this.setDotBadge('social', friendRequests || partyInvites);

        const hasMailbox = (social.mailbox?.length ?? 0) > 0;
        const tradeNeedsAction = (social.proposedTrades ?? []).some(t =>
          t.lastUpdatedBy && t.lastUpdatedBy !== state.username,
        );
        this.setDotBadge('items', hasMailbox || tradeNeedsAction);
      }

      lastVisual = visual;
    }, { replay: true });
  }
}

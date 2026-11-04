import { OFFLINE_NOTICE, type GameClient } from '../network/GameClient';
import type {
  NpcDefinition,
  QuestDefinition,
  QuestProgressEntry,
  ServerErrorCode,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { SOLO_QUEST_IN_PARTY_REASON } from '@idle-party-rpg/shared';
import { renderTrackedImg } from './assets';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { objectiveText, rewardsText, scopeBadgeHtml, statusLabel, type QuestResolutions } from './QuestText';
import { deferWhilePressed, setHtml } from './render';

export const QUEST_REPLY_TIMEOUT_MS = 5000;
export const NPC_NOTICE_MS = 4000;
export const NO_REPLY_NOTICE = 'No answer from the server. Please try again.';

type QuestRequestKind = 'accept' | 'turnin';

interface PendingRequest {
  kind: QuestRequestKind;
  timer: ReturnType<typeof setTimeout>;
}

interface CompletionMessage {
  questId: string;
  questName: string;
  text: string;
}

interface Regions {
  header: HTMLElement;
  greeting: HTMLElement;
  notice: HTMLElement;
  completions: HTMLElement;
  ready: HTMLElement;
  progress: HTMLElement;
  available: HTMLElement;
  empty: HTMLElement;
}

interface QuestSections {
  ready: string;
  progress: string;
  available: string;
  empty: string;
  /** Quests whose card has an action area, where a refusal can show next to the button. */
  actionable: ReadonlySet<string>;
}

interface Refusal {
  questId: string;
  text: string;
}

const NO_SECTIONS: QuestSections = { ready: '', progress: '', available: '', empty: '', actionable: new Set() };

/** Talk-to-NPC modal: the NPC's quests with Accept / Turn In. See docs/architecture/client.md. */
export class NpcTalkPopup {
  private readonly gameClient: GameClient;
  private readonly overlay: HTMLElement;
  private readonly modal: HTMLElement;
  private readonly regions: Regions;
  private npc: NpcDefinition | null = null;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private completionMessages: CompletionMessage[] = [];
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private refusal: Refusal | null = null;
  private refusalTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStartedOnBackdrop = false;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'npc-talk-overlay';
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = `
      <div class="npc-talk-modal" role="dialog" aria-modal="true">
        <div class="npc-talk-header"></div>
        <div class="npc-talk-greeting"></div>
        <div class="npc-talk-notice" role="status" aria-live="polite"></div>
        <div class="npc-talk-completions"></div>
        <div class="npc-quest-section npc-quest-ready"></div>
        <div class="npc-quest-section npc-quest-progress"></div>
        <div class="npc-quest-section npc-quest-available"></div>
        <div class="npc-quest-section-empty"></div>
        <div class="npc-talk-actions">
          <button class="npc-talk-btn npc-talk-close" type="button" data-action="close">Close</button>
        </div>
      </div>
    `;
    const part = (selector: string) => this.overlay.querySelector(selector) as HTMLElement;
    this.modal = part('.npc-talk-modal');
    this.regions = {
      header: part('.npc-talk-header'),
      greeting: part('.npc-talk-greeting'),
      notice: part('.npc-talk-notice'),
      completions: part('.npc-talk-completions'),
      ready: part('.npc-quest-ready'),
      progress: part('.npc-quest-progress'),
      available: part('.npc-quest-available'),
      empty: part('.npc-quest-section-empty'),
    };

    this.overlay.addEventListener('pointerdown', (e) => {
      this.pressStartedOnBackdrop = e.target === this.overlay;
    });
    this.overlay.addEventListener('click', (e) => this.handleClick(e));
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  show(npc: NpcDefinition): void {
    if (this.npc && this.npc.id !== npc.id) this.resetConversation();
    this.npc = npc;
    this.modal.setAttribute('aria-label', npc.name);
    setHtml(this.regions.header, this.headerHtml(npc));
    setHtml(this.regions.greeting, `"${escapeHtml(npc.greeting)}"`);
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);

    if (!this.unsubscribeState) {
      this.unsubscribeState = this.gameClient.subscribe(() => {
        // Settle on arrival, not in the held paint, or a long press outlives the reply timer.
        this.settlePending(this.gameClient.lastState);
        this.repaintLater();
      });
    }
    if (!this.unsubscribeError) {
      this.unsubscribeError = this.gameClient.onServerError((message, code, detail) => {
        this.handleServerError(message, code, detail?.questId);
      });
    }
    this.paint();
  }

  hide(): void {
    this.overlay.style.display = 'none';
    release(this.overlay);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.resetConversation();
    this.npc = null;
    for (const region of Object.values(this.regions)) setHtml(region, '');
  }

  private isOpen(): boolean {
    return this.npc !== null && this.overlay.style.display !== 'none';
  }

  private repaintLater(): void {
    deferWhilePressed(this.overlay, () => this.paint());
  }

  private paint(): void {
    const npc = this.npc;
    if (!npc || !this.isOpen()) return;
    const state = this.gameClient.lastState;
    this.settlePending(state);

    const nearby = state?.questGiverNpcId === npc.id;
    const sections = nearby && state ? this.questSections(state) : NO_SECTIONS;
    const notice = nearby ? this.notice ?? this.refusalNotice(state, sections) : `${npc.name} is no longer nearby.`;

    const noticeChanged = setHtml(this.regions.notice, notice ? escapeHtml(notice) : '');
    setHtml(this.regions.completions, this.completionsHtml());
    setHtml(this.regions.ready, sections.ready);
    setHtml(this.regions.progress, sections.progress);
    setHtml(this.regions.available, sections.available);
    setHtml(this.regions.empty, sections.empty);
    if (noticeChanged && notice) this.regions.notice.scrollIntoView({ block: 'nearest' });
  }

  private handleClick(e: MouseEvent): void {
    if (e.target === this.overlay) {
      if (this.pressStartedOnBackdrop) this.hide();
      this.pressStartedOnBackdrop = false;
      return;
    }
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-action]') : null;
    if (!el) return;
    const questId = el.dataset.questId ?? '';
    switch (el.dataset.action) {
      case 'close':
        this.hide();
        break;
      case 'accept':
      case 'turnin':
        this.request(el.dataset.action, questId);
        break;
      case 'dismiss-completion':
        this.completionMessages = this.completionMessages.filter(m => m.questId !== questId);
        this.paint();
        break;
    }
  }

  private request(kind: QuestRequestKind, questId: string): void {
    if (!questId || this.pending.has(questId)) return;
    const sent = kind === 'accept'
      ? this.gameClient.sendAcceptQuest(questId)
      : this.gameClient.sendTurnInQuest(questId);
    if (sent) {
      this.clearNotice();
      this.clearRefusal();
      const timer = setTimeout(() => this.handleNoReply(questId), QUEST_REPLY_TIMEOUT_MS);
      this.pending.set(questId, { kind, timer });
    } else {
      this.showNotice(OFFLINE_NOTICE);
    }
    this.paint();
  }

  private settlePending(state: ServerStateMessage | null): void {
    if (!state || this.pending.size === 0) return;
    const active = new Set((state.activeQuests ?? []).map(a => a.questId));
    const completed = new Set((state.completedQuests ?? []).map(c => c.questId));
    for (const [questId, request] of this.pending) {
      if (request.kind === 'accept' && active.has(questId)) {
        this.settle(questId);
      } else if (request.kind === 'turnin' && !active.has(questId) && completed.has(questId)) {
        this.settle(questId);
        const def = state.questDefinitions?.[questId];
        const text = def?.completionText?.trim();
        if (def && text) this.completionMessages.push({ questId, questName: def.name, text });
      }
    }
  }

  private settle(questId: string): void {
    const request = this.pending.get(questId);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(questId);
  }

  private handleServerError(message: string, code: ServerErrorCode | undefined, questId: string | undefined): void {
    if (code !== 'quest_refused' || !questId || !this.pending.has(questId)) return;
    this.settle(questId);
    this.clearRefusal();
    this.refusal = { questId, text: message };
    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = null;
      this.refusal = null;
      this.repaintLater();
    }, NPC_NOTICE_MS);
    this.repaintLater();
  }

  /** A refusal shows on its quest's card; only when that card is gone does it go to the top, named. */
  private refusalNotice(state: ServerStateMessage | null, sections: QuestSections): string | null {
    const refusal = this.refusal;
    if (!refusal || sections.actionable.has(refusal.questId)) return null;
    const name = state?.questDefinitions?.[refusal.questId]?.name;
    return name ? `${name}: ${refusal.text}` : refusal.text;
  }

  private clearRefusal(): void {
    if (this.refusalTimer !== null) clearTimeout(this.refusalTimer);
    this.refusalTimer = null;
    this.refusal = null;
  }

  private handleNoReply(questId: string): void {
    if (!this.pending.has(questId)) return;
    this.pending.delete(questId);
    this.showNotice(NO_REPLY_NOTICE);
    this.repaintLater();
  }

  private showNotice(text: string): void {
    this.clearNotice();
    this.notice = text;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.notice = null;
      this.repaintLater();
    }, NPC_NOTICE_MS);
  }

  private clearNotice(): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = null;
  }

  private resetConversation(): void {
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
    this.completionMessages = [];
    this.clearNotice();
    this.clearRefusal();
  }

  private questSections(state: ServerStateMessage): QuestSections {
    const offered = state.offeredQuestIds ?? [];
    const defs = state.questDefinitions ?? {};
    const resolutions = state.questResolutions;
    const activeById = new Map((state.activeQuests ?? []).map(a => [a.questId, a]));
    const acceptable = new Set(state.availableQuestIds ?? []);
    const partySize = state.social?.party?.members.length ?? 1;

    const ready: string[] = [];
    const progress: string[] = [];
    const available: string[] = [];
    const actionable = new Set<string>();
    for (const questId of offered) {
      const def = defs[questId];
      if (!def) continue;
      const entry = activeById.get(questId);
      if (entry?.status === 'ready') {
        ready.push(this.readyCardHtml(def, resolutions));
        actionable.add(questId);
      } else if (entry) {
        progress.push(this.progressCardHtml(def, entry, resolutions));
      } else if (acceptable.has(questId)) {
        const reason = def.scope === 'solo' && partySize > 1 ? SOLO_QUEST_IN_PARTY_REASON : null;
        available.push(this.availableCardHtml(def, resolutions, reason));
        actionable.add(questId);
      }
    }

    const nothingShown = ready.length + progress.length + available.length === 0;
    return {
      ready: sectionHtml('Ready to Turn In', ready),
      progress: sectionHtml('In Progress', progress),
      available: sectionHtml('Available', available),
      empty: offered.length > 0 && nothingShown ? 'Nothing for you right now.' : '',
      actionable,
    };
  }

  private headerHtml(npc: NpcDefinition): string {
    const art = npc.artworkUrl ? renderTrackedImg(npc.artworkUrl, { className: 'npc-talk-portrait-img' }) : '';
    const emoji = `<div class="npc-talk-portrait-emoji">${escapeHtml(npc.emoji)}</div>`;
    return `<div class="npc-talk-portrait">${art}${emoji}</div><div class="npc-talk-name">${escapeHtml(npc.name)}</div>`;
  }

  private completionsHtml(): string {
    return this.completionMessages.map(m => `
      <div class="npc-talk-completion" data-quest-id="${escapeHtml(m.questId)}">
        <div class="npc-talk-completion-label">Quest complete: ${escapeHtml(m.questName)}</div>
        <div class="npc-talk-completion-text">"${escapeHtml(m.text)}"</div>
        <button class="npc-talk-completion-dismiss" type="button" data-action="dismiss-completion" data-quest-id="${escapeHtml(m.questId)}">OK</button>
      </div>
    `).join('');
  }

  private availableCardHtml(def: QuestDefinition, resolutions: QuestResolutions, blockedReason: string | null): string {
    const action = blockedReason
      ? `<span class="quest-card-blocked">${escapeHtml(blockedReason)}</span>`
      : this.refusalHtml(def.id) + this.requestButtonHtml('accept', def.id);
    return `
      <div class="quest-card" data-quest-id="${escapeHtml(def.id)}">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          ${scopeBadgeHtml(def.scope)}
        </div>
        <div class="quest-card-desc">${escapeHtml(def.description)}</div>
        <div class="quest-card-objectives">
          ${def.objectives.map(o => `<div class="quest-objective">• ${objectiveText(o, 0, resolutions)}</div>`).join('')}
        </div>
        <div class="quest-card-rewards">Rewards: ${rewardsText(def.rewards, resolutions)}</div>
        <div class="quest-card-actions">${action}</div>
      </div>
    `;
  }

  private progressCardHtml(def: QuestDefinition, progress: QuestProgressEntry, resolutions: QuestResolutions): string {
    return `
      <div class="quest-card" data-quest-id="${escapeHtml(def.id)}">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          <span class="quest-pill quest-status-${progress.status}">${statusLabel(progress.status)}</span>
        </div>
        <div class="quest-card-objectives">
          ${def.objectives.map((o, i) => `<div class="quest-objective">• ${objectiveText(o, progress.progress[i] ?? 0, resolutions)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  private readyCardHtml(def: QuestDefinition, resolutions: QuestResolutions): string {
    return `
      <div class="quest-card quest-card-ready" data-quest-id="${escapeHtml(def.id)}">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def.name)}</span>
          <span class="quest-pill quest-status-ready">Ready</span>
        </div>
        <div class="quest-card-rewards">Rewards: ${rewardsText(def.rewards, resolutions)}</div>
        <div class="quest-card-actions">${this.refusalHtml(def.id)}${this.requestButtonHtml('turnin', def.id)}</div>
      </div>
    `;
  }

  private refusalHtml(questId: string): string {
    if (this.refusal?.questId !== questId) return '';
    return `<span class="quest-card-blocked" role="status">${escapeHtml(this.refusal.text)}</span>`;
  }

  private requestButtonHtml(kind: QuestRequestKind, questId: string): string {
    const busy = this.pending.has(questId);
    const label = kind === 'accept'
      ? (busy ? 'Accepting…' : 'Accept')
      : (busy ? 'Turning in…' : 'Turn In');
    const classes = ['npc-talk-btn', kind === 'turnin' ? 'npc-talk-btn-primary' : '', busy ? 'npc-talk-btn-busy' : '']
      .filter(Boolean)
      .join(' ');
    const busyAttr = busy ? ' aria-disabled="true"' : '';
    return `<button class="${classes}" type="button" data-action="${kind}" data-quest-id="${escapeHtml(questId)}"${busyAttr}>${label}</button>`;
  }
}

function sectionHtml(title: string, cards: readonly string[]): string {
  return cards.length > 0 ? `<div class="npc-quest-section-title">${title}</div>${cards.join('')}` : '';
}

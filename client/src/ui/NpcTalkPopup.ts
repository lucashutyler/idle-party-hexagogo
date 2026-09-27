import type { GameClient } from '../network/GameClient';
import type {
  NpcDefinition,
  ServerStateMessage,
  QuestDefinition,
  QuestProgressEntry,
  QuestObjective,
  QuestReward,
} from '@idle-party-rpg/shared';
import { canAcceptQuest, getObjectiveTarget } from '@idle-party-rpg/shared';

const NOTICE_WINDOW_MS = 3000;
const NOTICE_DURATION_MS = 3500;

export class NpcTalkPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private currentNpc: NpcDefinition | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Quest IDs the player has clicked Turn In on; awaiting confirmation in next state push. */
  private pendingTurnIns: Set<string> = new Set();
  /** Completion speech bubbles to render until the player dismisses them. */
  private completionMessages: { questId: string; questName: string; text: string }[] = [];
  private lastHtml = '';
  private unsubscribeError: (() => void) | null = null;
  private actionSentAt = 0;
  private notice: string | null = null;
  private noticeTimer: number | null = null;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'npc-talk-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => this.handleClick(e));
    document.body.appendChild(this.overlay);
  }

  show(npc: NpcDefinition): void {
    this.currentNpc = npc;
    const state = this.gameClient.lastState;
    this.render(state ?? null);
    this.overlay.style.display = 'flex';

    this.unsubscribe?.();
    this.unsubscribe = this.gameClient.subscribe((s) => {
      if (this.overlay.style.display === 'none') return;
      this.render(s);
    });

    this.unsubscribeError?.();
    this.unsubscribeError = this.gameClient.onServerError((message) => {
      if (this.overlay.style.display === 'none') return;
      if (Date.now() - this.actionSentAt > NOTICE_WINDOW_MS) return;
      this.actionSentAt = 0;
      this.showNotice(message);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    this.lastHtml = '';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = null;
    this.actionSentAt = 0;
    this.currentNpc = null;
    this.pendingTurnIns.clear();
    this.completionMessages = [];
  }

  private resolveMonster(id: string): string {
    return this.lastResolutions?.monsters[id] ?? id;
  }
  private resolveItem(id: string): string {
    return this.lastResolutions?.items[id] ?? id;
  }
  private resolveTile(id: string): string {
    const t = this.lastResolutions?.tiles[id];
    return t ? `${t.name} (${t.col},${t.row})` : 'a specific room';
  }

  private lastResolutions: ServerStateMessage['questResolutions'] | undefined;

  private render(state: ServerStateMessage | null): void {
    const npc = this.currentNpc;
    if (!npc) return;
    this.lastResolutions = state?.questResolutions;

    const portrait = npc.artworkUrl
      ? `<img class="npc-talk-portrait-img" src="${this.escape(npc.artworkUrl)}" alt="">`
      : `<div class="npc-talk-portrait-emoji">${this.escape(npc.emoji)}</div>`;

    const offered = state?.offeredQuestIds ?? [];
    const defs = state?.questDefinitions ?? {};
    const active = state?.activeQuests ?? [];
    const completed = state?.completedQuests ?? [];
    const playerLevel = state?.character?.level ?? 1;

    const completedSet = new Set(completed.map(c => c.questId));
    const activeMap = new Map<string, QuestProgressEntry>();
    for (const a of active) activeMap.set(a.questId, a);

    // Detect pending turn-ins that completed this tick → queue completion speech
    for (const qid of Array.from(this.pendingTurnIns)) {
      if (!activeMap.has(qid) && completedSet.has(qid)) {
        const def = defs[qid];
        const text = def?.completionText?.trim();
        if (text) {
          this.completionMessages.push({ questId: qid, questName: def!.name, text });
        }
        this.pendingTurnIns.delete(qid);
      }
    }

    const completionHtml = this.completionMessages.length > 0
      ? this.completionMessages.map(m => `
          <div class="npc-talk-completion" data-quest-id="${this.escape(m.questId)}">
            <div class="npc-talk-completion-label">Quest complete: ${this.escape(m.questName)}</div>
            <div class="npc-talk-completion-text">"${this.escape(m.text)}"</div>
            <button class="npc-talk-completion-dismiss" data-dismiss-completion="${this.escape(m.questId)}" type="button">OK</button>
          </div>
        `).join('')
      : '';

    // Quests this NPC offers — split into sections
    const availableQuests: QuestDefinition[] = [];
    const inProgressQuests: { def: QuestDefinition; progress: QuestProgressEntry }[] = [];
    const readyQuests: { def: QuestDefinition; progress: QuestProgressEntry }[] = [];

    for (const qid of offered) {
      const def = defs[qid];
      if (!def) continue;
      const prog = activeMap.get(qid);
      if (prog) {
        if (prog.status === 'ready') readyQuests.push({ def, progress: prog });
        else inProgressQuests.push({ def, progress: prog });
      } else {
        // Show "Available" only if eligible to accept
        const reason = canAcceptQuest(def, {
          playerLevel,
          activeQuestIds: new Set(activeMap.keys()),
          completedQuestIds: completedSet,
          weeklyCompletions: {},
        });
        if (!reason) availableQuests.push(def);
      }
    }

    const readyHtml = readyQuests.length > 0
      ? `<div class="npc-quest-section npc-quest-ready">
           <div class="npc-quest-section-title">Ready to Turn In</div>
           ${readyQuests.map(q => this.renderReady(q.def)).join('')}
         </div>`
      : '';

    const inProgressHtml = inProgressQuests.length > 0
      ? `<div class="npc-quest-section">
           <div class="npc-quest-section-title">In Progress</div>
           ${inProgressQuests.map(q => this.renderInProgress(q.def, q.progress)).join('')}
         </div>`
      : '';

    const availableHtml = availableQuests.length > 0
      ? `<div class="npc-quest-section">
           <div class="npc-quest-section-title">Available</div>
           ${availableQuests.map(q => this.renderAvailable(q)).join('')}
         </div>`
      : '';

    const noQuestsHtml = (offered.length > 0 && readyQuests.length + inProgressQuests.length + availableQuests.length === 0)
      ? `<div class="npc-quest-section-empty">Nothing for you right now.</div>`
      : '';

    const html = `
      <div class="npc-talk-modal">
        <div class="npc-talk-header">
          ${portrait}
          <div class="npc-talk-name">${this.escape(npc.name)}</div>
        </div>
        <div class="npc-talk-greeting">"${this.escape(npc.greeting)}"</div>
        ${this.notice ? `<div class="npc-talk-notice" role="alert">${this.escape(this.notice)}</div>` : ''}
        ${completionHtml}
        ${readyHtml}
        ${inProgressHtml}
        ${availableHtml}
        ${noQuestsHtml}
        <div class="npc-talk-actions">
          <button class="npc-talk-btn npc-talk-close">Close</button>
        </div>
      </div>
    `;

    if (html === this.lastHtml) return;
    const scrollTop = this.overlay.querySelector('.npc-talk-modal')?.scrollTop ?? 0;
    this.overlay.innerHTML = html;
    this.lastHtml = html;
    const modal = this.overlay.querySelector('.npc-talk-modal');
    if (modal) modal.scrollTop = scrollTop;
  }

  /** Delegated so a state push re-rendering the modal mid-tap can't swallow the click. */
  private handleClick(e: MouseEvent): void {
    if (e.target === this.overlay) {
      this.hide();
      return;
    }
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || !this.overlay.contains(btn)) return;
    if (btn.classList.contains('npc-talk-close')) {
      this.hide();
    } else if (btn.dataset.questAccept) {
      this.actionSentAt = Date.now();
      this.gameClient.sendAcceptQuest(btn.dataset.questAccept);
    } else if (btn.dataset.questTurnin) {
      this.actionSentAt = Date.now();
      this.pendingTurnIns.add(btn.dataset.questTurnin);
      this.gameClient.sendTurnInQuest(btn.dataset.questTurnin);
    } else if (btn.dataset.dismissCompletion) {
      const qid = btn.dataset.dismissCompletion;
      this.completionMessages = this.completionMessages.filter(m => m.questId !== qid);
      this.render(this.gameClient.lastState ?? null);
    }
  }

  private showNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      this.render(this.gameClient.lastState ?? null);
    }, NOTICE_DURATION_MS);
    this.render(this.gameClient.lastState ?? null);
  }

  private renderAvailable(def: QuestDefinition): string {
    return `
      <div class="npc-quest-card npc-quest-card-available">
        <div class="npc-quest-card-header">
          <span class="npc-quest-card-name">${this.escape(def.name)}</span>
          ${this.scopeBadge(def.scope)}
        </div>
        <div class="npc-quest-card-desc">${this.escape(def.description)}</div>
        <div class="npc-quest-card-objectives">
          ${def.objectives.map(o => `<div class="npc-quest-objective">• ${this.objectiveText(o, 0)}</div>`).join('')}
        </div>
        <div class="npc-quest-card-rewards">Rewards: ${def.rewards.map(r => this.rewardText(r)).join(', ') || 'none'}</div>
        <div class="npc-quest-card-actions">
          <button class="npc-talk-btn" data-quest-accept="${this.escape(def.id)}">Accept</button>
        </div>
      </div>
    `;
  }

  private renderInProgress(def: QuestDefinition, progress: QuestProgressEntry): string {
    return `
      <div class="npc-quest-card">
        <div class="npc-quest-card-header">
          <span class="npc-quest-card-name">${this.escape(def.name)}</span>
          <span class="npc-quest-status-pill npc-quest-status-${progress.status}">${this.statusLabel(progress.status)}</span>
        </div>
        <div class="npc-quest-card-objectives">
          ${def.objectives.map((o, i) => `<div class="npc-quest-objective">• ${this.objectiveText(o, progress.progress[i] ?? 0)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  private renderReady(def: QuestDefinition): string {
    return `
      <div class="npc-quest-card npc-quest-card-ready">
        <div class="npc-quest-card-header">
          <span class="npc-quest-card-name">${this.escape(def.name)}</span>
          <span class="npc-quest-status-pill npc-quest-status-ready">Ready</span>
        </div>
        <div class="npc-quest-card-rewards">Rewards: ${def.rewards.map(r => this.rewardText(r)).join(', ') || 'none'}</div>
        <div class="npc-quest-card-actions">
          <button class="npc-talk-btn npc-talk-btn-primary" data-quest-turnin="${this.escape(def.id)}">Turn In</button>
        </div>
      </div>
    `;
  }

  private objectiveText(obj: QuestObjective, progress: number): string {
    const target = getObjectiveTarget(obj);
    const cap = Math.min(progress, target);
    if (obj.kind === 'kill') {
      return `Kill ${this.escape(this.resolveMonster(obj.monsterId))} (${cap}/${target})`;
    }
    if (obj.kind === 'collect') {
      return `Collect ${this.escape(this.resolveItem(obj.itemId))} (${cap}/${target})`;
    }
    const place = this.escape(this.resolveTile(obj.tileId));
    return cap >= 1 ? `Visit ${place} — done` : `Visit ${place}`;
  }

  private rewardText(reward: QuestReward): string {
    if (reward.kind === 'xp') return `${reward.amount} XP`;
    if (reward.kind === 'gold') return `${reward.amount} Gold`;
    return `${reward.quantity}× ${this.escape(this.resolveItem(reward.itemId))}`;
  }

  private scopeBadge(scope: 'solo' | 'party_shared'): string {
    return scope === 'solo'
      ? `<span class="npc-quest-scope-pill npc-quest-scope-solo">Solo</span>`
      : `<span class="npc-quest-scope-pill npc-quest-scope-party">Party</span>`;
  }

  private statusLabel(status: string): string {
    switch (status) {
      case 'accepted': return 'Accepted';
      case 'in_progress': return 'In Progress';
      case 'ready': return 'Ready';
      default: return status;
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

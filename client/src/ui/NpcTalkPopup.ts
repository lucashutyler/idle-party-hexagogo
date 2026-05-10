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

export class NpcTalkPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private currentNpc: NpcDefinition | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'npc-talk-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
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
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentNpc = null;
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

    this.overlay.innerHTML = `
      <div class="npc-talk-modal">
        <div class="npc-talk-header">
          ${portrait}
          <div class="npc-talk-name">${this.escape(npc.name)}</div>
        </div>
        <div class="npc-talk-greeting">"${this.escape(npc.greeting)}"</div>
        ${readyHtml}
        ${inProgressHtml}
        ${availableHtml}
        ${noQuestsHtml}
        <div class="npc-talk-actions">
          <button class="npc-talk-btn npc-talk-close">Close</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('.npc-talk-close')?.addEventListener('click', () => this.hide());

    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('[data-quest-accept]')) {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.questAccept!;
        this.gameClient.sendAcceptQuest(qid);
      });
    }
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('[data-quest-turnin]')) {
      btn.addEventListener('click', () => {
        const qid = btn.dataset.questTurnin!;
        this.gameClient.sendTurnInQuest(qid);
      });
    }
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

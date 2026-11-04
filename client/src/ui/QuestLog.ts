import type { CompletedQuestEntry, QuestDefinition, QuestProgressEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { getObjectiveTarget } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { objectiveText, rewardsText, scopeBadgeHtml, statusLabel, type QuestResolutions } from './QuestText';
import {
  giverLocations,
  sortActiveQuests,
  summarizeCompletedQuests,
  turnInLocations,
  weeklyAvailableAgainAt,
  type CompletedQuestSummary,
  type NpcLocation,
} from './QuestLogModel';
import { deferWhilePressed, setHtml } from './render';

const UNKNOWN_QUEST = 'Unknown quest';

/** Settings → Quest Log modal: who has new quests, active quests (ready first), then a collapsed completed history. */
export class QuestLog {
  private overlay: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private showCompleted = false;

  constructor(private gameClient: GameClient, private worldCache: WorldCache) {}

  open(): void {
    if (this.overlay) return;
    this.showCompleted = false;

    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal quest-log-modal" role="dialog" aria-label="Quest Log">
        <div class="player-options-header">
          <span class="player-options-title">Quest Log</span>
          <button class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="quest-log-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.body = overlay.querySelector('.quest-log-body') as HTMLElement;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', () => this.close());
    this.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.quest-log-completed-toggle')) return;
      this.showCompleted = !this.showCompleted;
      this.render(this.gameClient.lastState);
    });

    bringToFront(overlay);
    wireFocusOnInteract(overlay);

    this.render(this.gameClient.lastState);
    this.unsubscribe = this.gameClient.subscribe(() => {
      if (this.body) deferWhilePressed(this.body, () => this.render(this.gameClient.lastState));
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.overlay) return;
    release(this.overlay);
    this.overlay.remove();
    this.overlay = null;
    this.body = null;
  }

  private render(state: ServerStateMessage | null): void {
    if (!this.body) return;
    const scrollTop = this.body.scrollTop;
    if (setHtml(this.body, this.renderHtml(state))) this.body.scrollTop = scrollTop;
  }

  private renderHtml(state: ServerStateMessage | null): string {
    const defs = state?.questDefinitions ?? {};
    const resolutions = state?.questResolutions;
    const unlocked = new Set(state?.unlocked ?? []);
    const active = sortActiveQuests(state?.activeQuests ?? []);

    const activeHtml = active.length > 0
      ? active.map(entry => this.renderActive(entry, defs[entry.questId], resolutions, unlocked)).join('')
      : `<div class="quest-log-empty">No active quests. Talk to the people you meet to find work.</div>`;

    return this.renderGivers(state?.availableQuestIds ?? [], unlocked)
      + activeHtml
      + this.renderCompleted(state?.completedQuests ?? [], defs, state?.weeklyCompletions ?? {});
  }

  private renderGivers(availableQuestIds: readonly string[], unlocked: ReadonlySet<string>): string {
    const locations = giverLocations(
      availableQuestIds,
      this.worldCache.getAllNpcs(),
      npcId => this.worldCache.getRoomsWithNpc(npcId),
      unlocked,
    );
    if (locations.length === 0) return '';
    return `
      <div class="quest-log-givers">
        <div class="quest-log-givers-title">Quests available from</div>
        <ul class="quest-log-givers-list">
          ${locations.map(loc => `<li class="quest-log-giver">${locationText(loc)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  private renderActive(
    entry: QuestProgressEntry,
    def: QuestDefinition | undefined,
    resolutions: QuestResolutions,
    unlocked: ReadonlySet<string>,
  ): string {
    const ready = entry.status === 'ready';
    const objectives = (def?.objectives ?? []).map((obj, i) => {
      const progress = entry.progress[i] ?? 0;
      const done = progress >= getObjectiveTarget(obj);
      return `<div class="quest-objective${done ? ' quest-objective-done' : ''}">${done ? '✓' : '•'} ${objectiveText(obj, progress, resolutions)}</div>`;
    }).join('');

    return `
      <div class="quest-card${ready ? ' quest-card-ready' : ''}" data-quest-id="${escapeHtml(entry.questId)}">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(def?.name ?? UNKNOWN_QUEST)}</span>
          <span class="quest-log-pills">
            <span class="quest-pill quest-status-${entry.status}">${statusLabel(entry.status)}</span>
            ${def ? scopeBadgeHtml(def.scope) : ''}
          </span>
        </div>
        ${def?.description ? `<div class="quest-card-desc">${escapeHtml(def.description)}</div>` : ''}
        ${objectives ? `<div class="quest-card-objectives">${objectives}</div>` : ''}
        ${def ? `<div class="quest-card-rewards">Rewards: ${rewardsText(def.rewards, resolutions)}</div>` : ''}
        ${this.renderTurnIn(entry.questId, ready, unlocked)}
      </div>
    `;
  }

  private renderTurnIn(questId: string, ready: boolean, unlocked: ReadonlySet<string>): string {
    const locations = turnInLocations(
      questId,
      this.worldCache.getAllNpcs(),
      npcId => this.worldCache.getRoomsWithNpc(npcId),
      unlocked,
    );
    if (locations.length === 0) return '';
    return `
      <div class="quest-log-turnin${ready ? ' quest-log-turnin-ready' : ''}">
        Turn in to: ${locations.map(locationText).join(' or ')}
      </div>
    `;
  }

  private renderCompleted(
    completed: readonly CompletedQuestEntry[],
    defs: Record<string, QuestDefinition>,
    weeklyCompletions: Readonly<Record<string, string>>,
  ): string {
    const rows = summarizeCompletedQuests(completed);
    if (rows.length === 0) return '';

    const toggle = `
      <button type="button" class="quest-log-completed-toggle" aria-expanded="${this.showCompleted}">
        <span class="quest-log-chevron">${this.showCompleted ? '▾' : '▸'}</span>
        Completed (${rows.length})
      </button>
    `;
    if (!this.showCompleted) return toggle;

    const now = new Date();
    return `
      ${toggle}
      <div class="quest-log-completed-list">
        ${rows.map(row => completedRowHtml(row, defs[row.questId], weeklyCompletions[row.questId], now)).join('')}
      </div>
    `;
  }
}

function completedRowHtml(
  row: CompletedQuestSummary,
  def: QuestDefinition | undefined,
  weeklyCompletedAt: string | undefined,
  now: Date,
): string {
  const availableAt = def?.repeat === 'weekly' && weeklyCompletedAt ? weeklyAvailableAgainAt(weeklyCompletedAt, now) : null;
  return `
    <div class="quest-log-completed-row" data-quest-id="${escapeHtml(row.questId)}">
      <div class="quest-log-completed-name">
        ${escapeHtml(def?.name ?? UNKNOWN_QUEST)}
        ${row.timesCompleted > 1 ? `<span class="quest-log-repeat">×${row.timesCompleted}</span>` : ''}
      </div>
      <div class="quest-log-completed-meta">Completed ${formatDate(new Date(row.lastCompletedAt))}</div>
      ${availableAt ? `<div class="quest-log-completed-meta quest-log-available">Available again ${formatDateTime(availableAt)}</div>` : ''}
    </div>
  `;
}

function locationText(loc: NpcLocation): string {
  const who = `${escapeHtml(loc.npcEmoji)} ${escapeHtml(loc.npcName)}`;
  const where = [loc.roomName, loc.zoneName].filter(Boolean).join(', ');
  return where ? `${who} — ${escapeHtml(where)}` : who;
}

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

import type {
  CompletedQuestEntry,
  MainStoryStep,
  QuestDefinition,
  QuestGuide,
  QuestObjective,
  QuestProgressEntry,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { getObjectiveTarget, questTitle } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { objectiveText, rewardsText, scopeBadgeHtml, statusLabel, type QuestResolutions } from './QuestText';
import {
  giverLocations,
  nextStoryStep,
  splitMainQuests,
  stepGiverLocations,
  summarizeCompletedQuests,
  turnInLocations,
  weeklyAvailableAgainAt,
  type CompletedQuestSummary,
  type NpcLocation,
} from './QuestLogModel';
import { deferWhilePressed, setHtml } from './render';

const UNKNOWN_QUEST = 'Unknown quest';
const NO_ACTIVE_QUESTS = `<div class="quest-log-empty">No active quests. Talk to the people you meet to find work.</div>`;

interface CardStyle {
  main?: boolean;
  leadsTo?: string;
}

/** The words of a main-story step row, before any "talk to" part. */
function storyStepLead(step: MainStoryStep): string {
  const title = questTitle(step);
  if (step.status === 'needs_level') return `Reach ${levelText(step.requiredLevel)} to continue: ${title}`;
  if (step.leadsTo) return `Needed for the main story (${questTitle({ name: step.leadsTo })}): ${title}`;
  return `Next: ${title}`;
}

/** Thin bar for counted objectives; a one-step objective's tick already says it all. */
export function objectiveBarHtml(obj: QuestObjective, progress: number): string {
  const target = getObjectiveTarget(obj);
  if (target <= 1) return '';
  const fraction = Math.min(1, Math.max(0, progress / target));
  return `<span class="quest-progress" aria-hidden="true"><span class="quest-progress-fill" style="transform:scaleX(${fraction.toFixed(3)})"></span></span>`;
}

/** Quest Log modal, owned by App: the main story, the other active quests, who has new quests, then a collapsed history. See docs/architecture/client.md. */
export class QuestLog {
  private overlay: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private showCompleted = false;
  private showOtherMapGivers = false;
  private currentMapId: string | undefined;

  constructor(
    private gameClient: GameClient,
    private worldCache: WorldCache,
    readonly onGoToRoom?: (roomId: string) => void,
  ) {}

  open(): void {
    if (this.overlay) return;
    this.showCompleted = false;
    this.showOtherMapGivers = false;

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
      if (!(e.target instanceof Element)) return;
      const roomId = e.target.closest<HTMLElement>('.quest-log-go')?.dataset.roomId;
      if (roomId) {
        this.close();
        this.onGoToRoom?.(roomId);
        return;
      }
      if (e.target.closest('.quest-log-givers-more')) {
        this.showOtherMapGivers = !this.showOtherMapGivers;
        this.render(this.gameClient.lastState);
        return;
      }
      if (!e.target.closest('.quest-log-completed-toggle')) return;
      this.showCompleted = !this.showCompleted;
      this.render(this.gameClient.lastState);
    });

    bringToFront(overlay, () => this.close());
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
    const guide = state?.questGuide;
    const { main, other } = splitMainQuests(state?.activeQuests ?? [], guide);
    this.currentMapId = state?.currentMapId;

    const otherHtml = other.map(entry => this.renderActive(entry, defs[entry.questId], resolutions, unlocked)).join('');
    const emptyHtml = main.length + other.length === 0 ? NO_ACTIVE_QUESTS : '';
    const giversHtml = this.renderGivers(state?.availableQuestIds ?? [], unlocked, guide);
    const completedHtml = this.renderCompleted(state?.completedQuests ?? [], defs, state?.weeklyCompletions ?? {});

    if (!guide) return giversHtml + otherHtml + emptyHtml + completedHtml;
    return this.renderMainStory(main, guide, defs, resolutions, unlocked) + otherHtml + emptyHtml + giversHtml + completedHtml;
  }

  private renderMainStory(
    main: readonly QuestProgressEntry[],
    guide: QuestGuide,
    defs: Readonly<Record<string, QuestDefinition>>,
    resolutions: QuestResolutions,
    unlocked: ReadonlySet<string>,
  ): string {
    const leadsTo = new Map(guide.steps.map(step => [step.questId, step.leadsTo]));
    const cards = main.map(entry =>
      this.renderActive(entry, defs[entry.questId], resolutions, unlocked, { main: true, leadsTo: leadsTo.get(entry.questId) }));
    const step = nextStoryStep(guide, npcId => this.worldCache.getRoomsWithNpc(npcId), this.currentMapId);
    const stepHtml = step ? this.renderStoryStep(step, unlocked) : '';
    if (cards.length === 0 && !stepHtml) return '';
    return `
      <div class="quest-log-main">
        <div class="quest-log-main-title">Main Story</div>
        ${cards.join('')}
        ${stepHtml}
      </div>
    `;
  }

  private renderStoryStep(step: MainStoryStep, unlocked: ReadonlySet<string>): string {
    const lead = escapeHtml(storyStepLead(step));
    if (step.status !== 'available') return `<div class="quest-log-step">${lead}</div>`;

    const npcs = this.worldCache.getAllNpcs();
    const where = stepGiverLocations(step, npcs, npcId => this.worldCache.getRoomsWithNpc(npcId), unlocked, this.currentMapId)[0];
    const npcName = where?.npcName ?? npcs.find(npc => step.giverNpcIds?.includes(npc.id))?.name;
    if (!npcName) return `<div class="quest-log-step">${lead}</div>`;

    const place = where ? [where.roomName, where.zoneName].filter(Boolean).join(', ') : '';
    const text = `${lead}: talk to ${escapeHtml(place ? `${npcName}, ${place}` : npcName)}`;
    if (!this.onGoToRoom || !where?.roomId || where.mapId !== this.currentMapId) return `<div class="quest-log-step">${text}</div>`;
    return `<button type="button" class="quest-log-go quest-log-step" data-room-id="${escapeHtml(where.roomId)}">${text}</button>`;
  }

  private renderGivers(availableQuestIds: readonly string[], unlocked: ReadonlySet<string>, guide: QuestGuide | undefined): string {
    const locations = giverLocations(
      availableQuestIds,
      this.worldCache.getAllNpcs(),
      npcId => this.worldCache.getRoomsWithNpc(npcId),
      unlocked,
      guide?.mainQuestIds,
      this.currentMapId,
    );
    if (locations.length === 0) return '';
    const here = guide ? locations.filter(loc => loc.mapId === this.currentMapId) : locations;
    const elsewhere = guide ? locations.filter(loc => loc.mapId !== this.currentMapId) : [];
    const rows = (list: readonly NpcLocation[]) => list.map(loc => `<li class="quest-log-giver">${this.locationHtml(loc)}</li>`).join('');
    const more = elsewhere.length === 0 ? '' : `
      <button type="button" class="quest-log-givers-more" aria-expanded="${this.showOtherMapGivers}">
        <span class="quest-log-chevron">${this.showOtherMapGivers ? '▾' : '▸'}</span>
        ${elsewhere.length} more on other maps
      </button>
      ${this.showOtherMapGivers ? `<ul class="quest-log-givers-list">${rows(elsewhere)}</ul>` : ''}
    `;
    return `
      <div class="quest-log-givers">
        <div class="quest-log-givers-title">Quests available from</div>
        ${here.length > 0 ? `<ul class="quest-log-givers-list">${rows(here)}</ul>` : ''}
        ${more}
      </div>
    `;
  }

  private renderActive(
    entry: QuestProgressEntry,
    def: QuestDefinition | undefined,
    resolutions: QuestResolutions,
    unlocked: ReadonlySet<string>,
    style: CardStyle = {},
  ): string {
    const ready = entry.status === 'ready';
    const objectives = (def?.objectives ?? []).map((obj, i) => {
      const progress = entry.progress[i] ?? 0;
      const done = progress >= getObjectiveTarget(obj);
      return `<div class="quest-objective${done ? ' quest-objective-done' : ''}">${done ? '✓' : '•'} ${objectiveText(obj, progress, resolutions)}${objectiveBarHtml(obj, progress)}</div>`;
    }).join('');
    const name = def ? (style.main ? questTitle(def) : def.name) : UNKNOWN_QUEST;
    const classes = ['quest-card', ready ? 'quest-card-ready' : '', style.main ? 'quest-card-main' : ''].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-quest-id="${escapeHtml(entry.questId)}">
        <div class="quest-card-header">
          <span class="quest-card-name">${escapeHtml(name)}</span>
          <span class="quest-log-pills">
            <span class="quest-pill quest-status-${entry.status}">${statusLabel(entry.status)}</span>
            ${def ? scopeBadgeHtml(def.scope) : ''}
          </span>
        </div>
        ${style.leadsTo ? `<div class="quest-card-leads">Needed for the main story (${escapeHtml(questTitle({ name: style.leadsTo }))})</div>` : ''}
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
        <span class="quest-log-turnin-label">Turn in to:</span> ${locations.map(loc => this.locationHtml(loc)).join(' <span class="quest-log-or">or</span> ')}
      </div>
    `;
  }

  /** A button when the room is on this map and someone can take us there; otherwise just the words. */
  private locationHtml(loc: NpcLocation): string {
    const text = locationText(loc);
    if (!this.onGoToRoom || !loc.roomId || loc.mapId !== this.currentMapId) return text;
    return `<button type="button" class="quest-log-go" data-room-id="${escapeHtml(loc.roomId)}">${text}</button>`;
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
  const text = where ? `${who} — ${escapeHtml(where)}` : who;
  return loc.main ? `<span class="quest-log-giver-main"><span class="quest-pill quest-pill-main">Main</span> ${text}</span>` : text;
}

function levelText(level: number | undefined): string {
  return level ? `level ${level}` : 'a higher level';
}

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

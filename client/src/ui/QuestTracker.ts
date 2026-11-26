import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { escapeHtml } from './ItemIcon';
import { trackerLine, type TrackerLine, type TrackerLookups } from './QuestTrackerModel';
import { deferWhilePressed, setHtml } from './render';

export interface QuestTrackerActions {
  openQuestLog(): void;
  showRoom(roomId: string): void;
}

export interface QuestTrackerLookups extends TrackerLookups {
  getTileOn(mapId: string, col: number, row: number): { id: string; npcId?: string } | undefined;
}

/** The current main-story goal as one button. See docs/architecture/client.md → Battle tracker. */
export class QuestTracker {
  private line: TrackerLine | null = null;
  private actions: QuestTrackerActions | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly gameClient: GameClient,
    private readonly lookups: QuestTrackerLookups,
  ) {
    root.hidden = true;
    root.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('.quest-tracker')) this.activate();
    });
    gameClient.subscribe(() => {
      deferWhilePressed(root, () => this.render(this.gameClient.lastState));
    }, { replay: true });
  }

  setActions(actions: QuestTrackerActions): void {
    this.actions = actions;
  }

  private render(state: ServerStateMessage | null): void {
    this.line = trackerLine(state, this.lookups);
    this.root.hidden = !this.line;
    setHtml(this.root, this.line ? trackerHtml(this.line) : '');
  }

  private activate(): void {
    const line = this.line;
    const actions = this.actions;
    if (!line || !actions) return;
    const { action } = line;
    if (action.type === 'room') {
      actions.showRoom(action.roomId);
      return;
    }
    const roomId = action.type === 'npc' ? this.npcRoomId(action.npcId) : undefined;
    if (roomId) actions.showRoom(roomId);
    else actions.openQuestLog();
  }

  /** The party's own room when the NPC stands there, else one of the NPC's rooms on this map. */
  private npcRoomId(npcId: string): string | undefined {
    const state = this.gameClient.lastState;
    const mapId = state?.currentMapId;
    if (!state || !mapId) return undefined;
    const here = this.lookups.getTileOn(mapId, state.party.col, state.party.row);
    if (here?.npcId === npcId) return here.id;
    return this.lookups.getRoomsWithNpc(npcId).find(room => room.mapId === mapId)?.id;
  }
}

function trackerHtml(line: TrackerLine): string {
  const label = line.kind === 'main' ? `<span class="quest-tracker-label">Main</span>` : '';
  const detail = line.detail ? `<span class="quest-tracker-detail">${escapeHtml(line.detail)}</span>` : '';
  const spoken = [line.kind === 'main' ? 'Main story' : '', line.title, line.detail].filter(Boolean).join(': ');
  return `<button type="button" class="quest-tracker" data-kind="${line.kind}" aria-label="${escapeHtml(spoken)}">`
    + `${label}<span class="quest-tracker-title">${escapeHtml(line.title)}</span>${detail}</button>`;
}

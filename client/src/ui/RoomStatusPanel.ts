import type { DungeonRunInfo } from '@idle-party-rpg/shared';
import { ROOM_ICONS, actionLabel, questPipClass } from './RoomActions';
import type { RoomAction } from './RoomActions';
import { deferWhilePressed } from './render';

export interface RoomStatus {
  zoneName: string;
  roomName: string;
  actions: RoomAction[];
  /** Players outside the viewer's party standing in the same room. */
  othersHere: number;
  dungeonRun?: Pick<DungeonRunInfo, 'name' | 'floor' | 'totalFloors'>;
}

interface Chip {
  icon: string;
  label: string;
  /** Stands in for the label where labels are hidden (mobile). */
  badge?: string;
  detail?: string;
  pip?: string;
  onClick?: () => void;
}

/** What the party's current room offers, as tappable chips over the map. */
export class RoomStatusPanel {
  private el: HTMLElement;
  private onAction: (action: RoomAction) => void;
  private onShowPlayers: () => void;
  private chips: Chip[] = [];
  private renderedKey: string | null = null;

  constructor(parent: HTMLElement, onAction: (action: RoomAction) => void, onShowPlayers: () => void) {
    this.onAction = onAction;
    this.onShowPlayers = onShowPlayers;

    this.el = document.createElement('div');
    this.el.className = 'room-status';
    this.el.style.display = 'none';
    const stop = (e: Event) => { e.stopPropagation(); };
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'] as const) {
      this.el.addEventListener(ev, stop);
    }
    this.el.addEventListener('click', (e) => {
      const chipEl = (e.target as HTMLElement).closest('[data-chip-index]');
      if (chipEl) this.chips[Number(chipEl.getAttribute('data-chip-index'))]?.onClick?.();
    });
    parent.appendChild(this.el);
  }

  update(status: RoomStatus | null): void {
    deferWhilePressed(this.el, () => this.apply(status));
  }

  private apply(status: RoomStatus | null): void {
    const key = status ? JSON.stringify(status) : null;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    if (!status) {
      this.chips = [];
      this.el.style.display = 'none';
      this.el.replaceChildren();
      return;
    }

    this.chips = this.buildChips(status);
    this.el.style.display = '';
    this.el.dataset.empty = this.chips.length === 0 ? '1' : '0';

    const header = document.createElement('div');
    header.className = 'room-status-header';
    header.textContent = `${status.zoneName} · ${status.roomName}`;

    const list = document.createElement('div');
    list.className = 'room-status-chips';
    this.chips.forEach((chip, i) => list.appendChild(this.renderChip(chip, i)));

    this.el.replaceChildren(header, list);
  }

  private buildChips(status: RoomStatus): Chip[] {
    const chips: Chip[] = status.actions.map(action => ({
      icon: action.icon,
      label: actionLabel(action),
      detail: action.detail,
      pip: questPipClass(action),
      onClick: () => this.onAction(action),
    }));
    if (status.othersHere > 0) {
      const n = status.othersHere;
      chips.push({
        icon: ROOM_ICONS.players,
        label: `${n} ${n === 1 ? 'player' : 'players'} here`,
        badge: String(n),
        onClick: () => this.onShowPlayers(),
      });
    }
    if (status.dungeonRun) {
      const { name, floor, totalFloors } = status.dungeonRun;
      chips.push({
        icon: ROOM_ICONS.dungeon,
        label: `${name} · Floor ${floor}/${totalFloors}`,
        badge: `${floor}/${totalFloors}`,
      });
    }
    return chips;
  }

  private renderChip(chip: Chip, index: number): HTMLElement {
    const el = document.createElement(chip.onClick ? 'button' : 'div');
    el.className = chip.onClick ? 'room-status-chip' : 'room-status-chip room-status-chip-static';
    if (chip.onClick) {
      (el as HTMLButtonElement).type = 'button';
      el.dataset.chipIndex = String(index);
    }
    const description = chip.detail ? `${chip.label} · ${chip.detail}` : chip.label;
    el.title = description;
    el.setAttribute('aria-label', description);

    const icon = document.createElement('span');
    icon.className = chip.pip ? `room-status-chip-icon ${chip.pip}` : 'room-status-chip-icon';
    icon.textContent = chip.icon;
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'room-status-chip-label';
    label.textContent = chip.label;
    el.append(icon, label);

    if (chip.badge) {
      const badge = document.createElement('span');
      badge.className = 'room-status-chip-badge';
      badge.textContent = chip.badge;
      badge.setAttribute('aria-hidden', 'true');
      el.appendChild(badge);
    }
    return el;
  }
}

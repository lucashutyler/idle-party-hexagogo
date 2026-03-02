import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { ITEMS, EQUIP_SLOTS, getItemEffectText } from '@idle-party-rpg/shared';
import type { EquipSlot } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  chest: 'Chest',
  hand: 'Hand',
  foot: 'Foot',
};

const RARITY_COLORS: Record<string, string> = {
  janky: '#808080',
  common: '#e8e8e8',
};

export class ItemsScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  private slotsContainer!: HTMLElement;
  private inventoryList!: HTMLElement;

  private unsubscribe?: () => void;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    this.buildDOM();
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });

    const state = this.gameClient.lastState;
    if (state) {
      this.updateFromState(state);
    }
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="items-content">
        <div class="items-section-label">Equipment</div>
        <div class="items-equip-slots"></div>
        <div class="items-section-label">Inventory</div>
        <div class="items-inventory"></div>
      </div>
    `;

    this.slotsContainer = this.container.querySelector('.items-equip-slots')!;
    this.inventoryList = this.container.querySelector('.items-inventory')!;
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    // Render equipment slots
    this.slotsContainer.innerHTML = EQUIP_SLOTS.map(slot => {
      const itemId = char.equipment[slot];
      const def = itemId ? ITEMS[itemId] : null;
      const name = def ? def.name : 'Empty';
      const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '';
      const emptyClass = def ? '' : ' empty';
      const effect = def ? getItemEffectText(def) : '';
      return `<div class="items-equip-slot${emptyClass}" data-slot="${slot}">
        <span class="items-slot-label">${SLOT_LABELS[slot]}</span>
        <span class="items-slot-item" style="${def ? `color: ${color}` : ''}">${name}</span>
        ${effect ? `<span class="items-slot-effect">${effect}</span>` : ''}
      </div>`;
    }).join('');

    // Wire slot tap → unequip
    for (const slotEl of this.slotsContainer.querySelectorAll('.items-equip-slot')) {
      slotEl.addEventListener('click', () => {
        const slot = slotEl.getAttribute('data-slot');
        if (slot && char.equipment[slot]) {
          this.gameClient.sendUnequipItem(slot);
        }
      });
    }

    // Render inventory
    const entries = Object.entries(char.inventory).filter(([, count]) => count > 0);
    if (entries.length === 0) {
      this.inventoryList.innerHTML = '<div class="items-empty">No items yet</div>';
      return;
    }

    this.inventoryList.innerHTML = entries.map(([itemId, count]) => {
      const def = ITEMS[itemId];
      if (!def) return '';
      const color = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
      const equippable = def.equipSlot ? ' equippable' : '';
      const effect = getItemEffectText(def);
      return `<div class="items-row${equippable}" data-item="${itemId}">
        <div class="items-row-info">
          <span class="items-row-name" style="color: ${color}">${def.name}</span>
          <span class="items-row-effect">${effect}</span>
        </div>
        <span class="items-row-count" style="color: ${color}">x${count}</span>
      </div>`;
    }).join('');

    // Wire inventory tap → equip
    for (const rowEl of this.inventoryList.querySelectorAll('.items-row.equippable')) {
      rowEl.addEventListener('click', () => {
        const itemId = rowEl.getAttribute('data-item');
        if (itemId) {
          this.gameClient.sendEquipItem(itemId);
        }
      });
    }
  }
}

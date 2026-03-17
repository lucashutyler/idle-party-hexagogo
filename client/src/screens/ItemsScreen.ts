import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ServerEquipBlockedMessage } from '@idle-party-rpg/shared';
import { EQUIP_SLOTS, getItemEffectText } from '@idle-party-rpg/shared';
import type { EquipSlot, ItemDefinition } from '@idle-party-rpg/shared';
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
  private modalOverlay!: HTMLElement;

  private unsubscribe?: () => void;
  private unsubEquipBlocked?: () => void;

  /** Cached item definitions from last state update. */
  private itemDefs: Record<string, ItemDefinition> = {};

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

    this.unsubEquipBlocked = this.gameClient.onEquipBlocked((msg) => {
      if (this.isActive) this.showEquipBlockedModal(msg);
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
    this.unsubEquipBlocked?.();
    this.unsubEquipBlocked = undefined;
    this.hideModal();
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="items-content">
        <div class="items-section-label">Equipment</div>
        <div class="items-equip-slots"></div>
        <div class="items-section-label">Inventory</div>
        <div class="items-inventory"></div>
      </div>
      <div class="items-modal-overlay" style="display:none"></div>
    `;

    this.slotsContainer = this.container.querySelector('.items-equip-slots')!;
    this.inventoryList = this.container.querySelector('.items-inventory')!;
    this.modalOverlay = this.container.querySelector('.items-modal-overlay')!;

    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideModal();
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.itemDefs = state.itemDefinitions ?? {};

    // Render equipment slots
    this.slotsContainer.innerHTML = EQUIP_SLOTS.map(slot => {
      const itemId = char.equipment[slot];
      const def = itemId ? this.itemDefs[itemId] : null;
      const name = def ? def.name : 'Empty';
      const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '';
      const emptyClass = def ? '' : ' empty';
      const effect = def ? getItemEffectText(def) : '';
      return `<div class="items-equip-slot${emptyClass}" data-slot="${slot}">
        <div class="items-slot-main">
          <span class="items-slot-label">${SLOT_LABELS[slot]}</span>
          <span class="items-slot-item" style="${def ? `color: ${color}` : ''}">${name}</span>
          ${effect ? `<span class="items-slot-effect">${effect}</span>` : ''}
        </div>
        ${def ? `<button class="items-destroy-btn" data-destroy-slot="${slot}" title="Destroy">X</button>` : ''}
      </div>`;
    }).join('');

    // Wire slot tap → unequip (but not on destroy button)
    for (const slotEl of this.slotsContainer.querySelectorAll('.items-equip-slot')) {
      slotEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('items-destroy-btn')) return;
        const slot = slotEl.getAttribute('data-slot');
        if (slot && char.equipment[slot]) {
          this.gameClient.sendUnequipItem(slot);
        }
      });
    }

    // Wire destroy buttons on equipment
    for (const btn of this.slotsContainer.querySelectorAll('.items-destroy-btn')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slot = (btn as HTMLElement).getAttribute('data-destroy-slot');
        if (!slot) return;
        const itemId = char.equipment[slot];
        const def = itemId ? this.itemDefs[itemId] : null;
        this.showConfirmModal(
          `Destroy ${def?.name ?? 'item'}?`,
          'This item will be permanently lost.',
          () => { this.gameClient.sendDestroyEquipped(slot); this.hideModal(); }
        );
      });
    }

    // Render inventory
    const entries = Object.entries(char.inventory).filter(([, count]) => count > 0);
    if (entries.length === 0) {
      this.inventoryList.innerHTML = '<div class="items-empty">No items yet</div>';
      return;
    }

    this.inventoryList.innerHTML = entries.map(([itemId, count]) => {
      const def = this.itemDefs[itemId];
      if (!def) return '';
      const color = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
      const equippable = def.equipSlot ? ' equippable' : '';
      const effect = getItemEffectText(def);
      return `<div class="items-row${equippable}" data-item="${itemId}">
        <div class="items-row-info">
          <span class="items-row-name" style="color: ${color}">${def.name}</span>
          <span class="items-row-effect">${effect}</span>
        </div>
        <div class="items-row-actions">
          <span class="items-row-count" style="color: ${color}">x${count}</span>
          <button class="items-destroy-btn" data-destroy-item="${itemId}" data-destroy-max="${count}" title="Destroy">X</button>
        </div>
      </div>`;
    }).join('');

    // Wire inventory tap → equip (but not on destroy button)
    for (const rowEl of this.inventoryList.querySelectorAll('.items-row.equippable')) {
      rowEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('items-destroy-btn')) return;
        const itemId = rowEl.getAttribute('data-item');
        if (itemId) {
          this.gameClient.sendEquipItem(itemId);
        }
      });
    }

    // Wire destroy buttons on inventory items
    for (const btn of this.inventoryList.querySelectorAll('.items-destroy-btn')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemId = (btn as HTMLElement).getAttribute('data-destroy-item');
        const max = parseInt((btn as HTMLElement).getAttribute('data-destroy-max') ?? '1', 10);
        if (!itemId) return;
        const def = this.itemDefs[itemId];
        if (max === 1) {
          this.showConfirmModal(
            `Destroy ${def?.name ?? 'item'}?`,
            'This item will be permanently lost.',
            () => { this.gameClient.sendDestroyItems(itemId, 1); this.hideModal(); }
          );
        } else {
          this.showDestroyCountModal(itemId, def?.name ?? 'item', max);
        }
      });
    }
  }

  private showConfirmModal(title: string, message: string, onConfirm: () => void): void {
    this.modalOverlay.innerHTML = `
      <div class="items-modal">
        <div class="items-modal-title">${title}</div>
        <div class="items-modal-text">${message}</div>
        <div class="items-modal-actions">
          <button class="items-modal-btn items-modal-confirm">Destroy</button>
          <button class="items-modal-btn items-modal-cancel">Cancel</button>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';

    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', onConfirm);
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showDestroyCountModal(itemId: string, itemName: string, max: number): void {
    this.modalOverlay.innerHTML = `
      <div class="items-modal">
        <div class="items-modal-title">Destroy ${itemName}</div>
        <div class="items-modal-text">How many? (1-${max})</div>
        <div class="items-modal-count-row">
          <button class="items-modal-btn items-modal-minus">-</button>
          <span class="items-modal-count-value">1</span>
          <button class="items-modal-btn items-modal-plus">+</button>
          <button class="items-modal-btn items-modal-max">Max</button>
        </div>
        <div class="items-modal-actions">
          <button class="items-modal-btn items-modal-confirm">Destroy</button>
          <button class="items-modal-btn items-modal-cancel">Cancel</button>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';

    const countEl = this.modalOverlay.querySelector('.items-modal-count-value') as HTMLElement;
    let count = 1;
    const updateCount = (n: number) => {
      count = Math.max(1, Math.min(max, n));
      countEl.textContent = String(count);
    };

    this.modalOverlay.querySelector('.items-modal-minus')!.addEventListener('click', () => updateCount(count - 1));
    this.modalOverlay.querySelector('.items-modal-plus')!.addEventListener('click', () => updateCount(count + 1));
    this.modalOverlay.querySelector('.items-modal-max')!.addEventListener('click', () => updateCount(max));
    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', () => {
      this.gameClient.sendDestroyItems(itemId, count);
      this.hideModal();
    });
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showEquipBlockedModal(msg: ServerEquipBlockedMessage): void {
    const newDef = this.itemDefs[msg.itemId];
    const oldDef = this.itemDefs[msg.blockedByItemId];
    const newName = newDef?.name ?? 'item';
    const oldName = oldDef?.name ?? 'item';

    this.showConfirmModal(
      'Inventory full!',
      `Destroy equipped ${oldName} to equip ${newName}?`,
      () => {
        this.gameClient.sendEquipItemForceDestroy(msg.itemId);
        this.hideModal();
      }
    );
  }

  private hideModal(): void {
    this.modalOverlay.style.display = 'none';
    this.modalOverlay.innerHTML = '';
  }
}

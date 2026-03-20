import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ServerEquipBlockedMessage } from '@idle-party-rpg/shared';
import { getItemEffectText, CLASS_ICONS, UNKNOWN_CLASS_ICON } from '@idle-party-rpg/shared';
import type { EquipSlot, ItemDefinition } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  shoulders: 'Shoulders',
  chest: 'Chest',
  bracers: 'Bracers',
  gloves: 'Hands',
  mainhand: 'Main Hand',
  offhand: 'Offhand',
  foot: 'Feet',
  ring: 'Ring',
  necklace: 'Necklace',
  back: 'Back',
  relic: 'Relic',
};

/** Left column slots (top to bottom). */
const LEFT_SLOTS: EquipSlot[] = ['head', 'shoulders', 'chest', 'gloves', 'foot'];

/** Right column slots (top to bottom). */
const RIGHT_SLOTS: EquipSlot[] = ['back', 'necklace', 'bracers', 'ring', 'relic'];


const RARITY_COLORS: Record<string, string> = {
  janky: '#808080',
  common: '#e8e8e8',
  uncommon: '#66bb6a',
  rare: '#4fc3f7',
  epic: '#ee66e3',
  legendary: '#9233df',
  heirloom: '#e9bc18',
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

  /** Change detection key — only re-render when items actually change. */
  private lastRenderedKey = '';

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
        <div class="items-equip-panel">
          <div class="items-equip-col items-equip-left"></div>
          <div class="items-equip-figure">
            <div class="items-figure-body">
              <div class="fig-head"></div>
              <div class="fig-neck"></div>
              <div class="fig-shoulders">
                <div class="fig-shoulder-l"></div>
                <div class="fig-torso"></div>
                <div class="fig-shoulder-r"></div>
              </div>
              <div class="fig-arms">
                <div class="fig-arm-l"></div>
                <div class="fig-waist"><span class="fig-class-icon"></span></div>
                <div class="fig-arm-r"></div>
              </div>
              <div class="fig-legs">
                <div class="fig-leg-l"></div>
                <div class="fig-leg-gap"></div>
                <div class="fig-leg-r"></div>
              </div>
              <div class="fig-feet">
                <div class="fig-foot-l"></div>
                <div class="fig-foot-gap"></div>
                <div class="fig-foot-r"></div>
              </div>
            </div>
          </div>
          <div class="items-equip-col items-equip-right"></div>
          <div class="items-equip-bottom-left"></div>
          <div class="items-equip-bottom-spacer"></div>
          <div class="items-equip-bottom-right"></div>
        </div>
        <div class="items-section-label">Inventory</div>
        <div class="items-inventory"></div>
      </div>
      <div class="items-modal-overlay" style="display:none"></div>
    `;

    this.slotsContainer = this.container.querySelector('.items-equip-panel')!;
    this.inventoryList = this.container.querySelector('.items-inventory')!;
    this.modalOverlay = this.container.querySelector('.items-modal-overlay')!;

    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideModal();
    });

    // Delegated click handler for equipment slots → unequip (covers panel + bottom row)
    const handleSlotClick = (e: Event) => {
      const slotEl = (e.target as HTMLElement).closest('.items-equip-slot[data-slot]') as HTMLElement | null;
      if (!slotEl) return;
      const slot = slotEl.getAttribute('data-slot');
      if (slot) this.gameClient.sendUnequipItem(slot);
    };
    this.slotsContainer.addEventListener('click', handleSlotClick);

    // Delegated click handler for inventory rows → equip or destroy
    this.inventoryList.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Destroy button
      const destroyBtn = target.closest('.items-destroy-btn') as HTMLElement | null;
      if (destroyBtn) {
        e.stopPropagation();
        const itemId = destroyBtn.getAttribute('data-destroy-item');
        const max = parseInt(destroyBtn.getAttribute('data-destroy-max') ?? '1', 10);
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
        return;
      }

      // Equippable row tap → equip
      const row = target.closest('.items-row.equippable[data-item]') as HTMLElement | null;
      if (row) {
        const itemId = row.getAttribute('data-item');
        if (itemId) this.gameClient.sendEquipItem(itemId);
      }
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.itemDefs = state.itemDefinitions ?? {};

    // Only re-render when equipment or inventory actually changed
    const key = JSON.stringify({ e: char.equipment, i: char.inventory });
    if (key === this.lastRenderedKey) return;
    this.lastRenderedKey = key;

    // Render equipment slots into left/right columns around the figure
    const renderSlot = (slot: EquipSlot) => {
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
          <span class="items-slot-effect">${effect || '&nbsp;'}</span>
        </div>
      </div>`;
    };

    const leftCol = this.slotsContainer.querySelector('.items-equip-left')!;
    const rightCol = this.slotsContainer.querySelector('.items-equip-right')!;
    const bottomLeft = this.slotsContainer.querySelector('.items-equip-bottom-left')!;
    const bottomRight = this.slotsContainer.querySelector('.items-equip-bottom-right')!;
    leftCol.innerHTML = LEFT_SLOTS.map(renderSlot).join('');
    rightCol.innerHTML = RIGHT_SLOTS.map(renderSlot).join('');
    bottomLeft.innerHTML = renderSlot('mainhand');
    bottomRight.innerHTML = renderSlot('offhand');

    // Update class icon on the silhouette
    const iconEl = this.container.querySelector('.fig-class-icon');
    if (iconEl) {
      iconEl.textContent = CLASS_ICONS[char.className] ?? UNKNOWN_CLASS_ICON;
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
      const slotText = def.equipSlot ? SLOT_LABELS[def.equipSlot] : 'Material';
      return `<div class="items-row${equippable}" data-item="${itemId}">
        <div class="items-row-info">
          <span class="items-row-name" style="color: ${color}">${def.name}</span>
          <span class="items-row-effect">${slotText}${effect ? ' \u2022 ' + effect : ''}</span>
        </div>
        <div class="items-row-actions">
          <span class="items-row-count" style="color: ${color}">x${count}</span>
          <button class="items-destroy-btn" data-destroy-item="${itemId}" data-destroy-max="${count}" title="Destroy">X</button>
        </div>
      </div>`;
    }).join('');
    // All click handlers are delegated via buildDOM() — no per-element wiring needed.
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

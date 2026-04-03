import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ServerEquipBlockedMessage } from '@idle-party-rpg/shared';
import { getItemEffectText, CLASS_ICONS, UNKNOWN_CLASS_ICON, getSetInfoForItem, getSetBonusText } from '@idle-party-rpg/shared';
import type { EquipSlot, ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  shoulders: 'Shoulders',
  chest: 'Chest',
  bracers: 'Bracers',
  gloves: 'Hands',
  mainhand: 'Main Hand',
  offhand: 'Offhand',
  twohanded: 'Two-Handed',
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

const EMPTY_SLOT_COLOR = '#333333';

const SLOT_ICONS: Record<string, string> = {
  head: 'H', shoulders: 'S', chest: 'C', bracers: 'B', gloves: 'G',
  mainhand: 'M', offhand: 'O', twohanded: '2H', foot: 'F',
  ring: 'R', necklace: 'N', back: 'K', relic: 'L',
};

const SHINY_RARITIES = new Set(['epic', 'legendary', 'heirloom']);

type SortMode = 'rarity' | 'type' | 'newest';

const RARITY_ORDER: Record<string, number> = {
  heirloom: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5, janky: 6,
};

function getItemInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function injectItemsStyles(): void {
  if (document.getElementById('items-screen-styles')) return;
  const style = document.createElement('style');
  style.id = 'items-screen-styles';
  style.textContent = `
    .item-square {
      position: relative;
      aspect-ratio: 1;
      border-radius: 4px;
      cursor: pointer;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid transparent;
      box-sizing: border-box;
      min-width: 0;
    }
    .item-square-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      position: absolute;
      top: 0;
      left: 0;
    }
    .item-square-initials {
      font-size: 14px;
      font-weight: bold;
      color: rgba(255,255,255,0.85);
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      z-index: 1;
      pointer-events: none;
      text-align: center;
      line-height: 1;
    }
    .item-square-slot-icon {
      position: absolute;
      bottom: 2px;
      right: 2px;
      font-size: 8px;
      color: rgba(255,255,255,0.6);
      pointer-events: none;
      z-index: 2;
      line-height: 1;
    }
    .item-square-qty {
      position: absolute;
      top: 1px;
      right: 2px;
      font-size: 8px;
      color: #fff;
      background: rgba(0,0,0,0.6);
      padding: 0 2px;
      border-radius: 2px;
      pointer-events: none;
      z-index: 2;
      line-height: 1.2;
    }
    .item-square-set {
      position: absolute;
      top: 1px;
      left: 2px;
      font-size: 8px;
      color: #e9bc18;
      pointer-events: none;
      z-index: 2;
      line-height: 1;
    }

    @keyframes item-shiny-border {
      0%   { border-color: rgba(255,255,255,0.3); }
      50%  { border-color: rgba(255,255,255,0.9); }
      100% { border-color: rgba(255,255,255,0.3); }
    }
    .item-rarity-epic {
      animation: item-shiny-border 2.5s ease-in-out infinite;
    }
    .item-rarity-legendary {
      animation: item-shiny-border 1.8s ease-in-out infinite;
    }
    .item-rarity-heirloom {
      animation: item-shiny-border 1.2s ease-in-out infinite;
    }

    .item-popup-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .item-popup {
      background: #1a1a2e;
      border: 2px solid #444;
      border-radius: 8px;
      padding: 16px;
      max-width: 320px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      color: #e8e8e8;
    }
    .item-popup-artwork {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    .item-popup-artwork img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .item-popup-artwork .item-popup-initials {
      font-size: 28px;
      font-weight: bold;
      color: rgba(255,255,255,0.85);
      text-shadow: 1px 1px 3px rgba(0,0,0,0.8);
    }
    .item-popup-name {
      text-align: center;
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 8px;
    }
    .item-popup-stats {
      font-size: 12px;
      margin-bottom: 8px;
      line-height: 1.6;
    }
    .item-popup-stats div {
      display: flex;
      justify-content: space-between;
    }
    .item-popup-stats .stat-label {
      color: #999;
    }
    .item-popup-set-section {
      border-top: 1px solid #333;
      padding-top: 8px;
      margin-top: 8px;
      font-size: 12px;
    }
    .item-popup-set-name {
      font-weight: bold;
      color: #e9bc18;
      margin-bottom: 4px;
    }
    .item-popup-set-pieces {
      margin-bottom: 4px;
    }
    .item-popup-set-piece {
      color: #888;
      margin-left: 8px;
    }
    .item-popup-set-piece.owned {
      color: #ccc;
    }
    .item-popup-set-piece.equipped {
      color: #66bb6a;
    }
    .item-popup-set-bonus {
      color: #aaa;
      font-style: italic;
    }
    .item-popup-actions {
      margin-top: 12px;
      display: flex;
      gap: 8px;
      justify-content: center;
    }
    .item-popup-actions button {
      padding: 6px 16px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #2a2a40;
      color: #e8e8e8;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    .item-popup-actions button:hover {
      background: #3a3a55;
    }
    .item-popup-actions button.danger {
      border-color: #a33;
      color: #f88;
    }
    .item-popup-actions button.danger:hover {
      background: #4a2020;
    }

    .items-search-sort {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      align-items: center;
    }
    .items-search-sort input {
      flex: 1;
      min-width: 0;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #1a1a2e;
      color: #e8e8e8;
      font-family: inherit;
      font-size: 11px;
    }
    .items-search-sort select {
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #1a1a2e;
      color: #e8e8e8;
      font-family: inherit;
      font-size: 11px;
    }

    .items-inv-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
      gap: 4px;
    }

    .items-equip-slot-square {
      width: 40px;
      height: 40px;
    }

    @media (min-width: 768px) {
      .items-inv-grid {
        grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
        gap: 6px;
      }
      .items-equip-slot-square {
        width: 48px;
        height: 48px;
      }
      .item-square-initials {
        font-size: 16px;
      }
      .item-square-slot-icon {
        font-size: 9px;
      }
      .item-square-qty {
        font-size: 9px;
      }
      .item-popup {
        max-width: 380px;
      }
    }
  `;
  document.head.appendChild(style);
}


export class ItemsScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  private slotsContainer!: HTMLElement;
  private inventoryGrid!: HTMLElement;
  private modalOverlay!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;

  private unsubscribe?: () => void;
  private unsubEquipBlocked?: () => void;

  /** Cached item definitions from last state update. */
  private itemDefs: Record<string, ItemDefinition> = {};

  /** Cached set definitions from last state update. */
  private setDefs: Record<string, SetDefinition> = {};

  /** Cached character state for popup actions. */
  private lastEquipment: Record<string, string | null> = {};
  private lastInventory: Record<string, number> = {};

  /** Change detection key — only re-render when items actually change. */
  private lastRenderedKey = '';

  /** Search/sort filter state. */
  private searchFilter = '';
  private sortMode: SortMode = 'rarity';

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    injectItemsStyles();
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
        <div class="items-search-sort">
          <input type="text" class="items-search-input" placeholder="Search items..." />
          <select class="items-sort-select">
            <option value="rarity">Rarity</option>
            <option value="type">Type</option>
            <option value="newest">Newest</option>
          </select>
        </div>
        <div class="items-inv-grid"></div>
      </div>
      <div class="items-modal-overlay" style="display:none"></div>
    `;

    this.slotsContainer = this.container.querySelector('.items-equip-panel')!;
    this.inventoryGrid = this.container.querySelector('.items-inv-grid')!;
    this.modalOverlay = this.container.querySelector('.items-modal-overlay')!;
    this.searchInput = this.container.querySelector('.items-search-input')!;
    this.sortSelect = this.container.querySelector('.items-sort-select')!;

    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideModal();
    });

    // Search input handler
    this.searchInput.addEventListener('input', () => {
      this.searchFilter = this.searchInput.value.toLowerCase();
      this.renderInventory();
    });

    // Sort select handler
    this.sortSelect.addEventListener('change', () => {
      this.sortMode = this.sortSelect.value as SortMode;
      this.renderInventory();
    });

    // Delegated click handler for equipment slot squares
    this.slotsContainer.addEventListener('click', (e) => {
      const slotEl = (e.target as HTMLElement).closest('.items-equip-slot-square[data-slot]') as HTMLElement | null;
      if (!slotEl) return;
      const slot = slotEl.getAttribute('data-slot') as EquipSlot;
      const itemId = slotEl.getAttribute('data-item-id');
      if (slot && itemId) {
        this.showItemPopup(itemId, 'equipped', slot);
      }
    });

    // Delegated click handler for inventory grid squares
    this.inventoryGrid.addEventListener('click', (e) => {
      const square = (e.target as HTMLElement).closest('.item-square[data-item]') as HTMLElement | null;
      if (!square) return;
      const itemId = square.getAttribute('data-item');
      if (itemId) {
        this.showItemPopup(itemId, 'inventory', undefined);
      }
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.itemDefs = state.itemDefinitions ?? {};
    this.setDefs = state.setDefinitions ?? {};
    this.lastEquipment = { ...char.equipment };
    this.lastInventory = { ...char.inventory };

    // Only re-render when equipment or inventory actually changed
    const key = JSON.stringify({ e: char.equipment, i: char.inventory });
    if (key === this.lastRenderedKey) return;
    this.lastRenderedKey = key;

    this.renderEquipment(char);
    this.renderInventory();
  }

  private renderEquipment(char: { equipment: Record<string, string | null>; className: string }): void {
    const renderSlotSquare = (slot: EquipSlot) => {
      const itemId = char.equipment[slot];
      const def = itemId ? this.itemDefs[itemId] : null;
      const bgColor = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : EMPTY_SLOT_COLOR;
      const shinyClass = def && SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';
      const hasSet = def && itemId ? this.getItemSetId(itemId) : false;

      let inner = '';
      if (def) {
        const initials = getItemInitials(def.name);
        inner = `<img class="item-square-img" src="/item-artwork/${itemId}.png" onerror="this.style.display='none'" alt="">
          <span class="item-square-initials">${initials}</span>`;
        if (hasSet) inner += `<span class="item-square-set">S</span>`;
      } else {
        inner = `<span class="item-square-initials" style="color:rgba(255,255,255,0.3)">${SLOT_ICONS[slot] ?? ''}</span>`;
      }

      return `<div class="item-square items-equip-slot-square${shinyClass}" data-slot="${slot}" data-item-id="${itemId ?? ''}" title="${def ? def.name : SLOT_LABELS[slot]}" style="background:${bgColor}">${inner}</div>`;
    };

    const leftCol = this.slotsContainer.querySelector('.items-equip-left')!;
    const rightCol = this.slotsContainer.querySelector('.items-equip-right')!;
    const bottomLeft = this.slotsContainer.querySelector('.items-equip-bottom-left')!;
    const bottomRight = this.slotsContainer.querySelector('.items-equip-bottom-right')!;
    leftCol.innerHTML = LEFT_SLOTS.map(renderSlotSquare).join('');
    rightCol.innerHTML = RIGHT_SLOTS.map(renderSlotSquare).join('');
    bottomLeft.innerHTML = renderSlotSquare('mainhand');
    bottomRight.innerHTML = renderSlotSquare('offhand');

    // Update class icon on the silhouette
    const iconEl = this.container.querySelector('.fig-class-icon');
    if (iconEl) {
      iconEl.textContent = CLASS_ICONS[char.className] ?? UNKNOWN_CLASS_ICON;
    }
  }

  private renderInventory(): void {
    const entries = Object.entries(this.lastInventory).filter(([, count]) => count > 0);
    if (entries.length === 0) {
      this.inventoryGrid.innerHTML = '<div class="items-empty" style="grid-column:1/-1">No items yet</div>';
      return;
    }

    // Filter by search
    let filtered = entries;
    if (this.searchFilter) {
      filtered = filtered.filter(([id]) => {
        const def = this.itemDefs[id];
        return def && def.name.toLowerCase().includes(this.searchFilter);
      });
    }

    // Sort
    filtered = [...filtered];
    if (this.sortMode === 'rarity') {
      filtered.sort(([aId], [bId]) => {
        const aDef = this.itemDefs[aId];
        const bDef = this.itemDefs[bId];
        const aRank = RARITY_ORDER[aDef?.rarity ?? 'common'] ?? 5;
        const bRank = RARITY_ORDER[bDef?.rarity ?? 'common'] ?? 5;
        return aRank - bRank;
      });
    } else if (this.sortMode === 'type') {
      const SLOT_ORDER: Record<string, number> = {
        head: 0, shoulders: 1, chest: 2, bracers: 3, gloves: 4,
        mainhand: 5, offhand: 6, twohanded: 7, foot: 8,
        ring: 9, necklace: 10, back: 11, relic: 12,
      };
      filtered.sort(([aId], [bId]) => {
        const aDef = this.itemDefs[aId];
        const bDef = this.itemDefs[bId];
        const aSlot = aDef?.equipSlot ? (SLOT_ORDER[aDef.equipSlot] ?? 99) : 100;
        const bSlot = bDef?.equipSlot ? (SLOT_ORDER[bDef.equipSlot] ?? 99) : 100;
        return aSlot - bSlot;
      });
    }
    // 'newest' keeps original order

    if (filtered.length === 0) {
      this.inventoryGrid.innerHTML = '<div class="items-empty" style="grid-column:1/-1">No matches</div>';
      return;
    }

    this.inventoryGrid.innerHTML = filtered.map(([itemId, count]) => {
      const def = this.itemDefs[itemId];
      if (!def) return '';
      const bgColor = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
      const shinyClass = SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';
      const initials = getItemInitials(def.name);
      const slotIcon = def.equipSlot ? (SLOT_ICONS[def.equipSlot] ?? '') : '';
      const hasSet = this.getItemSetId(itemId);

      let inner = `<img class="item-square-img" src="/item-artwork/${itemId}.png" onerror="this.style.display='none'" alt="">
        <span class="item-square-initials">${initials}</span>`;
      if (hasSet) inner += `<span class="item-square-set">S</span>`;
      if (count > 1) inner += `<span class="item-square-qty">${count}</span>`;
      if (slotIcon) inner += `<span class="item-square-slot-icon">${slotIcon}</span>`;

      return `<div class="item-square${shinyClass}" data-item="${itemId}" title="${def.name}" style="background:${bgColor}">${inner}</div>`;
    }).join('');
  }

  private getItemSetId(itemId: string): string | null {
    for (const set of Object.values(this.setDefs)) {
      if (set.itemIds.includes(itemId)) return set.id;
    }
    return null;
  }

  private showItemPopup(itemId: string, context: 'equipped' | 'inventory', equippedSlot?: EquipSlot): void {
    const def = this.itemDefs[itemId];
    if (!def) return;

    const bgColor = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
    const rarityColor = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
    const initials = getItemInitials(def.name);

    // Build stat lines
    const statLines: string[] = [];
    const effect = getItemEffectText(def);
    if (effect && effect !== 'Material' && effect !== 'No bonus') {
      statLines.push(`<div><span class="stat-label">Effect</span><span>${effect}</span></div>`);
    }
    if (def.equipSlot) {
      statLines.push(`<div><span class="stat-label">Slot</span><span>${SLOT_LABELS[def.equipSlot] ?? def.equipSlot}</span></div>`);
    } else {
      statLines.push(`<div><span class="stat-label">Type</span><span>Material</span></div>`);
    }
    statLines.push(`<div><span class="stat-label">Rarity</span><span style="color:${rarityColor}">${def.rarity.charAt(0).toUpperCase() + def.rarity.slice(1)}</span></div>`);
    if (def.value != null && def.value > 0) {
      statLines.push(`<div><span class="stat-label">Value</span><span>${def.value}g</span></div>`);
    }
    if (def.classRestriction && def.classRestriction.length > 0) {
      statLines.push(`<div><span class="stat-label">Class</span><span>${def.classRestriction.join(', ')}</span></div>`);
    }

    // Set info
    const ownedItemIds = new Set<string>(
      Object.entries(this.lastInventory).filter(([, c]) => c > 0).map(([id]) => id)
    );
    const equippedItemIds = new Set<string>(
      Object.values(this.lastEquipment).filter((id): id is string => id != null)
    );
    // Owned should also include equipped items
    for (const eid of equippedItemIds) ownedItemIds.add(eid);

    const setInfo = getSetInfoForItem(itemId, this.setDefs, ownedItemIds, equippedItemIds);
    let setHtml = '';
    if (setInfo) {
      const piecesHtml = setInfo.set.itemIds.map(pieceId => {
        const pieceDef = this.itemDefs[pieceId];
        const pieceName = pieceDef?.name ?? pieceId;
        const isEquipped = equippedItemIds.has(pieceId);
        const isOwned = ownedItemIds.has(pieceId);
        const cssClass = isEquipped ? 'equipped' : isOwned ? 'owned' : '';
        const check = isOwned ? (isEquipped ? '&#9745; ' : '&#9744; ') : '&#9744; ';
        return `<div class="item-popup-set-piece ${cssClass}">${check}${pieceName}</div>`;
      }).join('');
      const bonusText = getSetBonusText(setInfo.set.bonuses);
      setHtml = `
        <div class="item-popup-set-section">
          <div class="item-popup-set-name">${setInfo.set.name} (${setInfo.equippedCount}/${setInfo.set.itemIds.length})</div>
          <div class="item-popup-set-pieces">${piecesHtml}</div>
          <div class="item-popup-set-bonus">Set bonus: ${bonusText}</div>
        </div>`;
    }

    // Action buttons
    const count = this.lastInventory[itemId] ?? 0;
    let actionsHtml = '';
    if (context === 'equipped' && equippedSlot) {
      actionsHtml = `<button class="popup-action-unequip" data-slot="${equippedSlot}">Unequip</button>`;
    } else if (context === 'inventory') {
      if (def.equipSlot) {
        actionsHtml += `<button class="popup-action-equip" data-item="${itemId}">Equip</button>`;
      }
      actionsHtml += `<button class="popup-action-destroy danger" data-item="${itemId}" data-max="${count}">Destroy</button>`;
    }

    const shinyClass = SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';

    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">
          <div class="item-popup-artwork${shinyClass}" style="background:${bgColor}">
            <img src="/item-artwork/${itemId}.png" onerror="this.style.display='none'" alt="">
            <span class="item-popup-initials">${initials}</span>
          </div>
          <div class="item-popup-name" style="color:${rarityColor}">${def.name}</div>
          <div class="item-popup-stats">${statLines.join('')}</div>
          ${setHtml}
          <div class="item-popup-actions">${actionsHtml}</div>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';

    // Wire popup action buttons
    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) this.hideModal();
    });

    const unequipBtn = this.modalOverlay.querySelector('.popup-action-unequip') as HTMLElement | null;
    if (unequipBtn) {
      unequipBtn.addEventListener('click', () => {
        const slot = unequipBtn.getAttribute('data-slot');
        if (slot) this.gameClient.sendUnequipItem(slot);
        this.hideModal();
      });
    }

    const equipBtn = this.modalOverlay.querySelector('.popup-action-equip') as HTMLElement | null;
    if (equipBtn) {
      equipBtn.addEventListener('click', () => {
        const id = equipBtn.getAttribute('data-item');
        if (id) this.gameClient.sendEquipItem(id);
        this.hideModal();
      });
    }

    const destroyBtn = this.modalOverlay.querySelector('.popup-action-destroy') as HTMLElement | null;
    if (destroyBtn) {
      destroyBtn.addEventListener('click', () => {
        const id = destroyBtn.getAttribute('data-item')!;
        const max = parseInt(destroyBtn.getAttribute('data-max') ?? '1', 10);
        const dDef = this.itemDefs[id];
        if (max === 1) {
          this.showConfirmModal(
            `Destroy ${dDef?.name ?? 'item'}?`,
            'This item will be permanently lost.',
            () => { this.gameClient.sendDestroyItems(id, 1); this.hideModal(); }
          );
        } else {
          this.showDestroyCountModal(id, dDef?.name ?? 'item', max);
        }
      });
    }
  }

  private showConfirmModal(title: string, message: string, onConfirm: () => void): void {
    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">
          <div class="item-popup-name">${title}</div>
          <div class="item-popup-stats" style="text-align:center">${message}</div>
          <div class="item-popup-actions">
            <button class="items-modal-confirm danger">Destroy</button>
            <button class="items-modal-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';

    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) this.hideModal(); });

    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', onConfirm);
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showDestroyCountModal(itemId: string, itemName: string, max: number): void {
    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">
          <div class="item-popup-name">Destroy ${itemName}</div>
          <div class="item-popup-stats" style="text-align:center">How many? (1-${max})</div>
          <div class="items-modal-count-row" style="display:flex;gap:8px;justify-content:center;align-items:center;margin:8px 0">
            <button class="items-modal-minus" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">-</button>
            <span class="items-modal-count-value" style="min-width:24px;text-align:center">1</span>
            <button class="items-modal-plus" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">+</button>
            <button class="items-modal-max" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">Max</button>
          </div>
          <div class="item-popup-actions">
            <button class="items-modal-confirm danger">Destroy</button>
            <button class="items-modal-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';

    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) this.hideModal(); });

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

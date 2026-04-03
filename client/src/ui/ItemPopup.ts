import type { ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import { getItemEffectText, getSetInfoForItem, getSetBonusText } from '@idle-party-rpg/shared';
import { RARITY_COLORS, SLOT_LABELS, SHINY_RARITIES, getItemInitials, escapeHtml } from './ItemIcon';

export interface ItemPopupOptions {
  /** Item definitions for looking up set piece names */
  itemDefs?: Record<string, ItemDefinition>;
  setDefs?: Record<string, SetDefinition>;
  /** Set of item IDs the player owns (inventory + equipped) */
  ownedItemIds?: Set<string>;
  /** Set of item IDs currently equipped */
  equippedItemIds?: Set<string>;
  /** Action buttons HTML (empty string for read-only view) */
  actionsHtml?: string;
}

/**
 * Create the inner HTML for an item popup (without the overlay wrapper).
 * Useful for embedding in other modals.
 */
export function renderItemPopupContent(def: ItemDefinition, options?: ItemPopupOptions): string {
  const color = RARITY_COLORS[def.rarity] ?? '#e8e8e8';
  const initials = getItemInitials(def.name);
  const shinyClass = SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';

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
  statLines.push(`<div><span class="stat-label">Rarity</span><span style="color:${color}">${def.rarity.charAt(0).toUpperCase() + def.rarity.slice(1)}</span></div>`);
  if (def.value != null && def.value > 0) {
    statLines.push(`<div><span class="stat-label">Value</span><span>${def.value}g</span></div>`);
  }
  if (def.classRestriction && def.classRestriction.length > 0) {
    statLines.push(`<div><span class="stat-label">Class</span><span>${def.classRestriction.join(', ')}</span></div>`);
  }

  // Set info section
  const setDefs = options?.setDefs ?? {};
  const ownedItemIds = options?.ownedItemIds;
  const equippedItemIds = options?.equippedItemIds;
  const itemDefs = options?.itemDefs ?? {};

  const setInfo = getSetInfoForItem(def.id, setDefs, ownedItemIds, equippedItemIds);
  let setHtml = '';
  if (setInfo) {
    const piecesHtml = setInfo.set.itemIds.map(pieceId => {
      const pieceDef = itemDefs[pieceId];
      const pieceName = pieceDef?.name ?? pieceId;
      const isEquipped = equippedItemIds?.has(pieceId) ?? false;
      const isOwned = ownedItemIds?.has(pieceId) ?? false;
      const cssClass = isEquipped ? 'equipped' : isOwned ? 'owned' : '';
      const check = isOwned || isEquipped ? (isEquipped ? '&#9745; ' : '&#9744; ') : '&#9744; ';
      return `<div class="item-popup-set-piece ${cssClass}">${check}${escapeHtml(pieceName)}</div>`;
    }).join('');
    const bonusText = getSetBonusText(setInfo.set.bonuses);
    setHtml = `
      <div class="item-popup-set-section">
        <div class="item-popup-set-name">${escapeHtml(setInfo.set.name)} (${setInfo.equippedCount}/${setInfo.set.itemIds.length})</div>
        <div class="item-popup-set-pieces">${piecesHtml}</div>
        <div class="item-popup-set-bonus">Set bonus: ${bonusText}</div>
      </div>`;
  }

  const actionsHtml = options?.actionsHtml ?? '';

  return `
    <div class="item-popup-artwork${shinyClass}" style="background:${color}">
      <img src="/item-artwork/${def.id}.png" onerror="this.style.display='none'" onload="this.nextElementSibling.style.display='none'" alt="">
      <span class="item-popup-initials">${initials}</span>
    </div>
    <div class="item-popup-name" style="color:${color}">${escapeHtml(def.name)}</div>
    <div class="item-popup-stats">${statLines.join('')}</div>
    ${setHtml}
    ${actionsHtml ? `<div class="item-popup-actions">${actionsHtml}</div>` : ''}
  `;
}

/**
 * Show an item popup modal overlay. Returns the overlay element.
 * Caller is responsible for wiring action button click handlers.
 */
export function showItemPopup(def: ItemDefinition, options?: ItemPopupOptions): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'item-popup-overlay';
  overlay.innerHTML = `<div class="item-popup">${renderItemPopupContent(def, options)}</div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
  return overlay;
}

import type { ItemDefinition, SetDefinition, SkillDefinition } from '@idle-party-rpg/shared';
import { getItemEffectText, getSetsForItem, getSetBonusText, getSetDisplayName, getActiveBreakpoint, canClassEquipItem } from '@idle-party-rpg/shared';
import { RARITY_COLORS, SLOT_LABELS, SHINY_RARITIES, getItemInitials, escapeHtml } from './ItemIcon';
import { artworkUrl, renderTrackedImg } from './assets';
import { bringToFront, release } from './ModalStack';

export const ITEM_POPUP_CLOSE_HTML = '<button type="button" class="item-popup-close" aria-label="Close">&times;</button>';

export interface ItemPopupOptions {
  /** Item definitions for looking up set piece names */
  itemDefs?: Record<string, ItemDefinition>;
  setDefs?: Record<string, SetDefinition>;
  /** Set of item IDs the player owns (inventory + equipped) */
  ownedItemIds?: Set<string>;
  /** Set of item IDs currently equipped */
  equippedItemIds?: Set<string>;
  /** Skill catalog — lets effect/set-bonus lines render 'Grants skill: X' by name */
  skills?: Record<string, SkillDefinition>;
  /**
   * Class context for set filtering. When provided, only sets the class can activate
   * are shown. When omitted, every set containing the item is listed (admin / preview).
   */
  className?: string | null;
  /** Action buttons HTML (empty string for read-only view) */
  actionsHtml?: string;
  /** Extra HTML rendered between the set sections and the action buttons (e.g. the equip comparison). */
  extraHtml?: string;
}

/**
 * Create the inner HTML for an item popup (without the overlay wrapper).
 * Useful for embedding in other modals.
 */
export function renderItemPopupContent(def: ItemDefinition, options?: ItemPopupOptions): string {
  const color = RARITY_COLORS[def.rarity] ?? 'var(--text-1)';
  const artStyle = `--rarity:${color}${def.iconColor ? `;--item-bg:${escapeHtml(def.iconColor)}` : ''}`;
  const initials = getItemInitials(def.name);
  const shinyClass = SHINY_RARITIES.has(def.rarity) ? ` item-rarity-${def.rarity}` : '';

  // Build stat lines
  const statLines: string[] = [];
  const effect = getItemEffectText(def, options?.skills);
  if (effect && effect !== 'Material' && effect !== 'No bonus') {
    statLines.push(`<div><span class="stat-label">Effect</span><span>${escapeHtml(effect)}</span></div>`);
  }
  if (def.equipSlot) {
    statLines.push(`<div><span class="stat-label">Slot</span><span>${SLOT_LABELS[def.equipSlot] ?? def.equipSlot}</span></div>`);
  } else if (def.consumable) {
    statLines.push(`<div><span class="stat-label">Type</span><span>Consumable</span></div>`);
  } else {
    statLines.push(`<div><span class="stat-label">Type</span><span>Material</span></div>`);
  }
  if (def.consumable) {
    statLines.push(`<div><span class="stat-label">Use</span><span class="item-popup-coming-soon">Not usable yet — coming soon!</span></div>`);
  }
  statLines.push(`<div><span class="stat-label">Rarity</span><span style="color:${color}">${def.rarity.charAt(0).toUpperCase() + def.rarity.slice(1)}</span></div>`);
  if (def.value != null && def.value > 0) {
    statLines.push(`<div><span class="stat-label">Value</span><span>${def.value}g</span></div>`);
  }
  // Set info section — list every applicable set the item belongs to.
  const setDefs = options?.setDefs ?? {};
  const ownedItemIds = options?.ownedItemIds;
  const equippedItemIds = options?.equippedItemIds;
  const itemDefs = options?.itemDefs ?? {};
  const className = options?.className;

  if (def.classRestriction && def.classRestriction.length > 0) {
    // Color the class names: green if the viewing player can equip the item,
    // red if not. The wrapper has a data attribute so the equip-restricted
    // animation can target it for an in-place attention pulse.
    const allowed = !!className && canClassEquipItem(def, className);
    const restrictClass = allowed ? 'item-popup-class-allowed' : 'item-popup-class-denied';
    const cls = def.classRestriction.map(c => `<span class="${restrictClass}">${c}</span>`).join(', ');
    statLines.push(`<div data-class-restriction="1"><span class="stat-label">Class</span><span>${cls}</span></div>`);
  }

  const matchingSets = getSetsForItem(def.id, setDefs, className);
  const setHtmlBlocks = matchingSets.map(set => {
    let ownedCount = 0;
    let equippedCount = 0;
    for (const id of set.itemIds) {
      if (ownedItemIds?.has(id) || equippedItemIds?.has(id)) ownedCount++;
      if (equippedItemIds?.has(id)) equippedCount++;
    }

    const piecesHtml = set.itemIds.map(pieceId => {
      const pieceDef = itemDefs[pieceId];
      const pieceName = pieceDef?.name ?? pieceId;
      const isEquipped = equippedItemIds?.has(pieceId) ?? false;
      const isOwned = ownedItemIds?.has(pieceId) ?? false;
      const cssClass = isEquipped ? 'equipped' : isOwned ? 'owned' : '';
      const check = isOwned || isEquipped ? (isEquipped ? '&#9745; ' : '&#9744; ') : '&#9744; ';
      return `<div class="item-popup-set-piece ${cssClass}">${check}${escapeHtml(pieceName)}</div>`;
    }).join('');

    const activeBp = getActiveBreakpoint(set, equippedCount);
    const bps = set.breakpoints ?? [];
    const breakpointLines = bps.map(bp => {
      const isActive = activeBp && activeBp.piecesRequired === bp.piecesRequired;
      const isUnlocked = bp.piecesRequired <= equippedCount;
      const className = isActive ? 'active' : isUnlocked ? 'unlocked' : '';
      const prefix = isActive ? '&#9656; ' : isUnlocked ? '&#10003; ' : '&#9744; ';
      return `<div class="item-popup-set-bp ${className}">${prefix}${bp.piecesRequired}pc: ${escapeHtml(getSetBonusText(bp.bonuses, options?.skills))}</div>`;
    }).join('');

    const headerName = escapeHtml(getSetDisplayName(set));

    return `
      <div class="item-popup-set-section">
        <div class="item-popup-set-name">${headerName} (${equippedCount}/${set.itemIds.length})</div>
        <div class="item-popup-set-pieces">${piecesHtml}</div>
        <div class="item-popup-set-breakpoints">${breakpointLines}</div>
      </div>`;
  }).join('');

  const actionsHtml = options?.actionsHtml ?? '';
  const extraHtml = options?.extraHtml ?? '';

  const artworkInner = def.iconEmoji
    ? `<span class="item-popup-emoji">${escapeHtml(def.iconEmoji)}</span>`
    : `${renderTrackedImg(artworkUrl('item', def.id), { className: 'item-popup-img' })}<span class="item-popup-initials">${initials}</span>`;

  return `
    <div class="item-popup-artwork${shinyClass}" style="${artStyle}">
      ${artworkInner}
    </div>
    <div class="item-popup-name" style="color:${color}">${escapeHtml(def.name)}</div>
    <div class="item-popup-stats">${statLines.join('')}</div>
    ${setHtmlBlocks}
    ${extraHtml}
    ${actionsHtml ? `<div class="item-popup-actions">${actionsHtml}</div>` : ''}
  `;
}

/**
 * Show an item popup modal overlay on the modal stack. Returns the overlay element.
 * Caller is responsible for wiring action button click handlers.
 */
export function showItemPopup(def: ItemDefinition, options?: ItemPopupOptions): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'item-popup-overlay';
  overlay.innerHTML = `<div class="item-popup" role="dialog" aria-modal="true">${ITEM_POPUP_CLOSE_HTML}${renderItemPopupContent(def, options)}</div>`;

  const close = () => closeItemPopup(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || (e.target as Element).closest('.item-popup-close')) close();
  });

  document.body.appendChild(overlay);
  bringToFront(overlay, close);
  return overlay;
}

export function closeItemPopup(overlay: HTMLElement): void {
  release(overlay);
  overlay.remove();
}

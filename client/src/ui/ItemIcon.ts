import type { ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import { artworkUrl, isAssetLoaded, renderTrackedImg } from './assets';

/** CSS colour values (theme tokens) per rarity; usable in inline `color`/`background`. */
export const RARITY_COLORS: Record<string, string> = {
  janky: 'var(--rarity-janky)',
  common: 'var(--rarity-common)',
  uncommon: 'var(--rarity-uncommon)',
  rare: 'var(--rarity-rare)',
  epic: 'var(--rarity-epic)',
  legendary: 'var(--rarity-legendary)',
  heirloom: 'var(--rarity-heirloom)',
};

/** Slot icon art (content, served from `/slot-icons`); `SLOT_GLYPHS` shows until it loads or when it is missing. */
export const SLOT_ICONS: Record<string, string> = {
  head: '/slot-icons/head.png',
  shoulders: '/slot-icons/shoulders.png',
  chest: '/slot-icons/chest.png',
  bracers: '/slot-icons/bracers.png',
  gloves: '/slot-icons/gloves.png',
  mainhand: '/slot-icons/mainhand.png',
  offhand: '/slot-icons/offhand.png',
  twohanded: '/slot-icons/twohanded.png',
  foot: '/slot-icons/foot.png',
  ring: '/slot-icons/ring.png',
  necklace: '/slot-icons/necklace.png',
  back: '/slot-icons/back.png',
  relic: '/slot-icons/relic.png',
};

export const SLOT_GLYPHS: Record<string, string> = {
  head: '⛑️', shoulders: '🦺', chest: '👕', bracers: '🔗', gloves: '🧤',
  mainhand: '🗡️', offhand: '🛡️', twohanded: '⚔️', foot: '🥾', ring: '💍',
  necklace: '📿', back: '🧥', relic: '🏺',
};

export const SLOT_LABELS: Record<string, string> = {
  head: 'Head', shoulders: 'Shoulders', chest: 'Chest', bracers: 'Bracers',
  gloves: 'Hands', mainhand: 'Main Hand', offhand: 'Offhand', twohanded: 'Two-Handed',
  foot: 'Feet', ring: 'Ring', necklace: 'Necklace', back: 'Back', relic: 'Relic',
};

export const SHINY_RARITIES = new Set(['epic', 'legendary', 'heirloom']);

export const RARITY_ORDER: Record<string, number> = {
  heirloom: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5, janky: 6,
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getItemInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Check if an item belongs to any set; returns the set ID or null. */
export function getItemSetId(itemId: string, setDefs: Record<string, SetDefinition>): string | null {
  for (const set of Object.values(setDefs)) {
    if (set.itemIds.includes(itemId)) return set.id;
  }
  return null;
}

function renderSlotArt(slot: string, wrapClass: string, imgClass: string, glyphClass: string): string {
  const src = SLOT_ICONS[slot];
  if (!src) return '';
  const label = SLOT_LABELS[slot] ?? slot;
  const glyph = SLOT_GLYPHS[slot] ?? '';
  const hasArt = isAssetLoaded(src) ? ' has-art' : '';
  return `<span class="${wrapClass}${hasArt}"><span class="${glyphClass}" aria-hidden="true">${glyph}</span>${renderTrackedImg(src, { className: imgClass, alt: label })}</span>`;
}

function renderSlotDogear(slot: string): string {
  return renderSlotArt(slot, 'item-dogear', 'item-dogear-img', 'item-dogear-glyph');
}

export interface ItemIconOptions {
  qty?: number;
  showSlotIcon?: boolean;
  /** Override the slot used for the dogear (e.g. for equipped items where slot comes from position, not definition). */
  slotOverride?: string;
  showSetIndicator?: boolean;
  setDefs?: Record<string, SetDefinition>;
  /** Extra CSS classes */
  extraClass?: string;
  /** data attributes as key-value pairs */
  dataAttrs?: Record<string, string>;
  /** Hover text in place of the item name. */
  tooltip?: string;
  /** Focusable with a button role; pair with `wireRoleButtons` on a parent. */
  interactive?: boolean;
}

/**
 * Render a square item icon as HTML string.
 * Options control what overlays appear (qty badge, set indicator, slot icon dogear).
 */
export function renderItemIcon(itemId: string, def: ItemDefinition, options?: ItemIconOptions): string {
  const rarity = def.rarity ?? 'common';
  const rarityColor = RARITY_COLORS[rarity] ?? RARITY_COLORS.common;
  const itemBg = def.iconColor ? `;--item-bg:${escapeHtml(def.iconColor)}` : '';
  const shinyClass = SHINY_RARITIES.has(rarity) ? ` item-rarity-${rarity}` : '';
  const initials = getItemInitials(def.name);
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';

  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';

  // Custom emoji icon (e.g., potions): render emoji centered, skip artwork lookup + initials.
  let inner: string;
  if (def.iconEmoji) {
    inner = `<span class="item-square-emoji">${escapeHtml(def.iconEmoji)}</span>`;
  } else {
    inner = `${renderTrackedImg(artworkUrl('item', itemId), { className: 'item-square-img' })}<span class="item-square-initials">${escapeHtml(initials)}</span>`;
  }

  if (options?.showSetIndicator && options.setDefs && getItemSetId(itemId, options.setDefs)) {
    inner += `<span class="item-square-set">S</span>`;
  }

  if (options?.qty != null && options.qty > 1) {
    inner += `<span class="item-square-qty">${options.qty}</span>`;
  }

  if (options?.showSlotIcon) {
    const slot = options.slotOverride ?? def.equipSlot;
    if (slot) {
      inner += renderSlotDogear(slot);
    }
  }

  const tooltip = escapeHtml(options?.tooltip ?? def.name);
  const title = options?.tooltip || options?.interactive ? ` title="${tooltip}"` : '';
  const role = options?.interactive ? ` role="button" tabindex="0" aria-label="${escapeHtml(def.name)}"` : '';
  return `<div class="item-square${shinyClass}${extraClass}" data-tooltip="${tooltip}"${title}${role} style="--rarity:${rarityColor}${itemBg}"${dataStr}>${inner}</div>`;
}

export interface ItemCellOptions extends Omit<ItemIconOptions, 'interactive'> {
  /** Dims the cell: this character can't use the item. */
  unusable?: boolean;
}

/** An item square with its name beneath, for grids where a square alone doesn't identify the item. */
export function renderItemCell(itemId: string, def: ItemDefinition, options?: ItemCellOptions): string {
  const color = RARITY_COLORS[def.rarity ?? 'common'] ?? RARITY_COLORS.common;
  const unusable = options?.unusable ? ' item-cell-unusable' : '';
  const label = escapeHtml(options?.unusable ? `${def.name}, can't be used by your class` : def.name);
  return `<div class="item-cell${unusable}" role="button" tabindex="0" aria-label="${label}">`
    + renderItemIcon(itemId, def, options)
    + `<span class="item-cell-name" style="color:${color}">${escapeHtml(def.name)}</span></div>`;
}

/** Empty equipment slot showing a faded slot icon. */
export function renderEmptySlotIcon(slot: string, options?: { extraClass?: string; dataAttrs?: Record<string, string>; interactive?: boolean }): string {
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';
  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
  const label = SLOT_LABELS[slot] ?? slot;

  const ghost = renderSlotArt(slot, 'item-slot-ghost', 'item-slot-ghost-img', 'item-slot-ghost-glyph');
  const role = options?.interactive ? ` role="button" tabindex="0" aria-label="${escapeHtml(label)}, empty"` : '';
  return `<div class="item-square item-square-empty${extraClass}" data-tooltip="${escapeHtml(label)}" title="${escapeHtml(label)}"${role}${dataStr}>${ghost}</div>`;
}

/** Sets the stack badge on a rendered square; a single item shows none. */
export function writeItemSquareQty(square: HTMLElement, qty: number): void {
  const badge = square.querySelector('.item-square-qty');
  if (qty <= 1) {
    badge?.remove();
  } else if (badge) {
    badge.textContent = String(qty);
  } else {
    square.insertAdjacentHTML('beforeend', `<span class="item-square-qty">${qty}</span>`);
  }
}

/** Enter and Space activate `[role="button"]` children, so div-based tiles work from the keyboard. */
export function wireRoleButtons(root: HTMLElement): void {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'button') return;
    e.preventDefault();
    target.click();
  });
}

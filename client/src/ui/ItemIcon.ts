import type { ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';

export const RARITY_COLORS: Record<string, string> = {
  janky: '#808080',
  common: '#e8e8e8',
  uncommon: '#66bb6a',
  rare: '#4fc3f7',
  epic: '#ee66e3',
  legendary: '#9233df',
  heirloom: '#e9bc18',
};

export const SLOT_ICONS: Record<string, string> = {
  head: 'H', shoulders: 'S', chest: 'C', bracers: 'B', gloves: 'G',
  mainhand: 'M', offhand: 'O', twohanded: '2H', foot: 'F',
  ring: 'R', necklace: 'N', back: 'K', relic: 'L',
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

export interface ItemIconOptions {
  qty?: number;
  showSlotIcon?: boolean;
  showSetIndicator?: boolean;
  setDefs?: Record<string, SetDefinition>;
  /** Extra CSS classes */
  extraClass?: string;
  /** data attributes as key-value pairs */
  dataAttrs?: Record<string, string>;
}

/**
 * Render a square item icon as HTML string.
 * Options control what overlays appear (qty badge, set indicator, slot icon).
 */
export function renderItemIcon(itemId: string, def: ItemDefinition, options?: ItemIconOptions): string {
  const rarity = def.rarity ?? 'common';
  const bgColor = RARITY_COLORS[rarity] ?? '#e8e8e8';
  const shinyClass = SHINY_RARITIES.has(rarity) ? ` item-rarity-${rarity}` : '';
  const initials = getItemInitials(def.name);
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';

  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';

  let inner = `<img class="item-square-img" src="/item-artwork/${itemId}.png" onerror="this.style.display='none'" onload="this.nextElementSibling.style.display='none'" alt="">
    <span class="item-square-initials">${initials}</span>`;

  if (options?.showSetIndicator && options.setDefs && getItemSetId(itemId, options.setDefs)) {
    inner += `<span class="item-square-set">S</span>`;
  }

  if (options?.qty != null && options.qty > 1) {
    inner += `<span class="item-square-qty">${options.qty}</span>`;
  }

  if (options?.showSlotIcon && def.equipSlot) {
    const slotIcon = SLOT_ICONS[def.equipSlot] ?? '';
    if (slotIcon) {
      inner += `<span class="item-square-slot-icon">${slotIcon}</span>`;
    }
  }

  return `<div class="item-square${shinyClass}${extraClass}" title="${escapeHtml(def.name)}" style="background:${bgColor}"${dataStr}>${inner}</div>`;
}

/**
 * Render an empty equipment slot icon.
 */
export function renderEmptySlotIcon(slot: string, options?: { extraClass?: string; dataAttrs?: Record<string, string> }): string {
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';
  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
  const slotAbbrev = SLOT_ICONS[slot] ?? '';
  const label = SLOT_LABELS[slot] ?? slot;

  return `<div class="item-square${extraClass}" title="${escapeHtml(label)}" style="background:#333333"${dataStr}><span class="item-square-initials" style="color:rgba(255,255,255,0.3)">${slotAbbrev}</span></div>`;
}

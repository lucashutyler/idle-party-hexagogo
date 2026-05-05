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

/** Border colors: gray for all rarities. Epic+ get animated glow via CSS. */
export const RARITY_BORDER_COLORS: Record<string, string> = {
  janky: 'rgba(180,180,180,0.25)',
  common: 'rgba(180,180,180,0.25)',
  uncommon: 'rgba(180,180,180,0.25)',
  rare: 'rgba(180,180,180,0.25)',
  epic: 'rgba(180,180,180,0.4)',
  legendary: 'rgba(180,180,180,0.4)',
  heirloom: 'rgba(180,180,180,0.4)',
};

/**
 * Slot icon image URLs. Replace emoji glyphs that previously decorated
 * equipment-slot dogears. Drop PNGs into `data/slot-icons/{slot}.png` and
 * mount `/slot-icons` server-side; missing files fall through to placehold.co.
 */
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

/**
 * Render the dogear corner element with a slot icon image.
 * `slot` is one of EquipSlot; we look up the URL in SLOT_ICONS, fall through
 * to placehold.co on load failure, and hide the img if even that fails.
 */
function renderSlotDogear(slot: string): string {
  const src = SLOT_ICONS[slot];
  if (!src) return '';
  const label = (SLOT_LABELS[slot] ?? slot).slice(0, 8);
  const placeholder = `https://placehold.co/16x16/2a2a40/e8e8e8/png?text=${encodeURIComponent(label)}`;
  const onerror = `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${placeholder}';}else{this.style.display='none';}`;
  return `<span class="item-dogear"><img class="item-dogear-img" src="${src}" alt="${escapeHtml(label)}" onerror="${onerror}" /></span>`;
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
}

/**
 * Render a square item icon as HTML string.
 * Options control what overlays appear (qty badge, set indicator, slot icon dogear).
 */
export function renderItemIcon(itemId: string, def: ItemDefinition, options?: ItemIconOptions): string {
  const rarity = def.rarity ?? 'common';
  const bgColor = RARITY_COLORS[rarity] ?? '#e8e8e8';
  const borderColor = RARITY_BORDER_COLORS[rarity] ?? 'rgba(180,180,180,0.25)';
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

  if (options?.showSlotIcon) {
    const slot = options.slotOverride ?? def.equipSlot;
    if (slot) {
      inner += renderSlotDogear(slot);
    }
  }

  return `<div class="item-square${shinyClass}${extraClass}" data-tooltip="${escapeHtml(def.name)}" style="background:${bgColor};border-color:${borderColor}"${dataStr}>${inner}</div>`;
}

/**
 * Render an empty equipment slot icon with a dogear showing the slot icon.
 */
export function renderEmptySlotIcon(slot: string, options?: { extraClass?: string; dataAttrs?: Record<string, string> }): string {
  const extraClass = options?.extraClass ? ` ${options.extraClass}` : '';
  const dataStr = options?.dataAttrs
    ? Object.entries(options.dataAttrs).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join('')
    : '';
  const label = SLOT_LABELS[slot] ?? slot;

  return `<div class="item-square item-square-empty${extraClass}" data-tooltip="${escapeHtml(label)}" style="background:#2a2a3a;border-color:rgba(255,255,255,0.08)"${dataStr}>${renderSlotDogear(slot)}</div>`;
}

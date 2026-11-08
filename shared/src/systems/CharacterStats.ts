import type { SkillContent, SkillLoadout } from './SkillTypes.js';
import { createDefaultSkillLoadout } from './SkillTypes.js';

// --- Types ---

export type ClassName = 'Knight' | 'Archer' | 'Priest' | 'Mage' | 'Bard';

export type DamageType = 'physical' | 'magical' | 'holy';

export interface ClassDefinition {
  displayName: string;
  description: string;
  baseHp: number;
  hpPerLevel: number;
  baseDamage: number;
  damagePerLevel: number;
  damageType: DamageType;
}

export interface CharacterState {
  className: ClassName;
  level: number;
  xp: number;
  gold: number;
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
  skillLoadout: SkillLoadout;
  /** Crafting skill level (per-class craft skill — see CRAFT_SKILL_NAMES). */
  craftLevel: number;
  /** Crafting skill XP toward next level. */
  craftXp: number;
}

// --- Constants ---

/** Class icon art (content, served from `/class-icons`); `classIconHtml` falls back to `CLASS_GLYPHS`. */
export const CLASS_ICONS: Record<string, string> = {
  Knight: '/class-icons/Knight.png',
  Archer: '/class-icons/Archer.png',
  Priest: '/class-icons/Priest.png',
  Mage: '/class-icons/Mage.png',
  Bard: '/class-icons/Bard.png',
};
export const UNKNOWN_CLASS_ICON = '/class-icons/Unknown.png';
export const SERVER_ICON = '/class-icons/Server.png';

export const CLASS_GLYPHS: Record<string, string> = {
  Knight: '🛡️',
  Archer: '🏹',
  Priest: '✨',
  Mage: '🔮',
  Bard: '🎻',
};
const UNKNOWN_CLASS_GLYPH = '❔';
const SERVER_GLYPH = '📣';

/**
 * Inline icon `<img>` HTML. Loads `src`; on error swaps itself for a styled `glyph` span
 * (or hides itself when there is no glyph).
 */
export function inlineIconHtml(src: string, label: string, extraClass = '', glyph = ''): string {
  const safeLabel = label.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 10) || '?';
  const cls = `icon-inline${extraClass ? ' ' + extraClass : ''}`;
  const fallback = glyph
    ? `this.outerHTML='<span class=&quot;${cls} icon-glyph&quot; role=&quot;img&quot; aria-label=&quot;${safeLabel}&quot;>${glyph}</span>'`
    : `this.style.display='none'`;
  return `<img class="${cls}" src="${src}" alt="${safeLabel}" style="opacity:0" onload="this.style.opacity=''" onerror="${fallback}" />`;
}

export function classIconHtml(className: string | undefined): string {
  if (!className) return inlineIconHtml(UNKNOWN_CLASS_ICON, '?', 'icon-class', UNKNOWN_CLASS_GLYPH);
  const src = CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  return inlineIconHtml(src, className, 'icon-class', CLASS_GLYPHS[className] ?? UNKNOWN_CLASS_GLYPH);
}

/** Inline server icon HTML — the sender icon on system chat messages. */
export function serverIconHtml(): string {
  return inlineIconHtml(SERVER_ICON, 'Server', 'icon-server', SERVER_GLYPH);
}

export const CLASS_DEFINITIONS: Record<ClassName, ClassDefinition> = {
  Knight: {
    displayName: 'Knight',
    description: 'Massive HP pool, low damage. Guard reduces physical damage taken.',
    baseHp: 50,
    hpPerLevel: 5,
    baseDamage: 1,
    damagePerLevel: 1,
    damageType: 'physical',
  },
  Archer: {
    displayName: 'Archer',
    description: 'High physical damage, very low HP. Pierce gives critical hits.',
    baseHp: 8,
    hpPerLevel: 1,
    baseDamage: 15,
    damagePerLevel: 2,
    damageType: 'physical',
  },
  Priest: {
    displayName: 'Priest',
    description: 'Holy damage, moderate HP. Bless reduces magical damage for the party.',
    baseHp: 20,
    hpPerLevel: 2,
    baseDamage: 3,
    damagePerLevel: 1,
    damageType: 'holy',
  },
  Mage: {
    displayName: 'Mage',
    description: 'High magical damage, very low HP. Burn increases damage per level.',
    baseHp: 8,
    hpPerLevel: 1,
    baseDamage: 15,
    damagePerLevel: 2,
    damageType: 'magical',
  },
  Bard: {
    displayName: 'Bard',
    description: 'Low stats, but Rally makes the whole party hit harder.',
    baseHp: 10,
    hpPerLevel: 1,
    baseDamage: 1,
    damagePerLevel: 1,
    damageType: 'physical',
  },
};

/** All playable class names. */
export const ALL_CLASS_NAMES: ClassName[] = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

export const MAX_GOLD = 999_999_999;

/** Per-class crafting skill name (the player's only craft skill — they have one for life). */
export const CRAFT_SKILL_NAMES: Record<ClassName, string> = {
  Knight: 'Smithing',
  Archer: 'Fletching',
  Priest: 'Inscription',
  Mage: 'Alchemy',
  Bard: 'Tinkering',
};

export function getCraftSkillName(className: ClassName): string {
  return CRAFT_SKILL_NAMES[className];
}

// --- Pure functions ---

/** Max HP = baseHp + (level - 1) * hpPerLevel. */
export function calculateMaxHp(level: number, className: ClassName): number {
  const def = CLASS_DEFINITIONS[className];
  return def.baseHp + (level - 1) * def.hpPerLevel;
}

/** Base damage = baseDamage + (level - 1) * damagePerLevel. */
export function calculateBaseDamage(level: number, className: ClassName): number {
  const def = CLASS_DEFINITIONS[className];
  return def.baseDamage + (level - 1) * def.damagePerLevel;
}

/** XP required to advance from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  return Math.floor(18000 * Math.pow(level, 1.2) * Math.pow(1.06, level));
}

/** Crafting XP required to advance from `level` to `level + 1`. Gentle linear-ish curve. */
export function xpForCraftLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.3));
}

/**
 * Create a fresh Level 1 character of the given class.
 * `skillContent` supplies the skill catalog + slot schedules used to build the
 * default loadout (server passes ContentStore data; tests pass the SEED_* tables).
 */
export function createCharacter(className: ClassName, skillContent: SkillContent): CharacterState {
  return {
    className,
    level: 1,
    xp: 0,
    gold: 0,
    inventory: {},
    equipment: { head: null, shoulders: null, chest: null, bracers: null, gloves: null, mainhand: null, offhand: null, foot: null, ring: null, necklace: null, back: null, relic: null },
    skillLoadout: createDefaultSkillLoadout(className, skillContent),
    craftLevel: 1,
    craftXp: 0,
  };
}

/** Add gold to a character, clamping at MAX_GOLD. Returns actual gold added. */
export function addGold(char: CharacterState, amount: number): number {
  const before = char.gold;
  char.gold = Math.min(char.gold + amount, MAX_GOLD);
  return char.gold - before;
}

/**
 * Add craft XP to a character, leveling up the craft skill as needed.
 * Mutates `char` in place. Returns info about level-ups.
 */
export function addCraftXp(char: CharacterState, amount: number): { leveledUp: boolean; levelsGained: number } {
  if (amount <= 0) return { leveledUp: false, levelsGained: 0 };
  char.craftXp += amount;
  let levelsGained = 0;
  while (char.craftXp >= xpForCraftLevel(char.craftLevel)) {
    char.craftXp -= xpForCraftLevel(char.craftLevel);
    char.craftLevel++;
    levelsGained++;
  }
  return { leveledUp: levelsGained > 0, levelsGained };
}

/**
 * Add XP to a character, leveling up as needed.
 * Mutates `char` in place. Returns info about level-ups.
 * Skills auto-unlock at their level milestones (handled by the server).
 */
export function addXp(char: CharacterState, amount: number): { leveledUp: boolean; levelsGained: number } {
  char.xp += amount;
  let levelsGained = 0;

  while (char.xp >= xpForNextLevel(char.level)) {
    char.xp -= xpForNextLevel(char.level);
    char.level++;
    levelsGained++;
  }

  return { leveledUp: levelsGained > 0, levelsGained };
}

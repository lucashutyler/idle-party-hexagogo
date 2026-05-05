import type { SkillLoadout } from './SkillTypes.js';
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
}

// --- Constants ---

/**
 * Class icon image URLs. Drop PNGs into `data/class-icons/{ClassName}.png`
 * and add a static mount at `/class-icons` in `server/src/index.ts`.
 * Missing files fall through to a placehold.co stub via `classIconHtml()`.
 *
 * Emoji are no longer used for icons anywhere in the game UI.
 */
export const CLASS_ICONS: Record<string, string> = {
  Knight: '/class-icons/Knight.png',
  Archer: '/class-icons/Archer.png',
  Priest: '/class-icons/Priest.png',
  Mage: '/class-icons/Mage.png',
  Bard: '/class-icons/Bard.png',
};
export const UNKNOWN_CLASS_ICON = '/class-icons/Unknown.png';
export const SERVER_ICON = '/class-icons/Server.png';

/**
 * Render an inline icon `<img>` as an HTML string. Loads `src`; on error
 * falls through to a placehold.co stub; hides itself if even that fails.
 * Drop-in replacement for emoji glyphs in template strings.
 */
export function inlineIconHtml(src: string, label: string, extraClass = ''): string {
  const safeLabel = label.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 10) || '?';
  const placeholder = `https://placehold.co/24x24/2a2a40/e8e8e8/png?text=${encodeURIComponent(safeLabel)}`;
  const onerror = `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${placeholder}';}else{this.style.display='none';}`;
  const cls = `icon-inline${extraClass ? ' ' + extraClass : ''}`;
  return `<img class="${cls}" src="${src}" alt="${safeLabel}" onerror="${onerror}" />`;
}

/** Inline class icon `<img>` HTML — drop-in replacement for the old emoji glyphs. */
export function classIconHtml(className: string | undefined): string {
  if (!className) return inlineIconHtml(UNKNOWN_CLASS_ICON, '?', 'icon-class');
  const src = CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  return inlineIconHtml(src, className, 'icon-class');
}

/** Inline server icon `<img>` HTML — used for the sender icon on system chat messages. */
export function serverIconHtml(): string {
  return inlineIconHtml(SERVER_ICON, 'Server', 'icon-server');
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
    description: 'Low stats, but Rally boosts party damage by 20% per member.',
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

/** Create a fresh Level 1 character of the given class. */
export function createCharacter(className: ClassName): CharacterState {
  return {
    className,
    level: 1,
    xp: 0,
    gold: 0,
    inventory: {},
    equipment: { head: null, shoulders: null, chest: null, bracers: null, gloves: null, mainhand: null, offhand: null, foot: null, ring: null, necklace: null, back: null, relic: null },
    skillLoadout: createDefaultSkillLoadout(className),
  };
}

/** Add gold to a character, clamping at MAX_GOLD. Returns actual gold added. */
export function addGold(char: CharacterState, amount: number): number {
  const before = char.gold;
  char.gold = Math.min(char.gold + amount, MAX_GOLD);
  return char.gold - before;
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

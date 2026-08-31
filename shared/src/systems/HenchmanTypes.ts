import type { ClassName, DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import type { PartyCombatant } from './CombatEngine.js';

/** A hireable NPC party member, authored as content. See docs/architecture/content.md. */
export interface HenchmanDefinition {
  id: string;
  name: string;
  description?: string;
  /** Combat archetype — drives engine class checks; never shown to players. */
  className: ClassName;
  /** Cosmetic — the stats below are authoritative and are not derived from it. */
  level: number;
  maxHp: number;
  baseDamage: number;
  /** Overrides the archetype's damage type when set. */
  damageType?: DamageType;
  skillIds: string[];
  emoji: string;
  /** Photo URL; falls back to `emoji`. */
  artworkUrl?: string;
}

/** A henchman a party currently holds. */
export interface HiredHenchman {
  /** Unique per hire; `henchmanId` is the definition and is not unique in principle. */
  instanceId: string;
  henchmanId: string;
  gridPosition: PartyGridPosition;
  /** Map the hire was made on — the party leaving it dismisses the henchman. */
  mapId: string;
  /** Below: resolved from live content by the server at send time, never stored. */
  name?: string;
  emoji?: string;
  artworkUrl?: string;
  level?: number;
}

/** A henchman offered by a shop, resolved for the hire list. */
export interface HenchmanOffer {
  henchmanId: string;
  name: string;
  description?: string;
  emoji: string;
  artworkUrl?: string;
  level: number;
  maxHp: number;
  baseDamage: number;
}

/**
 * Combat display names for a party's henchmen, in roster order.
 * `reserved` must carry the party's real usernames — a henchman sharing a combatant name corrupts targeting.
 */
export function henchmanDisplayNames(names: string[], reserved: readonly string[] = []): string[] {
  const used = new Set<string>(reserved);
  return names.map(name => {
    let candidate = name;
    let n = 1;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${name} #${n}`;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Build the combatant a henchman fights as.
 * Must never throw — runs inside a `setInterval` callback with no try/catch above it.
 */
export function buildHenchmanCombatant(
  def: HenchmanDefinition,
  hired: HiredHenchman,
  resolveSkill: (id: string) => SkillDefinition | undefined,
  displayName: string,
): PartyCombatant {
  const equippedSkills: (SkillDefinition | null)[] = def.skillIds.map(id => resolveSkill(id) ?? null);
  const maxHp = Math.max(1, Math.floor(def.maxHp));

  return {
    username: displayName,
    isHenchman: true,
    maxHp,
    currentHp: maxHp,
    baseDamage: Math.max(0, Math.floor(def.baseDamage)),
    playerDamageType: def.damageType ?? 'physical',
    gridPosition: hired.gridPosition,
    className: def.className,
    level: def.level,
    equippedSkills,
    attackCount: 0,
    stunTurns: 0,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    braceActive: false,
    braceDamageTaken: 0,
    interceptActive: false,
    activeSkillCount: 0,
  };
}

/** `ContentStore` seeds this only when `NODE_ENV !== 'production'`. */
export const SEED_HENCHMEN: Record<string, HenchmanDefinition> = {
  test_sellsword: {
    id: 'test_sellsword',
    name: 'Test Sellsword',
    description: 'A placeholder hire. Delete me once real henchmen exist.',
    className: 'Knight',
    level: 3,
    maxHp: 80,
    baseDamage: 6,
    skillIds: [],
    emoji: '🗡️',
  },
};

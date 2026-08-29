import type { ClassName, DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import type { PartyCombatant } from './CombatEngine.js';

// --- Types ---

/**
 * A hireable NPC party member, authored as content.
 *
 * Henchmen are *templates*, not instances: several players may hold a hire of
 * the same definition at once, and one party may hold two of the same. Stats
 * are fixed — there is no levelling, no equipment and no inventory, so a
 * definition is the whole of a henchman's power.
 *
 * `className` is a combat archetype, not a player-facing label. The combat
 * engine keys five behaviours off it (Sanctuary's non-Knight target pick, War
 * Cry's `targetClass` match, Martyr's Knight-damage trigger, and monster
 * `all_class` skill filters), so every henchman must carry a real one. It is
 * deliberately not surfaced in the hire UI.
 */
export interface HenchmanDefinition {
  id: string;
  name: string;
  /** Flavour line shown in the hire list. */
  description?: string;
  /** Combat archetype. Drives engine class checks; not shown to players. */
  className: ClassName;
  /** Display level. Cosmetic — stats below are authoritative, not derived from it. */
  level: number;
  maxHp: number;
  baseDamage: number;
  /** Overrides the archetype's damage type when set. */
  damageType?: DamageType;
  /** Fixed skill loadout, by skill id. Ids the live server lacks resolve to an empty slot. */
  skillIds: string[];
  /** Emoji portrait. Always required so a henchman always renders. */
  emoji: string;
  /** Optional photo URL (e.g. /henchman-artwork/foo.png). Falls back to emoji. */
  artworkUrl?: string;
}

/**
 * A henchman a party currently holds.
 *
 * `instanceId` exists because the definition id is not unique within a party —
 * identity everywhere else in the game is the raw username string, and two
 * hires of one definition would otherwise produce ambiguous combat-log lines
 * and collide as heal/DoT targets.
 *
 * `mapId` is the map the hire was made on. Henchmen are dismissed when the
 * party leaves it, so this is captured at hire time rather than read back off
 * the party.
 */
export interface HiredHenchman {
  instanceId: string;
  henchmanId: string;
  gridPosition: PartyGridPosition;
  /** Map the hire was made on — the party leaving it dismisses the henchman. */
  mapId: string;
  /**
   * Resolved display fields — populated by the server when sending to clients,
   * not stored. Same convention as `WorldTileDefinition.zoneName`: the roster
   * holds ids, and names are resolved against live content at send time so a
   * renamed henchman does not go stale in a party that already hired it.
   */
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

// --- Helpers ---

/**
 * Combat-log and targeting handle for a hired henchman.
 *
 * Usernames are validated as `/^[a-zA-Z0-9_-]+$/`, so the colons guarantee this
 * can never collide with a real account. That is load-bearing: it is what keeps
 * trade and gift lookups (which resolve targets through the account store)
 * safe against a henchman target for free.
 */
export function henchmanHandle(instanceId: string): string {
  return `hench:${instanceId}`;
}

/** Whether a party-member handle refers to a henchman rather than an account. */
export function isHenchmanHandle(handle: string): boolean {
  return handle.startsWith('hench:');
}

/**
 * Build the combatant a henchman fights as.
 *
 * Mirrors `PlayerSession.getCombatInfo()`, minus everything that needs an
 * account: no equipment bonuses, no set bonuses, no XP. Never throws — an
 * unresolvable skill id becomes an empty slot, the same way the player path
 * treats a skill the live server does not hold. That matters because this runs
 * inside a `setInterval` callback with no try/catch above it.
 */
export function buildHenchmanCombatant(
  def: HenchmanDefinition,
  hired: HiredHenchman,
  resolveSkill: (id: string) => SkillDefinition | undefined,
): PartyCombatant {
  const equippedSkills: (SkillDefinition | null)[] = def.skillIds.map(id => resolveSkill(id) ?? null);
  const maxHp = Math.max(1, Math.floor(def.maxHp));

  return {
    username: henchmanHandle(hired.instanceId),
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

/**
 * Dev-only seed henchman, so the hire flow is exercisable before real content
 * exists. `ContentStore` only seeds this when `NODE_ENV !== 'production'`.
 */
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

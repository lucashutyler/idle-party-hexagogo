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
 * Combat display names for a party's henchmen, in roster order.
 *
 * `PartyCombatant.username` is interpolated verbatim into ~25 combat-log lines,
 * so a henchman's must read as a name. It must also be unique across the WHOLE
 * combat array — it keys DoT `sourceUsername`, heal-target prose, and the
 * client's self-substitution ("You") — and neither uniqueness source is safe on
 * its own: a party may hold two hires of one definition, and an authored
 * henchman called "Grim" collides exactly with a player account called "Grim".
 *
 * So `reserved` takes the party's real usernames, and any name colliding with
 * an account or with an earlier henchman gains ` #2`, ` #3`. Uniqueness only
 * has to hold for the lifetime of a battle, which is how long the array lives.
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

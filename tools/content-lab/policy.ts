import type { ClassName, CompositionSpec, ContentSnapshot, HireSpec, PartyMemberSpec } from './types.js';
import { CLASS_NAMES } from './types.js';

export const COMPOSITIONS: readonly CompositionSpec[] = [
  { id: 'K', humans: ['Knight'], hires: false },
  { id: 'A', humans: ['Archer'], hires: false },
  { id: 'P', humans: ['Priest'], hires: false },
  { id: 'M', humans: ['Mage'], hires: false },
  { id: 'B', humans: ['Bard'], hires: false },
  { id: 'K+P', humans: ['Knight', 'Priest'], hires: false },
  { id: 'K+P+M', humans: ['Knight', 'Priest', 'Mage'], hires: false },
  { id: 'K+A+P+M+B', humans: ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'], hires: false },
  { id: 'K+hires', humans: ['Knight'], hires: true },
  { id: 'A+hires', humans: ['Archer'], hires: true },
  { id: 'P+hires', humans: ['Priest'], hires: true },
  { id: 'M+hires', humans: ['Mage'], hires: true },
  { id: 'B+hires', humans: ['Bard'], hires: true },
];

export const CORE_COMPOSITIONS = COMPOSITIONS.filter(c => !c.hires);

const CLASS_INITIALS: Record<string, ClassName> = { K: 'Knight', A: 'Archer', P: 'Priest', M: 'Mage', B: 'Bard' };

/** Every party of distinct classes, for the sweeps; the id reads like the core ones (K+P+M). */
export function classSubsets(): CompositionSpec[] {
  const initials = Object.keys(CLASS_INITIALS);
  const subsets: CompositionSpec[] = [];
  for (let mask = 1; mask < 1 << initials.length; mask++) {
    const picked = initials.filter((_, i) => mask & (1 << i));
    subsets.push({ id: picked.join('+'), humans: picked.map(k => CLASS_INITIALS[k]), hires: false });
  }
  return subsets;
}

/** Where the game itself seats an unadjusted party: the leader in the centre, the rest in the first free seat. */
export const DEFAULT_LEADER_SEAT = 4;

export function defaultSeats(memberCount: number): number[] {
  const seats = [DEFAULT_LEADER_SEAT];
  for (let s = 0; seats.length < memberCount; s++) if (s !== DEFAULT_LEADER_SEAT) seats.push(s);
  return seats;
}

// --- Grid ---

/** Position = row × 3 + col; col 2 is the front. Seats are in preference order. */
export const SOLO_SEAT = 5;
export const CLASS_SEATS: Record<ClassName, readonly number[]> = {
  Knight: [5, 2, 8],
  Priest: [3, 0, 6],
  Mage: [4, 1, 7],
  Archer: [4, 1, 7],
  Bard: [4, 7, 6, 1],
};

function firstFreeSeat(className: ClassName, taken: Set<number>): number {
  const seat = [...CLASS_SEATS[className], 0, 1, 2, 3, 4, 5, 6, 7, 8].find(s => !taken.has(s))!;
  taken.add(seat);
  return seat;
}

export function humanSeats(classes: readonly ClassName[], withHires: boolean, seats?: readonly number[]): PartyMemberSpec[] {
  const solo = classes.length === 1 && !withHires;
  const taken = new Set<number>();
  return classes.map((className, i) => ({
    className,
    gridPosition: seats?.[i] ?? (solo ? SOLO_SEAT : firstFreeSeat(className, taken)),
    username: `${className}_${i}`,
  }));
}

// --- Regions ---

export interface Region {
  id: string;
  name: string;
  index: number;
  zoneIds: string[];
  shopIds: string[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : Infinity;
}

/** Each world map is a region, ordered by the median midpoint of its zones' level ranges. */
export function buildRegions(content: ContentSnapshot): { regions: Region[]; zoneRegion: Map<string, Region> } {
  const zoneTiles = new Map<string, Map<string, number>>();
  for (const t of content.world.tiles) {
    const maps = zoneTiles.get(t.zone) ?? new Map<string, number>();
    maps.set(t.mapId, (maps.get(t.mapId) ?? 0) + 1);
    zoneTiles.set(t.zone, maps);
  }
  const zoneMap = new Map<string, string>();
  for (const [zoneId, maps] of zoneTiles) {
    if (!content.zones[zoneId]) continue;
    zoneMap.set(zoneId, [...maps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  const mid = (zoneId: string): number => {
    const r = content.zones[zoneId].levelRange;
    return (r[0] + r[1]) / 2;
  };
  const maps = content.world.maps.map(map => {
    const zoneIds = [...zoneMap].filter(([, m]) => m === map.id).map(([z]) => z);
    return { map, zoneIds, level: median(zoneIds.map(mid)) };
  }).sort((a, b) => a.level - b.level || a.map.id.localeCompare(b.map.id));
  const regions = maps.map(({ map, zoneIds }, index): Region => ({
    id: map.id,
    name: map.name,
    index,
    zoneIds: zoneIds.sort((a, b) => mid(a) - mid(b) || a.localeCompare(b)),
    shopIds: [...new Set(content.world.tiles.filter(t => t.mapId === map.id && t.shopId && content.shops[t.shopId]).map(t => t.shopId!))],
  }));
  const zoneRegion = new Map<string, Region>();
  for (const r of regions) for (const z of r.zoneIds) zoneRegion.set(z, r);
  return { regions, zoneRegion };
}

// --- Gear ---

export interface StatWeights {
  atk: number;
  dr: number;
  mr: number;
}

export const CLASS_GEAR_WEIGHTS: Record<ClassName, StatWeights> = {
  Knight: { atk: 0.5, dr: 1, mr: 0.7 },
  Archer: { atk: 1, dr: 0.3, mr: 0.2 },
  Priest: { atk: 0.5, dr: 0.7, mr: 0.7 },
  Mage: { atk: 1, dr: 0.3, mr: 0.2 },
  Bard: { atk: 0.7, dr: 0.5, mr: 0.4 },
};

const NON_HAND_SLOTS = ['head', 'shoulders', 'chest', 'bracers', 'gloves', 'foot', 'ring', 'necklace', 'back', 'relic'] as const;
const CARRIED_SLOTS = [...NON_HAND_SLOTS, 'mainhand', 'offhand', 'twohanded'] as const;

export function itemScore(item: any, weights: StatWeights): number {
  const avg = (a?: number, b?: number): number => ((a ?? 0) + (b ?? 0)) / 2;
  return weights.atk * avg(item.bonusAttackMin, item.bonusAttackMax)
    + weights.dr * avg(item.damageReductionMin, item.damageReductionMax)
    + weights.mr * avg(item.magicReductionMin, item.magicReductionMax);
}

function canEquip(item: any, className: string): boolean {
  return !item.classRestriction?.length || item.classRestriction.includes(className);
}

function bestItem(items: readonly any[], slot: string, className: ClassName): any | null {
  const weights = CLASS_GEAR_WEIGHTS[className];
  let best: any = null;
  let bestScore = -Infinity;
  for (const item of items) {
    if (item.equipSlot !== slot || !canEquip(item, className)) continue;
    const score = itemScore(item, weights);
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && item.id < best.id)) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

export type Equipment = Record<string, string | null>;

/** regionId → class → equipment; a slot no shop on this map sells keeps the previous region's pick. */
export function buildGearTable(content: ContentSnapshot, regions: readonly Region[]): Map<string, Record<ClassName, Equipment>> {
  const table = new Map<string, Record<ClassName, Equipment>>();
  const carried = Object.fromEntries(CLASS_NAMES.map(c => [c, {} as Record<string, any>])) as Record<ClassName, Record<string, any>>;
  for (const region of regions) {
    const stock = region.shopIds.flatMap(id => content.shops[id].inventory ?? []).map(s => content.items[s.itemId]).filter(Boolean);
    const perClass = {} as Record<ClassName, Equipment>;
    for (const className of CLASS_NAMES) {
      const picks = carried[className];
      for (const slot of CARRIED_SLOTS) picks[slot] = bestItem(stock, slot, className) ?? picks[slot] ?? null;
      const weights = CLASS_GEAR_WEIGHTS[className];
      const equipment: Equipment = {};
      for (const slot of NON_HAND_SLOTS) equipment[slot] = picks[slot]?.id ?? null;
      const oneHanded = (picks.mainhand ? itemScore(picks.mainhand, weights) : 0) + (picks.offhand ? itemScore(picks.offhand, weights) : 0);
      if (picks.twohanded && itemScore(picks.twohanded, weights) >= oneHanded) {
        equipment.mainhand = picks.twohanded.id;
        equipment.offhand = picks.twohanded.id;
      } else {
        equipment.mainhand = picks.mainhand?.id ?? null;
        equipment.offhand = picks.offhand?.id ?? null;
      }
      perClass[className] = equipment;
    }
    table.set(region.id, perClass);
  }
  return table;
}

// --- Skills ---

interface KindPriority {
  passive: readonly string[];
  active: readonly string[];
  /** Never equipped by default: a net loss for the default rotation. */
  avoid?: readonly string[];
}

export const LOADOUT_PRIORITY: Record<ClassName, KindPriority> = {
  Knight: {
    passive: ['physical_reduction', 'max_hp_percent', 'stun_on_phys_hit', 'healing_received_bonus', 'stun_immune', 'conditional_ally_damage'],
    active: ['stun_single', 'stacking_mark', 'remove_buffs', 'redirect_hit', 'brace_reflect'],
  },
  Archer: {
    passive: ['crit_chance', 'conditional_damage_bonus', 'crit_damage_bonus', 'stacking_same_target'],
    active: ['multi_hit_random', 'ignore_dr_single', 'target_lowest_hp', 'dot_attack', 'debuff_attack'],
  },
  Priest: {
    passive: ['magical_reduction_party', 'heal_power', 'enemy_damage_reduction_party', 'holy_damage_party', 'martyr', 'resurrection'],
    active: ['heal_lowest', 'hot_lowest', 'damage_percent', 'shield_non_knight', 'cure_debuffs'],
  },
  Mage: {
    passive: ['bonus_damage', 'dot_on_auto', 'arcane_surge', 'overflow', 'scorch'],
    active: ['damage_aoe_all', 'damage_percent', 'multi_hit', 'high_damage_single'],
    avoid: ['intensify'],
  },
  Bard: {
    passive: ['party_damage_mult', 'dodge_party', 'enemy_damage_reduction_party', 'cooldown_reduction', 'xp_bonus'],
    active: ['party_buff_permanent', 'damage_aoe_all', 'stun_aoe', 'enemy_debuff_aoe', 'chaos'],
  },
};

/** Enemies assumed when judging an AoE against the auto-attack it would replace. */
const TRAP_AOE_ENEMIES = 3;

/**
 * Ready on every action, instant, and worth less than the auto-attack it replaces, so it would
 * lock the owner out of autos (and auto-only passives) for a net loss.
 */
export function isAutoReplacingTrap(skill: any): boolean {
  if (skill.type !== 'active' || skill.trigger || (skill.castTime ?? 0) > 0 || (skill.cooldown ?? 1) > 1) return false;
  return (skill.activeEffects ?? []).some((e: any) => {
    if (e.damagePercent === undefined) return false;
    const hits = e.kind === 'damage_aoe_all' ? TRAP_AOE_ENEMIES : e.hitCount ?? 1;
    return e.damagePercent * hits < 1;
  });
}

function skillKinds(skill: any): string[] {
  return [...(skill.passiveEffects ?? []), ...(skill.activeEffects ?? [])].map((e: any) => e.kind);
}

export function chooseLoadout(content: Pick<ContentSnapshot, 'skills' | 'skillSlotSchedules'>, className: ClassName, level: number): (string | null)[] {
  const priority = LOADOUT_PRIORITY[className];
  const rank = (skill: any, type: 'passive' | 'active'): number => {
    const list = priority[type];
    const indices = skillKinds(skill).map(k => list.indexOf(k)).filter(i => i >= 0);
    return indices.length ? Math.min(...indices) : list.length;
  };
  const unlocked = Object.values(content.skills).filter((s: any) =>
    s.className === className
    && typeof s.unlockLevel === 'number'
    && s.unlockLevel <= level
    && !isAutoReplacingTrap(s)
    && !skillKinds(s).some(k => priority.avoid?.includes(k)));
  const ranked = (type: 'passive' | 'active'): any[] => unlocked
    .filter((s: any) => s.type === type)
    .sort((a: any, b: any) => rank(a, type) - rank(b, type) || b.unlockLevel - a.unlockLevel || a.id.localeCompare(b.id));
  const queues = { passive: ranked('passive'), active: ranked('active') };
  return (content.skillSlotSchedules[className] ?? []).map(slot => {
    if (slot.unlocksAtLevel > level) return null;
    return queues[slot.type].shift()?.id ?? null;
  });
}

// --- Henchmen ---

interface HireRole {
  classes: readonly ClassName[];
  /** A hire fills the role only with one of these; other classes in the list need it too. */
  skillKinds?: readonly string[];
  /** With no hire that fills the role, the first free one of the class still takes the seat. */
  fallback?: boolean;
  /** Sits where this class sits, whatever the hire's own class is. */
  seatsAs?: ClassName;
}

const TANK_ROLE: HireRole = { classes: ['Knight', 'Priest'], skillKinds: ['physical_reduction'], seatsAs: 'Knight' };
const HEALER_ROLE: HireRole = { classes: ['Priest'], skillKinds: ['heal_lowest', 'hot_lowest'], fallback: true };
const DAMAGE_ROLE: HireRole = { classes: ['Mage', 'Archer', 'Bard'] };

/** Role order for up to two hires: a trio of tank, healer and damage with the human in their own role. */
const HIRE_ROLES: Record<ClassName, readonly HireRole[]> = {
  Knight: [HEALER_ROLE, DAMAGE_ROLE],
  Priest: [TANK_ROLE, DAMAGE_ROLE],
  Mage: [TANK_ROLE, HEALER_ROLE],
  Archer: [TANK_ROLE, HEALER_ROLE],
  Bard: [TANK_ROLE, HEALER_ROLE],
};

function fillsRole(hire: any, role: HireRole, skills: Record<string, any>): boolean {
  if (!role.skillKinds) return true;
  return hire.skillIds.some((id: string) => skills[id] && skillKinds(skills[id]).some(k => role.skillKinds!.includes(k)));
}

/** Role-filling hires first; then the highest level at or below the party level, else the lowest above it. */
function bestFitHire(pool: readonly any[], role: HireRole, level: number, used: ReadonlySet<string>, skills: Record<string, any>): any | null {
  for (const c of role.classes) {
    const free = pool.filter(h => h.className === c && !used.has(h.id));
    const filling = free.filter(h => fillsRole(h, role, skills));
    const candidates = filling.length || !role.fallback ? filling : free;
    if (candidates.length === 0) continue;
    const below = candidates.filter(h => h.level <= level).sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));
    if (below.length) return below[0];
    return candidates.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))[0];
  }
  return null;
}

export function chooseHires(content: ContentSnapshot, region: Region, human: ClassName, level: number, humanSeat: number): HireSpec[] {
  const pool = [...new Set(region.shopIds.flatMap(id => content.shops[id].henchmanIds ?? []))].map(id => content.henchmen[id]).filter(Boolean);
  const used = new Set<string>();
  const taken = new Set<number>([humanSeat]);
  const hires: HireSpec[] = [];
  for (const role of HIRE_ROLES[human]) {
    const pick = bestFitHire(pool, role, level, used, content.skills);
    if (!pick) continue;
    used.add(pick.id);
    hires.push({ henchmanId: pick.id, gridPosition: firstFreeSeat(role.seatsAs ?? pick.className, taken) });
  }
  return hires;
}

export function xpMultiplier(skillIds: readonly (string | null)[], skills: Record<string, any>): number {
  let multiplier = 1;
  for (const id of skillIds) {
    if (!id) continue;
    for (const effect of skills[id]?.passiveEffects ?? []) {
      if (effect.kind === 'xp_bonus') multiplier += effect.flatValue ?? 0;
    }
  }
  return multiplier;
}

export const POLICY_SUMMARY = {
  level: 'zone levelRange midpoint (rounded); low/high ends in the zone variants; dungeons: entrance zone midpoint, at least minLevel, at most maxLevel',
  gear: 'per class and slot, highest weighted (atk, dr, mr) average among items sold in shops on the zone\'s world map; a slot none of them sells keeps the previous region\'s pick; two-handed wins when it scores >= mainhand + offhand; set bonuses apply through the real computeActiveSetBonuses when the picks happen to complete a breakpoint, sets are not sought; prices are ignored',
  gearWeights: CLASS_GEAR_WEIGHTS,
  ungeared: 'empty equipment, what createCharacter gives a new character',
  loadout: 'slots from the class slot schedule at that level; each slot takes the next unlocked non-grant skill by effect-kind priority, newer unlock first within a kind; slots with nothing left stay empty; no party-specific swaps; a skill ready on every action that is worth less than an auto (isAutoReplacingTrap) is never picked',
  loadoutPriority: LOADOUT_PRIORITY,
  grid: 'solo: front-centre; parties: class seat preferences, tanks front',
  classSeats: CLASS_SEATS,
  hires: 'up to two hires offered on the same world map completing tank/healer/damage; a tank is a Knight, or a Priest hire carrying a physical-reduction skill; a role no hire on the map fills stays open; Priest hires with a heal first; highest level at or below the party, else lowest above; every hire takes a lost reward share; ineligible in dungeons (hires wait at the entrance)',
  sims: 'stratified by encounter-table entry: max(3, round(N x share)) sims per entry, stats weighted by share; seed = hash(base seed, cell id, entry id, sim index)',
  rates: 'xpPerHour = E[xp per fight, 0 on non-wins] / E[fight time + pause] x 3600; pause is the engine timer\'s kill delay + result pause + move; every fight is treated as followed by a move',
  stalemate: 'new: the no-progress rule of the engine, or still running after 2 h; old: the engine has no such rule, so 600 ticks without a new low in monster HP, or still running after 2 h',
  autoRetreat: 'not modelled',
  mastery: 'zero kills on both engines',
  dungeons: 'whole-dungeon runs resample each floor\'s fights in order until a loss; floor checkpoints are not modelled (none exist in a content with no boss tiers); first-clear XP and gold are excluded',
};

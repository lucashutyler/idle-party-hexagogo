import type { XpSnapshot } from './types.js';

/** Encounters with more rolls than this use each entry's mean count instead of walking every roll. */
const PACK_ENUMERATION_LIMIT = 20000;
const BOSS_TIERS = ['boss', 'raid'];

export interface FloorSource {
  dungeonId: string;
  floorIndex: number;
  chance: number;
  /** Mean quantity when it drops. */
  quantity: number;
  /** Only members of these classes roll for it. Empty: everyone. */
  classes: readonly string[];
}

export interface MaterialInfo {
  id: string;
  name: string;
  /** Lowest and highest required level of the recipes using it. */
  minLevel: number;
  maxLevel: number;
  /** Median units one gear craft needs, through any parts; a material reaching no gear reads its own recipes. */
  perCraft: number;
  /** Gear can't be made without it: a gear recipe takes it directly, or through parts no shop sells. */
  usedByGear: boolean;
  /** It reaches gear only through parts a shop also sells, so farming it just saves gold. */
  savesGoldOnly: boolean;
  /** Monsters dropping it, as the snapshot defines them. */
  monsterIds: readonly string[];
  floors: readonly FloorSource[];
  /** Every monster dropping it is a boss, so its rooms are boss rooms by construction. */
  bossToken: boolean;
  shopSold: boolean;
  /** Units handed out once per player: one-off quests and first clears. */
  freeOnce: number;
  /** Item's class restriction: drops go only to shares of these classes when the party has any. */
  classes: readonly string[];
}

export function meanQuantity(reward: { minQty?: number; maxQty?: number }): number {
  const low = reward.minQty ?? 1;
  return (low + Math.max(low, reward.maxQty ?? low)) / 2;
}

/**
 * Expected monsters of each kind in one fight of this encounter, walking resolveEncounter's rolls:
 * uniform counts, then trimming the largest entry down to roomMax.
 */
export function expectedPack(encounter: any, monsters: Record<string, unknown>): Map<string, number> {
  const pack = new Map<string, number>();
  const add = (id: string, count: number): void => {
    pack.set(id, (pack.get(id) ?? 0) + count);
  };
  if (!encounter) return pack;
  if (encounter.type === 'explicit') {
    for (const p of encounter.placements ?? []) if (monsters[p.monsterId]) add(p.monsterId, 1);
    return pack;
  }
  const pool = ((encounter.monsterPool ?? []) as { monsterId: string; min: number; max: number }[]).filter(e => monsters[e.monsterId]);
  const roomMax: number = encounter.roomMax ?? 9;
  const rolls = pool.reduce((product, e) => product * (e.max - e.min + 1), 1);
  if (rolls > PACK_ENUMERATION_LIMIT) {
    const total = pool.reduce((sum, e) => sum + (e.min + e.max) / 2, 0);
    const scale = total > roomMax ? roomMax / total : 1;
    for (const e of pool) add(e.monsterId, ((e.min + e.max) / 2) * scale);
    return pack;
  }
  const walk = (index: number, counts: { id: string; count: number }[], weight: number): void => {
    if (index === pool.length) {
      const rolled = counts.filter(r => r.count > 0).map(r => ({ ...r }));
      let total = rolled.reduce((sum, r) => sum + r.count, 0);
      while (total > roomMax && rolled.length > 0) {
        let largest = 0;
        for (let i = 1; i < rolled.length; i++) if (rolled[i].count > rolled[largest].count) largest = i;
        rolled[largest].count--;
        total--;
        if (rolled[largest].count <= 0) rolled.splice(largest, 1);
      }
      for (const r of rolled) add(r.id, r.count * weight);
      return;
    }
    const entry = pool[index];
    const outcomes = entry.max - entry.min + 1;
    for (let count = entry.min; count <= entry.max; count++) walk(index + 1, [...counts, { id: entry.monsterId, count }], weight / outcomes);
  };
  walk(0, [], 1);
  return pack;
}

/** Items a won fight of each encounter drops to the party as a whole, indexed like `encounterIds`. */
export function encounterDropTables(content: XpSnapshot, mod: any, encounterIds: readonly string[], rewardMultiplier: number): Map<string, number>[] {
  const pace = { rewardMultiplier };
  return encounterIds.map(id => {
    const drops = new Map<string, number>();
    for (const [monsterId, count] of expectedPack(content.encounters[id], content.monsters)) {
      for (const drop of (content.monsters[monsterId]?.drops ?? []) as { itemId: string; chance: number }[]) {
        drops.set(drop.itemId, (drops.get(drop.itemId) ?? 0) + count * mod.paceDropChance(pace, drop.chance));
      }
    }
    return drops;
  });
}

function midValue(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface GearNeed {
  level: number;
  /** Raw units one craft of this gear recipe takes. */
  quantity: number;
  /** Every way this recipe takes it passes through a part a shop also sells. */
  viaShop: boolean;
}

/** What one craft of each gear recipe takes of each raw material, walking down through the parts. */
function gearNeeds(recipes: readonly any[], content: XpSnapshot, sold: ReadonlySet<string>): Map<string, GearNeed[]> {
  const byResult = new Map(recipes.map(r => [r.result?.itemId, r]));
  const needs = new Map<string, GearNeed[]>();
  const walk = (recipe: any, runs: number, viaShop: boolean, path: ReadonlySet<string>, totals: Map<string, { quantity: number; viaShop: boolean }>): void => {
    for (const ingredient of recipe.ingredients ?? []) {
      const quantity = runs * (ingredient.quantity ?? 1);
      const part = byResult.get(ingredient.itemId);
      if (part && !path.has(ingredient.itemId)) {
        walk(part, quantity / (part.result?.quantity ?? 1), viaShop || sold.has(ingredient.itemId), new Set([...path, ingredient.itemId]), totals);
        continue;
      }
      const held = totals.get(ingredient.itemId);
      totals.set(ingredient.itemId, { quantity: (held?.quantity ?? 0) + quantity, viaShop: viaShop && (held?.viaShop ?? true) });
    }
  };
  for (const recipe of recipes) {
    if (!content.items[recipe.result?.itemId]?.equipSlot) continue;
    const totals = new Map<string, { quantity: number; viaShop: boolean }>();
    walk(recipe, 1, false, new Set([recipe.result?.itemId]), totals);
    for (const [itemId, total] of totals) needs.set(itemId, [...(needs.get(itemId) ?? []), { level: recipe.requiredLevel ?? 1, quantity: total.quantity, viaShop: total.viaShop }]);
  }
  return needs;
}

/** Ingredients nobody crafts, read from this snapshot, so a rework's recipes and drops score as written. */
export function buildMaterials(content: XpSnapshot, mod: any): MaterialInfo[] {
  const recipes = Object.values((content as any).recipes ?? {}) as any[];
  const crafted = new Set(recipes.map(r => r.result?.itemId));
  const sold = new Set(Object.values(content.shops).flatMap(shop => (shop.inventory ?? []).map(entry => entry.itemId)));
  const needs = gearNeeds(recipes, content, sold);
  const uses = new Map<string, { level: number; quantity: number }[]>();
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients ?? []) {
      if (crafted.has(ingredient.itemId)) continue;
      const list = uses.get(ingredient.itemId) ?? [];
      list.push({ level: recipe.requiredLevel ?? 1, quantity: ingredient.quantity ?? 1 });
      uses.set(ingredient.itemId, list);
    }
  }
  const monstersDropping = new Map<string, string[]>();
  for (const monster of Object.values(content.monsters) as any[]) {
    for (const drop of monster.drops ?? []) monstersDropping.set(drop.itemId, [...(monstersDropping.get(drop.itemId) ?? []), monster.id]);
  }
  const floors = new Map<string, FloorSource[]>();
  const free = new Map<string, number>();
  const addFree = (itemId: string, units: number): void => {
    free.set(itemId, (free.get(itemId) ?? 0) + units);
  };
  for (const dungeon of Object.values(content.dungeons) as any[]) {
    (dungeon.floors ?? []).forEach((floor: any, floorIndex: number) => {
      for (const reward of floor.rewards ?? []) {
        floors.set(reward.itemId, [...(floors.get(reward.itemId) ?? []), { dungeonId: dungeon.id, floorIndex, chance: reward.chance, quantity: meanQuantity(reward), classes: reward.classRestriction ?? [] }]);
      }
    });
    for (const reward of dungeon.firstClearRewards ?? []) addFree(reward.itemId, reward.chance * meanQuantity(reward));
  }
  for (const quest of Object.values(content.quests ?? {}) as any[]) {
    if ((quest.repeat ?? 'once') !== 'once') continue;
    for (const reward of quest.rewards ?? []) if (reward.kind === 'item') addFree(reward.itemId, reward.quantity ?? 1);
  }
  return [...uses].map(([id, used]) => {
    const gear = needs.get(id) ?? [];
    const required = gear.filter(g => !g.viaShop);
    const levels = [...used.map(u => u.level), ...required.map(g => g.level)];
    const quantities = (required.length ? required : gear.length ? gear : used).map(u => u.quantity);
    const monsterIds = monstersDropping.get(id) ?? [];
    return {
      id,
      name: content.items[id]?.name ?? id,
      minLevel: Math.min(...levels),
      maxLevel: Math.max(...levels),
      perCraft: midValue(quantities),
      usedByGear: required.length > 0,
      savesGoldOnly: gear.length > 0 && required.length === 0,
      monsterIds,
      floors: floors.get(id) ?? [],
      bossToken: monsterIds.length > 0 && monsterIds.every(m => BOSS_TIERS.includes(mod.effectiveMonsterTier(content.monsters[m]))),
      shopSold: sold.has(id),
      freeOnce: free.get(id) ?? 0,
      classes: content.items[id]?.classRestriction ?? [],
    };
  }).sort((a, b) => a.minLevel - b.minLevel || a.id.localeCompare(b.id));
}

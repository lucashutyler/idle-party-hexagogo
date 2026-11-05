import { buildRegions } from './policy.js';
import type { ContentSnapshot, EncounterEntry } from './types.js';

export interface Factors {
  global?: number;
  /** By world map id. */
  regions?: Record<string, number>;
  /** Proven outliers and fitted per-monster values. */
  monsters?: Record<string, number>;
}

export interface TierRules {
  /** A floor monster at this share of the boss floor's strongest HP or more is a boss too. */
  bossFloorShare: number;
  /** Room-table monster against the median HP of its band: at or above this it is a capstone boss. */
  capstoneHpRatio: number;
  eliteHpRatio: number;
  /** Levels either side of a monster that count as its band. */
  bandLevels: number;
  overrides?: Record<string, string>;
}

export interface IntervalRules {
  boss: number;
  elite: number;
  heavy: number;
  normal: number;
  skirmisher: number;
  /** Per-hit damage against the band median. */
  heavyRatio: number;
  skirmisherRatio: number;
  /** A skill must stay ready at most every this many actions, or it would replace every auto. */
  minActionsPerSkill: number;
  overrides?: Record<string, number>;
}

export interface SkillPatch {
  cooldown?: number;
  castTime?: number;
  warmup?: number;
  trigger?: string;
  /** Shallow-merged into the effect of the same index. */
  effects?: Record<number, Record<string, unknown>>;
  /** Appended, unless the skill already carries that kind. */
  addPassiveEffects?: Record<string, unknown>[];
}

/** Monster skill values: one cast is not DPS, so the per-monster damage factors stay out of them. */
export interface MonsterSkillRules {
  /** By monster skill id; absent uses the global x region damage factor. */
  bySkill?: Record<string, number>;
  /** On top, by monster id. */
  monsters?: Record<string, number>;
  /** Monster heals grow with the monster's HP factor. */
  healFollowsHp?: boolean;
}

export interface ReworkConfig {
  hp: Factors;
  damage: Factors;
  xp: Factors;
  gold: Factors;
  drop: Factors;
  monsterSkills?: MonsterSkillRules;
  tiers: TierRules;
  intervals: IntervalRules;
  levelOverrides?: Record<string, number>;
  items: {
    drFactor: number;
    mrFactor: number;
    /** Weapon attack factor for items only these classes can equip; shared items are left alone. */
    weaponAtkByClass?: Record<string, number>;
  };
  /** Lowest chance a quest-collect drop is scaled down to, so that a collect objective stays readable. */
  questDropFloor?: number;
  /** Exact gold rolls by monster; beats the gold factors. Small rolls cannot be scaled smoothly. */
  goldRanges?: Record<string, [number, number]>;
  /** Rating passives (Guard, Bless and their grant-only variants) adopt this valuePerLevel. */
  ratingValuePerLevel: number;
  skills?: Record<string, SkillPatch>;
  /** Descending thresholds for boss floors. */
  checkpoints: number[];
  /** Copied onto fitted enrages of bosses on checkpointed floors: a wipe there costs a regroup, not the run. */
  enrageSteps?: { stepSeconds?: number; stepPercent?: number; maxStacks?: number };
  /** Explicit enrage per boss; absent keeps the tier default. */
  enrage?: Record<string, { afterSeconds: number; stepSeconds?: number; stepPercent?: number; maxStacks?: number }>;
  henchmen?: Record<string, { maxHp?: number; baseDamage?: number }>;
  /** Replacement descriptions by section and id. */
  text?: Partial<Record<TextSection, Record<string, string>>>;
}

type TextSection = 'skills' | 'monsters' | 'dungeons' | 'henchmen' | 'quests' | 'recipes';

export const DEFAULT_REWORK_CONFIG: ReworkConfig = {
  hp: { global: 2 },
  damage: { global: 1 },
  xp: { global: 0.45 },
  gold: { global: 0.45 },
  drop: { global: 0.45 },
  tiers: { bossFloorShare: 0.6, capstoneHpRatio: 5, eliteHpRatio: 2.5, bandLevels: 3 },
  intervals: { boss: 3, elite: 2.5, heavy: 2.5, normal: 1.5, skirmisher: 1, heavyRatio: 1.4, skirmisherRatio: 0.7, minActionsPerSkill: 2 },
  items: { drFactor: 3, mrFactor: 5 },
  ratingValuePerLevel: 2,
  checkpoints: [0.66, 0.33],
};

export interface ChangeEntry {
  section: string;
  id: string;
  name: string;
  changes: string[];
}

export interface ReworkResult {
  content: ContentSnapshot & Record<string, any>;
  changelog: ChangeEntry[];
}

export type UsageKind = 'zone' | 'room' | 'floor' | 'bossFloor';

export interface MonsterUsage {
  kind: UsageKind;
  zoneId: string;
  regionId: string;
  level: number;
  dungeonId?: string;
  floorIndex?: number;
}

const encounterMonsterIds = (encounter: any): string[] =>
  [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])].map((p: any) => p.monsterId);

function midLevel(range: readonly number[]): number {
  return Math.round((range[0] + range[1]) / 2);
}

/** Every place an encounter table can field each monster: zone tables, room tables and dungeon floors. */
export function collectMonsterUsage(content: ContentSnapshot): Map<string, MonsterUsage[]> {
  const { zoneRegion } = buildRegions(content);
  const usage = new Map<string, MonsterUsage[]>();
  const add = (table: readonly EncounterEntry[] | undefined, make: () => MonsterUsage | null): void => {
    for (const entry of table ?? []) {
      for (const id of encounterMonsterIds(content.encounters[entry.encounterId])) {
        const place = make();
        if (!place) continue;
        const list = usage.get(id) ?? [];
        list.push(place);
        usage.set(id, list);
      }
    }
  };
  const inZone = (kind: UsageKind, zoneId: string): MonsterUsage | null => {
    const zone = content.zones[zoneId];
    const region = zoneRegion.get(zoneId);
    return zone && region ? { kind, zoneId, regionId: region.id, level: midLevel(zone.levelRange) } : null;
  };
  for (const zone of Object.values(content.zones)) add(zone.encounterTable, () => inZone('zone', zone.id));
  for (const tile of content.world.tiles) add(tile.encounterTable, () => inZone('room', tile.zone));
  for (const dungeon of Object.values(content.dungeons)) {
    const entrance = content.world.tiles.find(t => t.dungeonId === dungeon.id);
    if (!entrance) continue;
    const minLevel = dungeon.entryRequirements?.minLevel ?? 1;
    (dungeon.floors ?? []).forEach((floor: any, floorIndex: number) => {
      add(floor.encounterTable, () => {
        const place = inZone(floor.isBoss ? 'bossFloor' : 'floor', entrance.zone);
        return place && { ...place, level: Math.max(place.level, minLevel), dungeonId: dungeon.id, floorIndex };
      });
    });
  }
  return usage;
}

function earliest(places: readonly MonsterUsage[]): MonsterUsage {
  return places.reduce((best, p) => (p.level < best.level ? p : best));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function factorFor(f: Factors, id: string, regionId: string | undefined): number {
  return (f.global ?? 1) * (regionId ? f.regions?.[regionId] ?? 1 : 1) * (f.monsters?.[id] ?? 1);
}

interface BandStats {
  hp: number;
  damage: number;
}

/** Medians over the ordinary monsters within a few levels, ignoring anything strong enough to skew them. */
function bandStats(level: number, levels: Map<string, number>, ordinaryIds: ReadonlySet<string>, monsters: Record<string, any>, band: number): BandStats {
  const near = [...ordinaryIds].filter(id => Math.abs(levels.get(id)! - level) <= band).map(id => monsters[id]);
  const pool = near.length ? near : [...ordinaryIds].map(id => monsters[id]);
  return { hp: median(pool.map(m => m.hp)), damage: median(pool.map(m => m.damage).filter(d => d > 0)) };
}

export function classifyTier(
  monster: any,
  places: readonly MonsterUsage[],
  band: BandStats,
  bossFloorMaxHp: (place: MonsterUsage) => number,
  rules: TierRules,
): string {
  const override = rules.overrides?.[monster.id];
  if (override) return override;
  if (places.some(p => p.kind === 'bossFloor' && monster.hp >= rules.bossFloorShare * bossFloorMaxHp(p))) return 'boss';
  const onlyPlacedByRooms = places.every(p => p.kind === 'room' || p.kind === 'floor' || p.kind === 'bossFloor');
  if (onlyPlacedByRooms && monster.hp >= rules.capstoneHpRatio * band.hp) return 'boss';
  if (monster.hp >= rules.eliteHpRatio * band.hp) return 'elite';
  return 'trash';
}

export function chooseInterval(monster: any, tier: string, band: BandStats, rules: IntervalRules): number {
  const override = rules.overrides?.[monster.id];
  if (override) return override;
  const ratio = monster.damage / band.damage;
  let interval = rules.normal;
  if (tier === 'boss' || tier === 'raid') interval = rules.boss;
  else if (tier === 'elite') interval = rules.elite;
  else if (ratio >= rules.heavyRatio) interval = rules.heavy;
  else if (ratio <= rules.skirmisherRatio) interval = rules.skirmisher;
  return Math.round(Math.min(interval, skillIntervalCap(monster, rules)) * 10) / 10;
}

function skillIntervalCap(monster: any, rules: IntervalRules): number {
  const shortest = Math.min(...(monster.skills ?? []).map((s: any) => s.cooldown).filter((c: number) => c > 0), Infinity);
  return Number.isFinite(shortest) ? Math.max(1, shortest / rules.minActionsPerSkill) : Infinity;
}

function scaleBounds(item: any, keys: readonly [string, string], factor: number): boolean {
  const [lo, hi] = keys;
  if (item[lo] === undefined && item[hi] === undefined) return false;
  if (item[lo] !== undefined) item[lo] = Math.round(item[lo] * factor);
  if (item[hi] !== undefined) item[hi] = Math.round(item[hi] * factor);
  return true;
}

function questItemIds(content: Record<string, any>): Set<string> {
  const ids = new Set<string>();
  for (const quest of Object.values<any>(content.quests ?? {})) {
    for (const objective of quest.objectives ?? []) {
      if (objective.kind === 'collect') ids.add(objective.itemId);
    }
  }
  return ids;
}

function primaryEffectKind(skill: any): string | undefined {
  return (skill.activeEffects ?? skill.passiveEffects ?? [])[0]?.kind;
}

const WEAPON_SLOTS = new Set(['mainhand', 'offhand', 'twohanded']);
const RATING_KINDS = new Set(['physical_reduction', 'magical_reduction_party']);
const SEED_TIMING_FIELDS = ['castTime', 'warmup', 'trigger'] as const;

function reworkSkills(content: Record<string, any>, config: ReworkConfig, seedSkills: Record<string, any>, log: (section: string, entity: any, changes: string[]) => void): void {
  const leveled = Object.values<any>(content.skills).filter(s => typeof s.unlockLevel === 'number');
  for (const skill of Object.values<any>(content.skills)) {
    const changes: string[] = [];
    const parent = seedSkills[skill.id] ?? (skill.unlockLevel == null
      ? leveled.find(p => p.className === skill.className && p.type === skill.type && primaryEffectKind(p) === primaryEffectKind(skill))
      : undefined);
    const source = parent && seedSkills[parent.id] ? seedSkills[parent.id] : parent;
    if (source && skill.type === 'active') {
      for (const field of SEED_TIMING_FIELDS) {
        if (source[field] !== undefined && skill[field] !== source[field]) {
          changes.push(`${field}: ${skill[field] ?? '-'} > ${source[field]}`);
          skill[field] = source[field];
        }
      }
    }
    for (const effect of skill.passiveEffects ?? []) {
      if (RATING_KINDS.has(effect.kind) && effect.valuePerLevel !== config.ratingValuePerLevel) {
        changes.push(`valuePerLevel: ${effect.valuePerLevel} > ${config.ratingValuePerLevel}`);
        effect.valuePerLevel = config.ratingValuePerLevel;
      }
    }
    const patch = config.skills?.[skill.id];
    if (patch) {
      for (const field of ['cooldown', 'castTime', 'warmup', 'trigger'] as const) {
        if (patch[field] !== undefined && skill[field] !== patch[field]) {
          changes.push(`${field}: ${skill[field] ?? '-'} > ${patch[field]}`);
          skill[field] = patch[field];
        }
      }
      const effects = skill.activeEffects ?? skill.passiveEffects ?? [];
      for (const [index, fields] of Object.entries(patch.effects ?? {})) {
        const effect = effects[Number(index)];
        if (!effect) continue;
        for (const [key, value] of Object.entries(fields)) {
          if (effect[key] !== value) changes.push(`${effect.kind}.${key}: ${effect[key] ?? '-'} > ${value}`);
          effect[key] = value;
        }
      }
      for (const added of patch.addPassiveEffects ?? []) {
        if (skill.passiveEffects?.some((e: any) => e.kind === added.kind)) continue;
        skill.passiveEffects = [...(skill.passiveEffects ?? []), { ...added }];
        changes.push(`gains ${added.kind}`);
      }
    }
    log('skills', skill, changes);
  }
}

function applyText(section: TextSection, entries: Record<string, any>, config: ReworkConfig, changelog: ChangeEntry[]): void {
  for (const [id, text] of Object.entries(config.text?.[section] ?? {})) {
    const entity = entries[id];
    if (!entity || entity.description === text) continue;
    entity.description = text;
    const existing = changelog.find(c => c.section === section && c.id === id);
    if (existing) existing.changes.push('description rewritten');
    else changelog.push({ section, id, name: entity.name ?? id, changes: ['description rewritten'] });
  }
}

function roundDamage(raw: number): number {
  return raw > 0 ? Math.max(1, Math.round(raw)) : 0;
}

/** Below this per-hit size rounding would move DPS noticeably, so the interval absorbs it instead. */
const SMALL_HIT = 10;

/** A hit too small to round well: the interval absorbs the rounding, but never past a set interval or the skill cap. */
function absorbSmallHit(monster: any, interval: number, damage: number, dps: number, rules: IntervalRules): number {
  if (damage <= 0 || damage >= SMALL_HIT || rules.overrides?.[monster.id]) return interval;
  return Math.min(clamp(Math.round((damage / dps) * 10) / 10, 0.5, rules.boss), skillIntervalCap(monster, rules));
}

function monsterSkillValue(skill: any, original: any, monster: any, rules: MonsterSkillRules | undefined, defaultFactor: number): number {
  const extra = rules?.monsters?.[monster.id] ?? 1;
  if (skill.skillId === 'heal') {
    const grown = rules?.healFollowsHp ? monster.hp / original.hp : 1;
    return Math.max(1, Math.round(skill.value * grown * extra));
  }
  return Math.max(1, Math.round(skill.value * (rules?.bySkill?.[skill.skillId] ?? defaultFactor) * extra));
}

function reworkMonsters(
  content: Record<string, any>,
  config: ReworkConfig,
  usage: Map<string, MonsterUsage[]>,
  questItems: ReadonlySet<string>,
  log: (section: string, entity: any, changes: string[]) => void,
): void {
  const monsters: Record<string, any> = content.monsters;
  const pristine: Record<string, any> = structuredClone(monsters);
  const levels = new Map<string, number>();
  for (const [id, places] of usage) {
    if (monsters[id]) levels.set(id, clamp(config.levelOverrides?.[id] ?? earliest(places).level, 1, 200));
  }
  const ordinaryIds = new Set([...usage].filter(([id, places]) => monsters[id] && !monsters[id].passive && places.some(p => p.kind === 'zone')).map(([id]) => id));
  const bossFloorMax = (place: MonsterUsage): number => {
    const floor = content.dungeons[place.dungeonId!].floors[place.floorIndex!];
    const ids = (floor.encounterTable ?? []).flatMap((e: EncounterEntry) => encounterMonsterIds(content.encounters[e.encounterId]));
    return Math.max(0, ...ids.map((id: string) => pristine[id]).filter((m: any) => m && !m.passive).map((m: any) => m.hp));
  };

  for (const [id, places] of usage) {
    const monster = monsters[id];
    if (!monster) continue;
    const changes: string[] = [];
    const regionId = earliest(places).regionId;
    const original = pristine[id];
    if (monster.hp > 1) monster.hp = Math.max(1, Math.round(monster.hp * factorFor(config.hp, id, regionId)));
    if (monster.hp !== original.hp) changes.push(`hp: ${original.hp} > ${monster.hp}`);

    if (!monster.passive) {
      const level = levels.get(id)!;
      const band = bandStats(level, levels, ordinaryIds, pristine, config.tiers.bandLevels);
      const tier = classifyTier(original, places, band, bossFloorMax, config.tiers);
      const dpsFactor = factorFor(config.damage, id, regionId);
      const chosen = chooseInterval(original, tier, band, config.intervals);
      const damage = roundDamage(original.damage * dpsFactor * chosen);
      const interval = absorbSmallHit(original, chosen, damage, original.damage * dpsFactor, config.intervals);
      monster.level = level;
      monster.tier = tier;
      monster.attackInterval = interval;
      monster.damage = damage;
      changes.push(`level ${level}, tier ${tier}, interval ${interval} s`);
      if (damage !== original.damage) changes.push(`damage: ${original.damage} > ${damage}`);
      for (const skill of monster.skills ?? []) {
        if (skill.skillId === 'fear' || !skill.value) continue;
        const value = monsterSkillValue(skill, original, monster, config.monsterSkills, factorFor({ global: config.damage.global, regions: config.damage.regions }, id, regionId));
        if (value !== skill.value) changes.push(`${skill.skillId} value: ${skill.value} > ${value}`);
        skill.value = value;
      }
      const enrage = config.enrage?.[id];
      if (enrage) {
        monster.enrage = enrage;
        changes.push(`enrage after ${enrage.afterSeconds} s`);
      }
    }

    if (monster.xp > 0) {
      monster.xp = Math.max(1, Math.round(monster.xp * factorFor(config.xp, id, regionId)));
      if (monster.xp !== original.xp) changes.push(`xp: ${original.xp} > ${monster.xp}`);
    }
    const goldFactor = factorFor(config.gold, id, regionId);
    const goldRange = config.goldRanges?.[id];
    if (monster.goldMax > 0) {
      monster.goldMin = goldRange ? goldRange[0] : Math.round(monster.goldMin * goldFactor);
      monster.goldMax = goldRange ? goldRange[1] : Math.max(monster.goldMin, 1, Math.round(monster.goldMax * goldFactor));
      if (monster.goldMax !== original.goldMax || monster.goldMin !== original.goldMin) changes.push(`gold: ${original.goldMin}-${original.goldMax} > ${monster.goldMin}-${monster.goldMax}`);
    }
    const dropFactor = factorFor(config.drop, id, regionId);
    for (const drop of monster.drops ?? []) {
      if (drop.chance >= 0.5) continue;
      const floor = questItems.has(drop.itemId) ? Math.min(drop.chance, config.questDropFloor ?? 0) : 0;
      const chance = Number(Math.min(1, Math.max(floor, drop.chance * dropFactor)).toPrecision(3));
      if (chance !== drop.chance) changes.push(`drop ${drop.itemId}: ${drop.chance} > ${chance}`);
      drop.chance = chance;
    }
    log('monsters', monster, changes);
  }
}

function reworkItems(content: Record<string, any>, config: ReworkConfig, log: (section: string, entity: any, changes: string[]) => void): void {
  const { drFactor, mrFactor, weaponAtkByClass } = config.items;
  const scale = (holder: any): string[] => {
    const before = [holder.damageReductionMin, holder.damageReductionMax, holder.magicReductionMin, holder.magicReductionMax];
    scaleBounds(holder, ['damageReductionMin', 'damageReductionMax'], drFactor);
    scaleBounds(holder, ['magicReductionMin', 'magicReductionMax'], mrFactor);
    const after = [holder.damageReductionMin, holder.damageReductionMax, holder.magicReductionMin, holder.magicReductionMax];
    return before.join() === after.join() ? [] : [`DR ${before[0] ?? 0}-${before[1] ?? 0} > ${after[0] ?? 0}-${after[1] ?? 0}, MR ${before[2] ?? 0}-${before[3] ?? 0} > ${after[2] ?? 0}-${after[3] ?? 0}`];
  };
  const scaleWeapon = (item: any): string[] => {
    const factors = (item.classRestriction ?? []).map((c: string) => weaponAtkByClass?.[c]);
    if (!WEAPON_SLOTS.has(item.equipSlot) || !factors.length || factors.includes(undefined) || !item.bonusAttackMax) return [];
    const before = `${item.bonusAttackMin ?? 0}-${item.bonusAttackMax}`;
    item.bonusAttackMin = Math.round((item.bonusAttackMin ?? 0) * Math.min(...factors));
    item.bonusAttackMax = Math.round(item.bonusAttackMax * Math.min(...factors));
    return [`attack ${before} > ${item.bonusAttackMin}-${item.bonusAttackMax}`];
  };
  for (const item of Object.values<any>(content.items)) {
    // heirloom stats already multiply by the wearer's level in computeEquipmentBonuses
    if (item.rarity !== 'heirloom') log('items', item, [...scale(item), ...scaleWeapon(item)]);
  }
  for (const set of Object.values<any>(content.sets)) {
    log('sets', set, set.breakpoints.flatMap((b: any) => scale(b.bonuses).map(c => `${b.piecesRequired} pieces: ${c}`)));
  }
}

function reworkBossFloors(content: Record<string, any>, config: ReworkConfig, log: (section: string, entity: any, changes: string[]) => void): void {
  for (const dungeon of Object.values<any>(content.dungeons)) {
    const changes: string[] = [];
    (dungeon.floors ?? []).forEach((floor: any, index: number) => {
      if (!floor.isBoss) return;
      const canField = (floor.encounterTable ?? []).some((e: EncounterEntry) =>
        encounterMonsterIds(content.encounters[e.encounterId]).some(id => {
          const m = content.monsters[id];
          return m && !m.passive && (m.tier === 'boss' || m.tier === 'raid');
        }));
      if (!canField) {
        changes.push(`floor ${index + 1}: no boss to checkpoint`);
        return;
      }
      floor.checkpoints = [...config.checkpoints];
      changes.push(`floor ${index + 1}: checkpoints ${config.checkpoints.join(', ')}`);
    });
    log('dungeons', dungeon, changes);
  }
}

/** Share of referenced monsters already carrying the authored fields above which an input counts as reworked. */
const ALREADY_REWORKED_SHARE = 0.5;

/** Factors multiply, so a second pass compounds: HP and damage are scaled again on top of the first pass. */
export function isAlreadyReworked(snapshot: ContentSnapshot): boolean {
  const used = [...collectMonsterUsage(snapshot).keys()].map(id => snapshot.monsters[id]).filter(m => m && !m.passive);
  const authored = used.filter(m => m.tier !== undefined && m.attackInterval !== undefined);
  return used.length > 0 && authored.length / used.length >= ALREADY_REWORKED_SHARE;
}

/** Snapshot + config > a new snapshot and its changelog; the input is not touched. */
export function rework(snapshot: ContentSnapshot, config: ReworkConfig, seedSkills: Record<string, any>, opts: { force?: boolean } = {}): ReworkResult {
  if (!opts.force && isAlreadyReworked(snapshot)) {
    throw new Error('this snapshot already carries the rework; run it on a pre-rework export (or pass force to compound on purpose)');
  }
  const content = structuredClone(snapshot) as ContentSnapshot & Record<string, any>;
  const changelog: ChangeEntry[] = [];
  const log = (section: string, entity: any, changes: string[]): void => {
    if (changes.length) changelog.push({ section, id: entity.id, name: entity.name ?? entity.displayName ?? entity.id, changes });
  };
  reworkSkills(content, config, seedSkills, log);
  reworkItems(content, config, log);
  reworkMonsters(content, config, collectMonsterUsage(content), questItemIds(content), log);
  reworkBossFloors(content, config, log);
  for (const [id, patch] of Object.entries(config.henchmen ?? {})) {
    const hire = content.henchmen[id];
    if (!hire) continue;
    const changes: string[] = [];
    if (patch.maxHp !== undefined && patch.maxHp !== hire.maxHp) changes.push(`maxHp: ${hire.maxHp} > ${patch.maxHp}`);
    if (patch.baseDamage !== undefined && patch.baseDamage !== hire.baseDamage) changes.push(`baseDamage: ${hire.baseDamage} > ${patch.baseDamage}`);
    Object.assign(hire, patch);
    log('henchmen', hire, changes);
  }
  applyText('skills', content.skills, config, changelog);
  applyText('monsters', content.monsters, config, changelog);
  applyText('dungeons', content.dungeons, config, changelog);
  applyText('henchmen', content.henchmen, config, changelog);
  applyText('quests', content.quests ?? {}, config, changelog);
  applyText('recipes', content.recipes ?? {}, config, changelog);
  return { content, changelog };
}

const STALE_SCAN_SECTIONS = ['skills', 'monsters', 'dungeons', 'henchmen', 'recipes', 'items', 'sets', 'quests', 'npcs', 'zones', 'tileTypes'];

/** The old engine counted rounds and turns; a description still using them no longer tells the truth. */
const STALE_DESCRIPTION = /\b(rounds?|turns?|ticks?)\b/i;

export function staleDescriptions(content: Record<string, any>): { section: string; id: string; text: string }[] {
  const stale: { section: string; id: string; text: string }[] = [];
  for (const section of STALE_SCAN_SECTIONS) {
    for (const entity of Object.values<any>(content[section] ?? {})) {
      if (STALE_DESCRIPTION.test(entity.description ?? '')) stale.push({ section, id: entity.id, text: entity.description });
    }
  }
  return stale;
}

export function renderChangelog(changelog: readonly ChangeEntry[]): string {
  const sections = [...new Set(changelog.map(c => c.section))];
  const parts = ['# Content rework changelog', '', ...sections.map(s => `- ${s}: ${changelog.filter(c => c.section === s).length} changed`), ''];
  for (const section of sections) {
    parts.push(`## ${section}`, '');
    for (const entry of changelog.filter(c => c.section === section)) parts.push(`- **${entry.name}** (\`${entry.id}\`): ${entry.changes.join('; ')}`);
    parts.push('');
  }
  return parts.join('\n');
}

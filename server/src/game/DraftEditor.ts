import crypto from 'crypto';
import type { VersionStore, ContentSnapshot } from './VersionStore.js';
import type { ContentStore } from './ContentStore.js';
import type {
  MonsterDefinition,
  ItemDefinition,
  ZoneDefinition,
  EncounterDefinition,
  SetDefinition,
  ShopDefinition,
  TileTypeDefinition,
  RecipeDefinition,
  NpcDefinition,
  QuestDefinition,
  DungeonDefinition,
  SkillDefinition,
  SkillSlot,
  DesignNote,
  WorldTileDefinition,
  WorldMapMeta,
} from '@idle-party-rpg/shared';
import { migrateLegacySet, migrateLegacySkill, findSetConflicts, validateSkillDefinition, SEED_TILE_TYPES, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '@idle-party-rpg/shared';

/** Content types editable through the generic (MCP) draft-write surface. Single source of truth — derive z.enum(...) lists from this array, don't hand-copy the literals. */
export const DRAFT_CONTENT_TYPES = [
  'monsters', 'items', 'sets', 'shops', 'recipes', 'npcs',
  'quests', 'dungeons', 'zones', 'encounters', 'tileTypes',
  'skills', 'designNotes',
] as const;

export type DraftContentType = (typeof DRAFT_CONTENT_TYPES)[number];

export type DraftResult<T> =
  | { success: true; snapshot: ContentSnapshot; entries: T[] }
  | { success: false; status: 404 | 400; error: string };

export type DraftWorldResult =
  | { success: true; world: ContentSnapshot['world'] }
  | { success: false; status: 404 | 400; error: string };

export type DraftSkillSlotsResult =
  | { success: true; skillSlotSchedules: { className: string; slots: SkillSlot[] }[] }
  | { success: false; status: 404 | 400; error: string };

/**
 * Build a `Record<id, entry>` from an array — the shape every admin route responds with.
 * Uses a null-prototype object so a caller-supplied id of "__proto__" (or "constructor"/
 * "prototype") becomes an ordinary own key instead of silently reassigning the object's
 * prototype (which would make the entry invisible to Object.keys/JSON.stringify).
 */
export function toRecord<T extends { id: string }>(arr: T[]): Record<string, T> {
  const record: Record<string, T> = Object.create(null);
  for (const entry of arr) record[entry.id] = entry;
  return record;
}

/**
 * Central place for mutating a DRAFT version's content snapshot. Every admin route's
 * `?versionId=` branch and every MCP write tool go through here so the "load draft →
 * guard → validate → mutate → save" plumbing and the referential-integrity guards live
 * in one place instead of being duplicated per surface (see docs/architecture/mcp.md).
 *
 * Every public method loads the draft once and persists once. Bulk operations
 * (`upsertContentBulk`, `upsertTilesBulk`, `deleteTilesBulk`) load ONCE, apply every
 * entry to the in-memory snapshot, and persist ONCE at the end — a failure partway
 * through aborts without persisting anything (all-or-nothing), rather than the N
 * separate loads/saves a naive per-entry loop would do.
 *
 * Live (non-draft) content edits are unaffected — those still go through `ContentStore`
 * directly from `adminRoutes.ts`.
 */
export class DraftEditor {
  constructor(private versions: VersionStore, private liveContent: () => ContentStore) {}

  // --- Core plumbing ---

  /** Loads a draft snapshot, or an error if the version doesn't exist / isn't a draft. */
  private async loadDraft(versionId: string): Promise<{ snapshot: ContentSnapshot } | { error: string; status: 404 | 400 }> {
    const version = this.versions.get(versionId);
    if (!version) return { error: 'Version not found.', status: 404 };
    if (version.status !== 'draft') return { error: 'Only drafts can be edited.', status: 400 };
    const snapshot = await this.versions.loadSnapshot(versionId);
    return { snapshot };
  }

  private async persist(versionId: string, snapshot: ContentSnapshot): Promise<void> {
    await this.versions.saveSnapshot(versionId, snapshot);
  }

  // --- Monster CRUD ---

  private upsertMonsterCore(snapshot: ContentSnapshot, monster: MonsterDefinition): string | null {
    const idx = snapshot.monsters.findIndex(m => m.id === monster.id);
    if (idx >= 0) snapshot.monsters[idx] = monster; else snapshot.monsters.push(monster);
    return null;
  }

  async upsertMonster(versionId: string, monster: MonsterDefinition): Promise<DraftResult<MonsterDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertMonsterCore(snapshot, monster);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.monsters };
  }

  // No referential guard on delete — mirrors ContentStore.deleteMonster (nothing in the
  // schema references a monster by id directly; encounters reference via monsterPool,
  // which validate_draft flags rather than blocking deletion outright).
  private deleteMonsterCore(snapshot: ContentSnapshot, id: string): string | null {
    const idx = snapshot.monsters.findIndex(m => m.id === id);
    if (idx < 0) return 'Monster not found.';
    snapshot.monsters.splice(idx, 1);
    return null;
  }

  async deleteMonster(versionId: string, id: string): Promise<DraftResult<MonsterDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteMonsterCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.monsters };
  }

  // --- Item CRUD ---

  private upsertItemCore(snapshot: ContentSnapshot, item: ItemDefinition): string | null {
    const grantedSkillIds = item.grantedSkillIds ?? [];
    if (grantedSkillIds.length > 0) {
      // Snapshots that predate skills have no skills key — materialize live skills into
      // the snapshot (not just for validation) so the draft ships a real catalog on deploy.
      if (snapshot.skills === undefined) {
        snapshot.skills = Object.values(this.liveContent().getAllSkills());
      }
      const draftSkillIds = new Set(snapshot.skills.map(s => s.id));
      const unknownGrants = grantedSkillIds.filter(sid => !draftSkillIds.has(sid));
      if (unknownGrants.length > 0) {
        return `Unknown skill id(s) in grantedSkillIds: ${unknownGrants.join(', ')}`;
      }
    }
    const idx = snapshot.items.findIndex(i => i.id === item.id);
    if (idx >= 0) snapshot.items[idx] = item; else snapshot.items.push(item);
    return null;
  }

  async upsertItem(versionId: string, item: ItemDefinition): Promise<DraftResult<ItemDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.upsertItemCore(snapshot, item);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.items };
  }

  private deleteItemCore(snapshot: ContentSnapshot, id: string): string | null {
    const idx = snapshot.items.findIndex(i => i.id === id);
    if (idx < 0) return 'Item not found.';
    const referencingMonster = snapshot.monsters.find(m => m.drops?.some(d => d.itemId === id));
    if (referencingMonster) return `Cannot delete: item is referenced in ${referencingMonster.name}'s drop table.`;
    snapshot.items.splice(idx, 1);
    return null;
  }

  async deleteItem(versionId: string, id: string): Promise<DraftResult<ItemDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteItemCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.items };
  }

  // --- Set CRUD ---

  private upsertSetCore(snapshot: ContentSnapshot, raw: SetDefinition): string | null {
    if (!snapshot.sets) snapshot.sets = [];
    const set = migrateLegacySet(raw);

    const setGrantIds: string[] = [];
    for (const bp of set.breakpoints ?? []) {
      for (const sid of bp.bonuses.grantedSkillIds ?? []) {
        if (!setGrantIds.includes(sid)) setGrantIds.push(sid);
      }
    }
    if (setGrantIds.length > 0) {
      if (snapshot.skills === undefined) {
        snapshot.skills = Object.values(this.liveContent().getAllSkills());
      }
      const draftSkillIds = new Set(snapshot.skills.map(s => s.id));
      const unknownGrants = setGrantIds.filter(sid => !draftSkillIds.has(sid));
      if (unknownGrants.length > 0) {
        return `Unknown skill id(s) in grantedSkillIds: ${unknownGrants.join(', ')}`;
      }
    }

    const existingMigrated = snapshot.sets.filter(s => s.id !== set.id).map(s => migrateLegacySet(s));
    const conflictErrors = findSetConflicts(set, existingMigrated);
    if (conflictErrors.length > 0) return conflictErrors.join(' ');

    const idx = snapshot.sets.findIndex(s => s.id === set.id);
    if (idx >= 0) snapshot.sets[idx] = set; else snapshot.sets.push(set);
    return null;
  }

  async upsertSet(versionId: string, raw: SetDefinition): Promise<DraftResult<SetDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.upsertSetCore(snapshot, raw);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.sets ?? [] };
  }

  // No referential guard on delete — mirrors ContentStore.deleteSet.
  private deleteSetCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.sets) snapshot.sets = [];
    const idx = snapshot.sets.findIndex(s => s.id === id);
    if (idx < 0) return 'Set not found.';
    snapshot.sets.splice(idx, 1);
    return null;
  }

  async deleteSet(versionId: string, id: string): Promise<DraftResult<SetDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteSetCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.sets ?? [] };
  }

  // --- Shop CRUD ---

  private upsertShopCore(snapshot: ContentSnapshot, shop: ShopDefinition): string | null {
    if (!snapshot.shops) snapshot.shops = [];
    const idx = snapshot.shops.findIndex(s => s.id === shop.id);
    if (idx >= 0) snapshot.shops[idx] = shop; else snapshot.shops.push(shop);
    return null;
  }

  async upsertShop(versionId: string, shop: ShopDefinition): Promise<DraftResult<ShopDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertShopCore(snapshot, shop);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.shops ?? [] };
  }

  private deleteShopCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.shops) snapshot.shops = [];
    const idx = snapshot.shops.findIndex(s => s.id === id);
    if (idx < 0) return 'Shop not found.';
    // Mirrors ContentStore.deleteShop's tile-reference guard.
    const referencingTile = snapshot.world.tiles.find(t => t.shopId === id);
    if (referencingTile) return `Cannot delete: shop is used by room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).`;
    snapshot.shops.splice(idx, 1);
    return null;
  }

  async deleteShop(versionId: string, id: string): Promise<DraftResult<ShopDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteShopCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.shops ?? [] };
  }

  // --- Recipe CRUD ---

  private upsertRecipeCore(snapshot: ContentSnapshot, recipe: RecipeDefinition): string | null {
    if (!snapshot.recipes) snapshot.recipes = [];
    const idx = snapshot.recipes.findIndex(r => r.id === recipe.id);
    if (idx >= 0) snapshot.recipes[idx] = recipe; else snapshot.recipes.push(recipe);
    return null;
  }

  async upsertRecipe(versionId: string, recipe: RecipeDefinition): Promise<DraftResult<RecipeDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertRecipeCore(snapshot, recipe);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.recipes ?? [] };
  }

  // No referential guard on delete — mirrors ContentStore.deleteRecipe.
  private deleteRecipeCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.recipes) snapshot.recipes = [];
    const idx = snapshot.recipes.findIndex(r => r.id === id);
    if (idx < 0) return 'Recipe not found.';
    snapshot.recipes.splice(idx, 1);
    return null;
  }

  async deleteRecipe(versionId: string, id: string): Promise<DraftResult<RecipeDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteRecipeCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.recipes ?? [] };
  }

  // --- NPC CRUD ---

  private upsertNpcCore(snapshot: ContentSnapshot, npc: NpcDefinition): string | null {
    if (!snapshot.npcs) snapshot.npcs = [];
    const idx = snapshot.npcs.findIndex(n => n.id === npc.id);
    if (idx >= 0) snapshot.npcs[idx] = npc; else snapshot.npcs.push(npc);
    return null;
  }

  async upsertNpc(versionId: string, npc: NpcDefinition): Promise<DraftResult<NpcDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertNpcCore(snapshot, npc);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.npcs ?? [] };
  }

  private deleteNpcCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.npcs) snapshot.npcs = [];
    const idx = snapshot.npcs.findIndex(n => n.id === id);
    if (idx < 0) return 'NPC not found.';
    const referencingTile = snapshot.world.tiles.find(t => t.npcId === id);
    if (referencingTile) return `Cannot delete: NPC is placed in room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).`;
    snapshot.npcs.splice(idx, 1);
    return null;
  }

  async deleteNpc(versionId: string, id: string): Promise<DraftResult<NpcDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteNpcCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.npcs ?? [] };
  }

  // --- Quest CRUD ---

  private upsertQuestCore(snapshot: ContentSnapshot, quest: QuestDefinition): string | null {
    if (!snapshot.quests) snapshot.quests = [];
    const idx = snapshot.quests.findIndex(q => q.id === quest.id);
    if (idx >= 0) snapshot.quests[idx] = quest; else snapshot.quests.push(quest);
    return null;
  }

  async upsertQuest(versionId: string, quest: QuestDefinition): Promise<DraftResult<QuestDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertQuestCore(snapshot, quest);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.quests ?? [] };
  }

  private deleteQuestCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.quests) snapshot.quests = [];
    const idx = snapshot.quests.findIndex(q => q.id === id);
    if (idx < 0) return 'Quest not found.';
    const offeringNpc = (snapshot.npcs ?? []).find(n => n.questIds?.includes(id));
    if (offeringNpc) return `Cannot delete: quest is offered by NPC "${offeringNpc.name}".`;
    const dependent = snapshot.quests.find(q => q.prerequisiteQuestIds?.includes(id));
    if (dependent) return `Cannot delete: quest is a prerequisite of "${dependent.name}".`;
    snapshot.quests.splice(idx, 1);
    return null;
  }

  async deleteQuest(versionId: string, id: string): Promise<DraftResult<QuestDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteQuestCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.quests ?? [] };
  }

  // --- Dungeon CRUD ---

  private upsertDungeonCore(snapshot: ContentSnapshot, dungeon: DungeonDefinition): string | null {
    if (!snapshot.dungeons) snapshot.dungeons = [];
    const idx = snapshot.dungeons.findIndex(d => d.id === dungeon.id);
    if (idx >= 0) snapshot.dungeons[idx] = dungeon; else snapshot.dungeons.push(dungeon);
    return null;
  }

  async upsertDungeon(versionId: string, dungeon: DungeonDefinition): Promise<DraftResult<DungeonDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertDungeonCore(snapshot, dungeon);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.dungeons ?? [] };
  }

  // No referential guard on delete — mirrors ContentStore.deleteDungeon.
  private deleteDungeonCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.dungeons) snapshot.dungeons = [];
    const idx = snapshot.dungeons.findIndex(d => d.id === id);
    if (idx < 0) return 'Dungeon not found.';
    snapshot.dungeons.splice(idx, 1);
    return null;
  }

  async deleteDungeon(versionId: string, id: string): Promise<DraftResult<DungeonDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteDungeonCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.dungeons ?? [] };
  }

  // --- Zone CRUD ---

  private upsertZoneCore(snapshot: ContentSnapshot, zone: ZoneDefinition): string | null {
    const idx = snapshot.zones.findIndex(z => z.id === zone.id);
    if (idx >= 0) snapshot.zones[idx] = zone; else snapshot.zones.push(zone);
    return null;
  }

  async upsertZone(versionId: string, zone: ZoneDefinition): Promise<DraftResult<ZoneDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertZoneCore(snapshot, zone);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.zones };
  }

  private deleteZoneCore(snapshot: ContentSnapshot, id: string): string | null {
    const idx = snapshot.zones.findIndex(z => z.id === id);
    if (idx < 0) return 'Zone not found.';
    const referencingTile = snapshot.world.tiles.find(t => t.zone === id);
    if (referencingTile) return `Cannot delete: zone is used by tile "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).`;
    snapshot.zones.splice(idx, 1);
    return null;
  }

  async deleteZone(versionId: string, id: string): Promise<DraftResult<ZoneDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteZoneCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.zones };
  }

  // --- Encounter CRUD ---

  private upsertEncounterCore(snapshot: ContentSnapshot, encounter: EncounterDefinition): string | null {
    if (!snapshot.encounters) snapshot.encounters = [];
    const idx = snapshot.encounters.findIndex(e => e.id === encounter.id);
    if (idx >= 0) snapshot.encounters[idx] = encounter; else snapshot.encounters.push(encounter);
    return null;
  }

  async upsertEncounter(versionId: string, encounter: EncounterDefinition): Promise<DraftResult<EncounterDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertEncounterCore(snapshot, encounter);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.encounters ?? [] };
  }

  private deleteEncounterCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.encounters) snapshot.encounters = [];
    for (const zone of snapshot.zones) {
      if (zone.encounterTable.some(e => e.encounterId === id)) {
        return `Cannot delete: encounter is referenced by zone "${zone.displayName}".`;
      }
    }
    for (const tile of snapshot.world.tiles) {
      if (tile.encounterTable?.some(e => e.encounterId === id)) {
        return `Cannot delete: encounter is referenced by tile "${tile.name}" at (${tile.col}, ${tile.row}).`;
      }
    }
    snapshot.encounters = snapshot.encounters.filter(e => e.id !== id);
    return null;
  }

  async deleteEncounter(versionId: string, id: string): Promise<DraftResult<EncounterDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteEncounterCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.encounters ?? [] };
  }

  // --- Tile Type CRUD ---

  private upsertTileTypeCore(snapshot: ContentSnapshot, tileType: TileTypeDefinition): string | null {
    if (!snapshot.tileTypes || snapshot.tileTypes.length === 0) {
      // Old snapshot predates tile types — seed from live content.
      snapshot.tileTypes = Object.values(this.liveContent().getAllTileTypes());
    }
    const idx = snapshot.tileTypes.findIndex(t => t.id === tileType.id);
    if (idx >= 0) snapshot.tileTypes[idx] = tileType; else snapshot.tileTypes.push(tileType);
    return null;
  }

  async upsertTileType(versionId: string, tileType: TileTypeDefinition): Promise<DraftResult<TileTypeDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertTileTypeCore(snapshot, tileType);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.tileTypes ?? [] };
  }

  private deleteTileTypeCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.tileTypes || snapshot.tileTypes.length === 0) {
      snapshot.tileTypes = Object.values(this.liveContent().getAllTileTypes());
    }
    const referencingTile = snapshot.world.tiles.find(t => t.type === id);
    if (referencingTile) return `Cannot delete: tile type is used by room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).`;
    snapshot.tileTypes = snapshot.tileTypes.filter(t => t.id !== id);
    return null;
  }

  async deleteTileType(versionId: string, id: string): Promise<DraftResult<TileTypeDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteTileTypeCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.tileTypes ?? [] };
  }

  /** Restore seed tile types (adds any missing defaults; never removes custom ones). */
  async seedTileTypes(versionId: string): Promise<DraftResult<TileTypeDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    if (!snapshot.tileTypes) snapshot.tileTypes = [];
    const existingIds = new Set(snapshot.tileTypes.map(t => t.id));
    for (const seed of SEED_TILE_TYPES) {
      if (!existingIds.has(seed.id)) snapshot.tileTypes.push(seed);
    }
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.tileTypes };
  }

  // --- Skill CRUD ---

  private upsertSkillCore(snapshot: ContentSnapshot, raw: SkillDefinition): string | null {
    const skill = migrateLegacySkill(raw);
    const errors = validateSkillDefinition(skill);
    if (errors.length > 0) return errors.join(' ');
    if (snapshot.skills === undefined) {
      snapshot.skills = Object.values(this.liveContent().getAllSkills());
    }
    const idx = snapshot.skills.findIndex(s => s.id === skill.id);
    if (idx >= 0) snapshot.skills[idx] = skill; else snapshot.skills.push(skill);
    return null;
  }

  async upsertSkill(versionId: string, raw: SkillDefinition): Promise<DraftResult<SkillDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.upsertSkillCore(snapshot, raw);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.skills ?? [] };
  }

  private deleteSkillCore(snapshot: ContentSnapshot, id: string): string | null {
    if (snapshot.skills === undefined) {
      snapshot.skills = Object.values(this.liveContent().getAllSkills());
    }
    const idx = snapshot.skills.findIndex(s => s.id === id);
    if (idx < 0) return 'Skill not found.';
    const referencingItem = snapshot.items.find(i => i.grantedSkillIds?.includes(id));
    if (referencingItem) return `Cannot delete: skill is granted by item "${referencingItem.name}".`;
    const referencingSet = (snapshot.sets ?? []).find(s => migrateLegacySet(s).breakpoints?.some(bp => bp.bonuses.grantedSkillIds?.includes(id)));
    if (referencingSet) return `Cannot delete: skill is granted by set "${referencingSet.name}".`;
    snapshot.skills.splice(idx, 1);
    return null;
  }

  async deleteSkill(versionId: string, id: string): Promise<DraftResult<SkillDefinition>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteSkillCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.skills ?? [] };
  }

  async setSkillSlotSchedule(versionId: string, className: string, slots: SkillSlot[]): Promise<DraftSkillSlotsResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    if (snapshot.skillSlotSchedules === undefined) {
      snapshot.skillSlotSchedules = Object.entries(this.liveContent().getAllSkillSlotSchedules()).map(([cn, sl]) => ({ className: cn, slots: sl }));
    }
    const idx = snapshot.skillSlotSchedules.findIndex(e => e.className === className);
    if (idx >= 0) snapshot.skillSlotSchedules[idx] = { className, slots };
    else snapshot.skillSlotSchedules.push({ className, slots });
    await this.persist(versionId, snapshot);
    return { success: true, skillSlotSchedules: snapshot.skillSlotSchedules };
  }

  /** Restore seed skills + slot schedules (overwrites seed ids, keeps custom skills). */
  async seedSkills(versionId: string): Promise<{ success: true; skills: SkillDefinition[]; skillSlotSchedules: { className: string; slots: SkillSlot[] }[] } | { success: false; status: 404 | 400; error: string }> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    if (snapshot.skills === undefined) {
      snapshot.skills = Object.values(this.liveContent().getAllSkills());
    }
    for (const seed of Object.values(SEED_SKILLS)) {
      const idx = snapshot.skills.findIndex(s => s.id === seed.id);
      if (idx >= 0) snapshot.skills[idx] = seed; else snapshot.skills.push(seed);
    }
    snapshot.skillSlotSchedules = Object.entries(SEED_SKILL_SLOT_SCHEDULES).map(([className, slots]) => ({ className, slots }));
    await this.persist(versionId, snapshot);
    return { success: true, skills: snapshot.skills, skillSlotSchedules: snapshot.skillSlotSchedules };
  }

  // --- Design Note CRUD ---

  private upsertDesignNoteCore(snapshot: ContentSnapshot, note: DesignNote): string | null {
    if (!snapshot.designNotes) snapshot.designNotes = [];
    const idx = snapshot.designNotes.findIndex(n => n.id === note.id);
    if (idx >= 0) snapshot.designNotes[idx] = note; else snapshot.designNotes.push(note);
    return null;
  }

  async upsertDesignNote(versionId: string, note: DesignNote): Promise<DraftResult<DesignNote>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertDesignNoteCore(snapshot, note);
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.designNotes ?? [] };
  }

  private deleteDesignNoteCore(snapshot: ContentSnapshot, id: string): string | null {
    if (!snapshot.designNotes) snapshot.designNotes = [];
    const idx = snapshot.designNotes.findIndex(n => n.id === id);
    if (idx < 0) return 'Design note not found.';
    snapshot.designNotes.splice(idx, 1);
    return null;
  }

  async deleteDesignNote(versionId: string, id: string): Promise<DraftResult<DesignNote>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteDesignNoteCore(snapshot, id);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: snapshot.designNotes ?? [] };
  }

  // --- World: tiles ---

  private upsertTileCore(snapshot: ContentSnapshot, input: Omit<WorldTileDefinition, 'id'> & { id?: string }): void {
    const idx = snapshot.world.tiles.findIndex(t => t.mapId === input.mapId && t.col === input.col && t.row === input.row);
    if (idx >= 0) {
      // Preserve the existing GUID on update.
      snapshot.world.tiles[idx] = { ...input, id: snapshot.world.tiles[idx].id };
    } else {
      snapshot.world.tiles.push({ ...input, id: crypto.randomUUID() });
    }
  }

  async upsertTile(versionId: string, input: Omit<WorldTileDefinition, 'id'> & { id?: string }): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    this.upsertTileCore(snapshot, input);
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  /** Create-or-update several tiles in one load+save. Used by the MCP `upsert_tiles` tool. */
  async upsertTilesBulk(versionId: string, inputs: (Omit<WorldTileDefinition, 'id'> & { id?: string })[]): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    for (const input of inputs) this.upsertTileCore(snapshot, input);
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  private deleteTileCore(snapshot: ContentSnapshot, mapId: string, col: number, row: number): string | null {
    const { startTile } = snapshot.world;
    if (mapId === snapshot.world.defaultMapId && startTile.col === col && startTile.row === row) {
      return 'Cannot delete the start tile.';
    }
    const idx = snapshot.world.tiles.findIndex(t => t.mapId === mapId && t.col === col && t.row === row);
    if (idx < 0) return 'Tile not found.';
    const inbound = snapshot.world.tiles.find(t => t.transitions?.some(tr => tr.tileId === snapshot.world.tiles[idx].id));
    if (inbound) return `A transition in "${inbound.name}" links to this room. Remove it first.`;
    snapshot.world.tiles.splice(idx, 1);
    return null;
  }

  async deleteTile(versionId: string, mapId: string, col: number, row: number): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.deleteTileCore(snapshot, mapId, col, row);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  /**
   * Delete several tiles in one load+save. Used by the MCP `delete_tiles` tool.
   * All-or-nothing: aborts without persisting on the first tile that can't be deleted.
   */
  async deleteTilesBulk(versionId: string, refs: { mapId: string; col: number; row: number }[]): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    for (const ref of refs) {
      const err = this.deleteTileCore(snapshot, ref.mapId, ref.col, ref.row);
      if (err) return { success: false, status: 400, error: err };
    }
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  /** `mapId` defaults to the draft's own default map when omitted (mirrors the live route). */
  async setStartTile(versionId: string, mapId: string | undefined, col: number, row: number): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    mapId = mapId || snapshot.world.defaultMapId;
    const tile = snapshot.world.tiles.find(t => t.mapId === mapId && t.col === col && t.row === row);
    if (!tile) return { success: false, status: 400, error: 'Tile not found.' };
    const meta = snapshot.world.maps.find(m => m.id === mapId);
    if (meta) meta.startTile = { col, row };
    if (mapId === snapshot.world.defaultMapId) snapshot.world.startTile = { col, row };
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  // --- World: maps ---

  async upsertMap(versionId: string, meta: WorldMapMeta): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const idx = snapshot.world.maps.findIndex(m => m.id === meta.id);
    if (idx >= 0) snapshot.world.maps[idx] = { ...snapshot.world.maps[idx], name: meta.name };
    else snapshot.world.maps.push(meta);
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  async deleteMap(versionId: string, mapId: string): Promise<DraftWorldResult> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    if (mapId === snapshot.world.defaultMapId) return { success: false, status: 400, error: 'Cannot delete the default map.' };
    if (snapshot.world.tiles.some(t => t.mapId === mapId)) return { success: false, status: 400, error: "Delete or move this map's rooms first." };
    const inbound = snapshot.world.tiles.find(t => t.transitions?.some(tr => tr.mapId === mapId));
    if (inbound) return { success: false, status: 400, error: `A transition in "${inbound.name}" still leads to this map. Remove it first.` };
    snapshot.world.maps = snapshot.world.maps.filter(m => m.id !== mapId);
    await this.persist(versionId, snapshot);
    return { success: true, world: snapshot.world };
  }

  // --- Generic dispatch (MCP write tools) ---

  /** Reads a type's array off an already-loaded snapshot (defaulting absent optional arrays to []). */
  getContentArray(type: DraftContentType, snapshot: ContentSnapshot): unknown[] {
    switch (type) {
      case 'monsters': return snapshot.monsters;
      case 'items': return snapshot.items;
      case 'zones': return snapshot.zones;
      case 'sets': return snapshot.sets ?? [];
      case 'shops': return snapshot.shops ?? [];
      case 'recipes': return snapshot.recipes ?? [];
      case 'npcs': return snapshot.npcs ?? [];
      case 'quests': return snapshot.quests ?? [];
      case 'dungeons': return snapshot.dungeons ?? [];
      case 'encounters': return snapshot.encounters ?? [];
      case 'tileTypes': return snapshot.tileTypes ?? [];
      case 'skills': return snapshot.skills ?? [];
      case 'designNotes': return snapshot.designNotes ?? [];
    }
  }

  /** Validates + mutates an already-loaded snapshot in place. Returns an error message, or null on success. */
  private upsertCoreByType(type: DraftContentType, snapshot: ContentSnapshot, entry: unknown): string | null {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id) {
      return 'Entry must be an object with a non-empty string "id".';
    }
    switch (type) {
      case 'monsters': return this.upsertMonsterCore(snapshot, entry as MonsterDefinition);
      case 'items': return this.upsertItemCore(snapshot, entry as ItemDefinition);
      case 'sets': return this.upsertSetCore(snapshot, entry as SetDefinition);
      case 'shops': return this.upsertShopCore(snapshot, entry as ShopDefinition);
      case 'recipes': return this.upsertRecipeCore(snapshot, entry as RecipeDefinition);
      case 'npcs': return this.upsertNpcCore(snapshot, entry as NpcDefinition);
      case 'quests': return this.upsertQuestCore(snapshot, entry as QuestDefinition);
      case 'dungeons': return this.upsertDungeonCore(snapshot, entry as DungeonDefinition);
      case 'zones': return this.upsertZoneCore(snapshot, entry as ZoneDefinition);
      case 'encounters': return this.upsertEncounterCore(snapshot, entry as EncounterDefinition);
      case 'tileTypes': return this.upsertTileTypeCore(snapshot, entry as TileTypeDefinition);
      case 'skills': return this.upsertSkillCore(snapshot, entry as SkillDefinition);
      case 'designNotes': return this.upsertDesignNoteCore(snapshot, entry as DesignNote);
    }
  }

  /** Create-or-update one entry of `type` in a draft. Used by the MCP `upsert_content` tool. */
  async upsertContent(type: DraftContentType, versionId: string, entry: unknown): Promise<DraftResult<unknown>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    const err = this.upsertCoreByType(type, snapshot, entry);
    if (err) return { success: false, status: 400, error: err };
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: this.getContentArray(type, snapshot) };
  }

  /**
   * Create-or-update several entries of `type` in ONE load + ONE save. Used by
   * `upsert_content_bulk` and the `/bulk` admin routes. All-or-nothing: if any entry
   * fails validation, nothing is persisted — fix the bad entry and resubmit the whole
   * batch (upserts are idempotent by id, so re-submitting already-applied entries is safe).
   */
  async upsertContentBulk(type: DraftContentType, versionId: string, entries: unknown[]): Promise<DraftResult<unknown>> {
    const draft = await this.loadDraft(versionId);
    if ('error' in draft) return { success: false, status: draft.status, error: draft.error };
    const { snapshot } = draft;
    for (const entry of entries) {
      const err = this.upsertCoreByType(type, snapshot, entry);
      if (err) return { success: false, status: 400, error: err };
    }
    await this.persist(versionId, snapshot);
    return { success: true, snapshot, entries: this.getContentArray(type, snapshot) };
  }

  /** Delete one entry of `type` from a draft by id. Used by the MCP `delete_content` tool. */
  async deleteContent(type: DraftContentType, versionId: string, id: string): Promise<DraftResult<unknown>> {
    switch (type) {
      case 'monsters': return this.deleteMonster(versionId, id);
      case 'items': return this.deleteItem(versionId, id);
      case 'sets': return this.deleteSet(versionId, id);
      case 'shops': return this.deleteShop(versionId, id);
      case 'recipes': return this.deleteRecipe(versionId, id);
      case 'npcs': return this.deleteNpc(versionId, id);
      case 'quests': return this.deleteQuest(versionId, id);
      case 'dungeons': return this.deleteDungeon(versionId, id);
      case 'zones': return this.deleteZone(versionId, id);
      case 'encounters': return this.deleteEncounter(versionId, id);
      case 'tileTypes': return this.deleteTileType(versionId, id);
      case 'skills': return this.deleteSkill(versionId, id);
      case 'designNotes': return this.deleteDesignNote(versionId, id);
    }
  }
}

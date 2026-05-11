# Content (data-driven game definitions)

This document covers everything stored in `data/*.json` and managed via `ContentStore` and the admin dashboard: monsters, items, sets, shops, zones, encounters, dungeons, world map, tile types, and the version snapshot pipeline.

## Data-driven content (ContentStore)

Game content (monsters, items, zones, world map, etc.) is stored in `data/*.json` files, loaded at startup by `ContentStore` (`server/src/game/ContentStore.ts`). If files are missing, ContentStore seeds them with defaults from `SEED_MONSTERS`, `SEED_ITEMS`, `SEED_ZONES`, `SEED_DUNGEONS`, and a hand-crafted world map. ContentStore follows the `GuildStore` pattern (in-memory Maps + atomic JSON persistence). Content is NOT exposed via a public API — instead, the server sends only what each player needs.

## Parameterized shared functions

Pure functions in shared that previously referenced module-level constants (`ITEMS`, `MONSTERS`, `ZONES`) now accept explicit data parameters. This allows the server to pass runtime-loaded content from ContentStore. E.g., `createEncounter(zoneId, monsters, zones)`, `equipItem(inv, equip, id, items)`, `computeEquipmentBonuses(equip, items)`, `getZone(zoneId, zones)`. The old constants are renamed to `SEED_*` and serve as seed data / test fixtures.

## Zone system

Each `HexTile` has a `zone` string property. `ZoneTypes.ts` defines `ZoneDefinition` with encounter tables (weighted monster selection). Current zones: `hatchetmill` (Lv1 goblins, starting village), `darkwood` (goblins, wolves, bandits), and `crystal_caves` (goblins, wolves). `createEncounter(zoneId, monsters, zones)` uses the zone's encounter table for weighted random monster/count selection. Zone display name is sent to the client in `ServerStateMessage.zoneName`.

## Monster system

`MonsterTypes.ts` defines `MonsterDefinition` type and `SEED_MONSTERS` catalog (goblin, wolf, bandit, stone_wall) with `drops?: ItemDrop[]` and `damageType: DamageType` per monster, and `createEncounter(zoneId, monsters, zones)` factory with zone-aware weighted encounters. Each `MonsterInstance` has a `gridPosition: PartyGridPosition` for combat grid placement and inherits `damageType` from its definition.

## Wall (passive) monsters

A `MonsterDefinition` with `passive: true` is a "wall" — a tactical obstacle. Walls (a) **never attack** (their turn is skipped in `processPartyTick`) and (b) **don't count toward victory** (the victory check ignores passive monsters, so killing all non-passive monsters wins). Walls are NOT auto-skipped by player targeting — players use normal grid targeting (front column first, same row first), so a wall at col 0 will be hit before a back-row monster. Players must work around walls via grid positioning, AoE skills (Mage Blizzard, Bard Dissonance, Archer Triple Shot), or Cut-Down/lowest-HP targeting. Seed example: `stone_wall` (100 HP, 0 damage, no XP/gold). Editable via the admin monster form's "Passive (wall)" checkbox.

## Item & equipment system

`ItemTypes.ts` defines items, rarities (`janky` 40%, `common` 25%, `uncommon`, `rare`, `epic`, `legendary`, `heirloom`), and equipment slots:

```ts
EquipSlot =
  | 'head' | 'shoulders' | 'chest' | 'bracers' | 'gloves'
  | 'mainhand' | 'offhand' | 'twohanded'
  | 'foot' | 'ring' | 'necklace' | 'back' | 'relic';
```

Two-handed weapons use the `twohanded` slot and block both `mainhand` and `offhand`. Items have optional `classRestriction: string[]` (array of class names that can equip) and `value?: number` (gold value for shops). Items stack up to `MAX_STACK = 99` in inventory.

Equipment modifies combat: `bonusAttackMin/Max` adds to player damage, `damageReductionMin/Max` reduces incoming physical damage, `magicReductionMin/Max` reduces incoming magical damage. Pure functions handle inventory/equipment operations (`addItemToInventory`, `equipItem`, `unequipItem`, `computeEquipmentBonuses`, `rollDrops`) — all accept explicit `items: Record<string, ItemDefinition>` parameter. Drops are rolled per-monster on victory.

The `ItemsScreen` uses a square grid layout with artwork support, rarity-colored backgrounds, and animated borders for equipped items. Clicking an item opens a popup modal with full details and equip/unequip/drop actions. Item definitions come from `ServerStateMessage.itemDefinitions` (only items the player owns). Seed items live in `SEED_ITEMS` (`shared/src/systems/ItemTypes.ts`) — see that file for the current catalog (helmets, mainhand weapons, leather/cloth armor, jewelry, the `waterskin` relic and `magma_boots` for item-gated tiles, etc.).

## InventoryView

Read-only helpers in `shared/src/systems/InventoryView.ts` for querying a character's items: `getEquippedCount`, `getUnequippedCount`, `getOwnedCount`, `hasItemEquipped`, `hasUnequipped`, `ownsItem`, `getEquippedItemIds`, `getOwnedItemIds`, `listUnequippedEntries`. Use these instead of iterating `inventory` / `equipment` directly. Key invariant: `equipItem` removes the equipped copy from `inventory` and stores it in `equipment`, so `inventory` ONLY counts unequipped copies. Subtracting an equipped count from `inventory[id]` (or filtering inventory by "is this ID equipped?") double-counts and was the source of multiple shipped bugs. Helpers that take only `equipment` work for any character — including a remote player's profile equipment in the `view_player` response.

## Set system

`SetTypes.ts` defines `SetDefinition` with `itemIds: string[]`, an optional `classRestriction?: string[]`, and a list of tiered `breakpoints: SetBreakpoint[]`. Each breakpoint declares a `piecesRequired` count and a `SetBonuses` payload — a Diablo-style tier model: bonuses do NOT stack across tiers within a single set; the highest unlocked tier replaces lower ones (use `getActiveBreakpoint`). Bonuses across DIFFERENT active sets stack additively.

`SetBonuses` includes: `cooldownReduction`, `damagePercent`, `damageResistancePercent`, `damageReductionMin/Max`, `magicReductionMin/Max`, `bonusAttackMin/Max`, `flatHp`, `percentHp`.

**Class-restricted sets** (`classRestriction`) only activate for players of the listed classes — when displayed, their name is suffixed with the class list (e.g., "Glowing Crystal Set (Knight)"). Items can belong to MULTIPLE sets across different classes (e.g., Glowing Crystal Bracers in both a Bard set and a Knight set), but `findSetConflicts` enforces that no item is in two sets that share a class. The server filters sets by the viewer/target's class via `setAppliesToClass` so only relevant sets reach the client. Legacy `{ bonuses }` sets are migrated on load via `migrateLegacySet` to a single max-pieces breakpoint. Set definitions stored in `data/sets.json`, managed by `ContentStore` (which validates conflicts on `addOrUpdateSet`).

**Combat integration**: `PlayerSession.getCombatInfo()` calls `computeActiveSetBonuses(equipment, sets, className)` to filter by class, merges flat DR/MR/attack into `equipBonuses` via `mergeSetBonusesIntoEquip`, and bakes `flatHp`/`percentHp` into `maxHp`. The remaining multiplicative components (`damagePercent`, `damageResistancePercent`, `cooldownReduction`) ride on `PartyCombatant.setBonuses` and are consumed by the engine: `damagePercent` multiplies player damage in `computePlayerDamage` (after rally/warSong); `cooldownReduction` is self-only and added in `getEffectiveCooldown`; `damageResistancePercent` applies BEFORE flat reductions in `applyMonsterDirectDamage` and the player-DoT path in `processTickEffects`.

## Dungeon system (data scaffolding only)

`DungeonTypes.ts` defines `DungeonDefinition` with `id`, `name`, optional `description`, `floors: DungeonFloor[]`, optional `entryRequirements: DungeonEntryRequirements`, and optional `firstClearRewards: DungeonReward[]`. Each `DungeonFloor` has `floorNumber` (1-indexed), `gridShape: { cols, rows }`, `encounterTable: EncounterTableEntry[]` (reuses zone-style weighted picks), optional `isBoss`, and optional `rewards`. `DungeonEntryRequirements` covers `minLevel`/`maxLevel`, `requiredItemId` + `consumeRequiredItem`, `requiredClasses: ClassName[]`, and `minPartySize`/`maxPartySize`. Stored in `data/dungeons.json` via `ContentStore` and snapshotted in `ContentSnapshot.dungeons`. Admin CRUD lives in the Dungeons tab. **No runtime game behavior is wired yet** — instance manager, entry validation, reward granting, and grid-shape combat support land in later issues.

## Shop system

`ShopTypes.ts` defines `ShopDefinition` with `id`, `name`, and `inventory: ShopItem[]` (item ID + stock + price). Shops are linked to tiles via `shopId?: string` on `WorldTileDefinition`. Shop definitions stored in `data/shops.json`, managed by `ContentStore`. The client shows a shop button in the room info popup when the current tile has a shop. `ShopPopup` (`client/src/ui/ShopPopup.ts`) provides buy/sell UI — buy mode shows shop inventory with prices, sell mode shows unequipped inventory items only with quantity controls (-/+/All) and sell prices.

## World map & room names

The world map is defined in `data/world.json` as an array of `WorldTileDefinition` objects, each with `id` (GUID), `col`, `row`, `type` (TileType), `zone` (zone ID), and `name` (room name, required). Each tile has a stable GUID (`id`) that persists across admin saves but changes when a tile is deleted and re-created. Every tile has an evocative room name (e.g., "Town Square", "Blacksmith", "Thick Trees"). The server loads this via `ContentStore` and builds the `HexGrid` at startup. The client receives ALL tiles via `GET /api/world` (auth'd) on login; fog of war rendering is determined client-side from `state.unlocked`.

## Fog of war (unlock-based)

Fog of war is driven entirely by the existing `unlockedKeys` from `UnlockSystem` — no separate discovery tracking. Unlock keys are tile GUIDs (not cube coordinates), so renaming/moving tiles in the admin panel invalidates old unlock state. The server sends all tiles to the client; the client determines visibility from `state.unlocked` (sent every tick).

Three-tier rendering:
- **Unlocked tiles**: full brightness, real icons, room name visible on click.
- **Zone-unlocked tiles** (zone has at least one unlocked tile): dimmed, real tile type icons shown, room name hidden.
- **Foggy tiles** (zone not yet unlocked): very dim, cloud icons.

**Non-traversable tiles** (mountains, water, hedges, volcanoes) always render in a fixed dimmed style with their terrain icon — they are unaffected by fog of war or unlock state. Zone names are always visible on all tiles. Players can click and attempt to travel to any visible tile regardless of fog state. Zone unlock is computed client-side by `WorldCache.updateUnlocked()` from the unlock keys.

## Item-gated tiles

Some traversable tile types require a specific equipped item for entry. `TileConfig.requiredItemId` specifies the item ID (e.g., Desert requires `waterskin` relic, Lava Field requires `magma_boots` foot slot). When a party tries to move and the path crosses a gated tile, ALL party members must have the required item equipped — otherwise the move is rejected with a `move_blocked` WS message listing the item name and missing players. Once movement starts, required items are **locked**: they cannot be unequipped while the party is on the gated tile or has gated tiles in their remaining path. The lock covers both current tile and all tiles in the movement queue. Trades and destroy cannot affect equipped items, so the unequip lock is sufficient.

## Tile types

Data-driven content type stored in `data/tile-types.json`, managed by ContentStore, editable via admin dashboard. `TileTypeDefinition` has `id`, `name`, `icon`, `color` (hex string), `traversable`, and optional `requiredItemId` (default item required for all tiles of this type). Seed types: Plains, Forest, Mountain (non-trav), Water (non-trav), Town, Dungeon, Void (non-trav), Desert, Lava Field, Beach, Hedge (non-trav), Volcano (non-trav). Per-tile `requiredItemId` on `WorldTileDefinition` overrides the type-level default. Admin can create, edit, and delete tile types (delete blocked if tiles reference the type). Client receives tile type definitions via `GET /api/world` response and uses them for data-driven map rendering (icons, colors, traversability).

## WorldCache (client)

`WorldCache` (`client/src/network/WorldCache.ts`) is the client-side cache for world data. Loaded once from `GET /api/world` on login (in parallel with WS connect). Stores all tiles, start position, and computes unlock state from `state.unlocked` tile GUIDs each tick. `updateUnlocked(tileIds)` maps GUIDs→offset coordinates via a reverse index, tracks which tiles and zones are unlocked, and returns whether the set changed (triggering re-render). The `WorldMapScene` builds its `HexGrid` from WorldCache data.

## Content versioning

Admin content edits go through a draft→publish→deploy pipeline. `VersionStore` manages version metadata (`data/versions/manifest.json`) and snapshots (`data/versions/{id}.json`). Each snapshot freezes all game content (monsters, items, zones, world, sets, shops, dungeons, tile types). On deploy, `GameLoop.deployVersion()` replaces live content, rebuilds the hex grid, and relocates parties on unreachable tiles.

**When adding new content types to the game, they must be included in `ContentSnapshot` (`VersionStore.ts`) and `ContentStore.toSnapshot()`/`replaceAll()`.**

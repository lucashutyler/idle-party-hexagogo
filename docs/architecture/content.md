# Content (data-driven game definitions)

This document covers everything stored in `data/*.json` and managed via `ContentStore` and the admin dashboard: monsters, items, sets, shops, zones, encounters, dungeons, world map, tile types, and the version snapshot pipeline.

## Data-driven content (ContentStore)

Game content (monsters, items, zones, world map, etc.) is stored in `data/*.json` files, loaded at startup by `ContentStore` (`server/src/game/ContentStore.ts`). If files are missing, ContentStore seeds them with defaults from `SEED_MONSTERS`, `SEED_ITEMS`, `SEED_ZONES`, `SEED_DUNGEONS`, and a hand-crafted world map. ContentStore follows the `GuildStore` pattern (in-memory Maps + atomic JSON persistence). Content is NOT exposed via a public API — instead, the server sends only what each player needs.

## Parameterized shared functions

Pure functions in shared that previously referenced module-level constants (`ITEMS`, `MONSTERS`, `ZONES`) now accept explicit data parameters. This allows the server to pass runtime-loaded content from ContentStore. E.g., `createEncounter(zoneId, monsters, zones)`, `equipItem(inv, equip, id, items)`, `computeEquipmentBonuses(equip, items)`, `getZone(zoneId, zones)`, and all skill helpers which take a `SkillContent` bundle (`getSkillById`, `getUnlockedSkillsForLevel`, `canEquipSkill`, `createDefaultSkillLoadout`, `reconcileSkillLoadout`). The old constants are renamed to `SEED_*` and serve as seed data / test fixtures.

## Zone system

Each `HexTile` has a `zone` string property. `ZoneTypes.ts` defines `ZoneDefinition` with encounter tables (weighted monster selection). Current zones: `hatchetmill` (Lv1 goblins, starting village), `darkwood` (goblins, wolves, bandits), and `crystal_caves` (goblins, wolves). `createEncounter(zoneId, monsters, zones)` uses the zone's encounter table for weighted random monster/count selection. Zone display name is sent to the client in `ServerStateMessage.zoneName`.

## Monster system

`MonsterTypes.ts` defines `MonsterDefinition` type and `SEED_MONSTERS` catalog (goblin, wolf, bandit, stone_wall) with `drops?: ItemDrop[]`, `damageType: DamageType`, and an optional `description?: string` (flavor text shown in the in-combat monster popup). `createEncounter(zoneId, monsters, zones)` is the factory with zone-aware weighted encounters. Each `MonsterInstance` has a `gridPosition: PartyGridPosition` for combat grid placement and inherits `damageType` + `description` from its definition. The description rides through the `ClientCombatState` so the popup can render it without an extra fetch.

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

Two-handed weapons use the `twohanded` slot and block both `mainhand` and `offhand`. Items have optional `classRestriction: string[]` (array of class names that can equip) and `value?: number` (gold value for shops). Items may also carry `grantedSkillIds?: string[]` — skills the wearer can equip while the item is equipped (see Skill system below). Items stack up to `MAX_STACK = 99` in inventory.

Equipment modifies combat: `bonusAttackMin/Max` adds to player damage, `damageReductionMin/Max` reduces incoming physical damage, `magicReductionMin/Max` reduces incoming magical damage. Pure functions handle inventory/equipment operations (`addItemToInventory`, `equipItem`, `unequipItem`, `computeEquipmentBonuses`, `rollDrops`) — all accept explicit `items: Record<string, ItemDefinition>` parameter. Drops are rolled per-monster on victory.

The `ItemsScreen` uses a square grid layout with artwork support, rarity-colored backgrounds, and animated borders for equipped items. Clicking an item opens a popup modal with full details and equip/unequip/drop actions. Item definitions come from `ServerStateMessage.itemDefinitions` (only items the player owns). Seed items live in `SEED_ITEMS` (`shared/src/systems/ItemTypes.ts`) — see that file for the current catalog (helmets, mainhand weapons, leather/cloth armor, jewelry, the `waterskin` relic and `magma_boots` for item-gated tiles, etc.).

## InventoryView

Read-only helpers in `shared/src/systems/InventoryView.ts` for querying a character's items: `getEquippedCount`, `getUnequippedCount`, `getOwnedCount`, `hasItemEquipped`, `hasUnequipped`, `ownsItem`, `getEquippedItemIds`, `getOwnedItemIds`, `listUnequippedEntries`. Use these instead of iterating `inventory` / `equipment` directly. Key invariant: `equipItem` removes the equipped copy from `inventory` and stores it in `equipment`, so `inventory` ONLY counts unequipped copies. Subtracting an equipped count from `inventory[id]` (or filtering inventory by "is this ID equipped?") double-counts and was the source of multiple shipped bugs. Helpers that take only `equipment` work for any character — including a remote player's profile equipment in the `view_player` response.

## Set system

`SetTypes.ts` defines `SetDefinition` with `itemIds: string[]`, an optional `classRestriction?: string[]`, and a list of tiered `breakpoints: SetBreakpoint[]`. Each breakpoint declares a `piecesRequired` count and a `SetBonuses` payload — a Diablo-style tier model: bonuses do NOT stack across tiers within a single set; the highest unlocked tier replaces lower ones (use `getActiveBreakpoint`). Bonuses across DIFFERENT active sets stack additively.

`SetBonuses` includes: `cooldownReduction`, `damagePercent`, `damageResistancePercent`, `damageReductionMin/Max`, `magicReductionMin/Max`, `bonusAttackMin/Max`, `flatHp`, `percentHp`, plus optional `grantedSkillIds` (skills equippable while that breakpoint tier is active — see Skill system below).

**Class-restricted sets** (`classRestriction`) only activate for players of the listed classes — when displayed, their name is suffixed with the class list (e.g., "Glowing Crystal Set (Knight)"). Items can belong to MULTIPLE sets across different classes (e.g., Glowing Crystal Bracers in both a Bard set and a Knight set), but `findSetConflicts` enforces that no item is in two sets that share a class. The server filters sets by the viewer/target's class via `setAppliesToClass` so only relevant sets reach the client. Legacy `{ bonuses }` sets are migrated on load via `migrateLegacySet` to a single max-pieces breakpoint. Set definitions stored in `data/sets.json`, managed by `ContentStore` (which validates conflicts on `addOrUpdateSet`).

**Combat integration**: `PlayerSession.getCombatInfo()` calls `computeActiveSetBonuses(equipment, sets, className)` to filter by class, merges flat DR/MR/attack into `equipBonuses` via `mergeSetBonusesIntoEquip`, and bakes `flatHp`/`percentHp` into `maxHp`. The remaining multiplicative components (`damagePercent`, `damageResistancePercent`, `cooldownReduction`) ride on `PartyCombatant.setBonuses` and are consumed by the engine: `damagePercent` multiplies player damage in `computePlayerDamage` (after rally/warSong); `cooldownReduction` is self-only and added in `getEffectiveCooldown`; `damageResistancePercent` applies BEFORE flat reductions in `applyMonsterDirectDamage` and the player-DoT path in `processTickEffects`.

## Skill system (content)

Player skills are versioned content (issue #267). `SkillDefinition` (`shared/src/systems/SkillTypes.ts`) has `className`, `type` (passive/active), an editable `unlockLevel` (`null` = grant-only, never level-learned), `sortOrder`, `cooldown` (actives), and one or more effect **options** — `passiveEffects[]` / `activeEffects[]`; passive options are honored on active skills too. The closed set of engine-supported option kinds lives in `SKILL_OPTION_CATALOG` (`shared/src/systems/SkillOptionCatalog.ts`): 27 passive + 23 active kinds, each with a param schema (percent params stored as 0–1 fractions), a targeting note, and a description with stacking caveats. The catalog drives the admin editor's searchable option picker and `validateSkillDefinition`, which gates every admin PUT (server-side; the admin client also pre-validates). Per-class **slot schedules** (`Record<ClassName, SkillSlot[]>`) are content too.

Storage: `data/skills.json` + `data/skill-slots.json`, seeded from `SEED_SKILLS` / `SEED_SKILL_SLOT_SCHEDULES` on both fresh and existing installs (skill ids preserved from the original hardcoded trees so player saves stay valid — `equippedSkills` persists raw ids). Both are snapshotted in `ContentSnapshot`; `replaceAll` keeps existing skills when deploying a pre-skills snapshot (keep-when-absent, like tile types), and legacy single-effect shapes are normalized via `migrateLegacySkill` on every load path. `POST /api/admin/skills/seed` restores the defaults (destructive for seed-id skills, keeps custom ones).

Runtime: shared skill helpers take a `SkillContent` bundle; `reconcileSkillLoadout` clears equipped slots whose skill vanished, changed type, or lost availability, and runs on restore, level-up, class change, equipment changes, and deploy (all sessions). `unlockedSkills` is derived state — recomputed from level + content every time; only `equippedSkills` is authoritative in saves. The game client fetches the full catalog + schedules via authed `GET /api/skills` into `WorldCache` (SEED fallback on failure; refetched on `world_update`).

**Grants**: `ItemDefinition.grantedSkillIds` and per-breakpoint `SetBonuses.grantedSkillIds` make skills equippable (cross-class allowed) only while the grant is active. Grants are computed live via `computeGrantedSkillIds` and shipped to the client as `ClientCharacterState.grantedSkillIds`; they are never persisted. Players never see a granted skill before the grant is active. Monster skills remain a separate hardcoded catalog (`MONSTER_SKILL_CATALOG`).

## Dungeon system

**Definitions.** `DungeonTypes.ts` defines `DungeonDefinition` with `id`, `name`, optional `description`, `floors: DungeonFloor[]`, optional `entryRequirements: DungeonEntryRequirements`, optional `firstClearRewards: DungeonReward[]`, and optional flat `firstClearXp`/`firstClearGold` bonuses. Each `DungeonFloor` has `floorNumber` (1-indexed), `gridShape: { cols, rows }`, `encounterTable: EncounterTableEntry[]` (reuses zone-style weighted picks), optional `isBoss`, and optional `rewards`. `DungeonEntryRequirements` covers `minLevel`/`maxLevel`, `requiredItemId` + `consumeRequiredItem`, `requiredClasses: ClassName[]`, and `minPartySize`/`maxPartySize`. It is the sibling of `RoomEntryRequirements` ([Room entry requirements](#room-entry-requirements)) — same "all members must satisfy it" rule, evaluated by its own pure validator. Stored in `data/dungeons.json` via `ContentStore` and snapshotted in `ContentSnapshot.dungeons`. Admin CRUD lives in the Dungeons tab. A room is linked to a dungeon via `dungeonId?` on its `WorldTileDefinition` (set in the Map tab room editor, mirrors the `shopId`/`npcId` pattern).

**Pure helpers** (shared, unit-tested in `DungeonTypes.test.ts`): `validateDungeonEntry(dungeon, members, requiredItemName?)` returns a human-readable rejection reason or `null` (checks floors-exist, party size, per-member level/class/required-item); `rollDungeonRewards(rewards, rng?)` rolls a `DungeonReward[]` table into concrete `{ itemId, quantity }[]` grants; `rewardAppliesToClass(reward, className)` gates a reward by its optional `classRestriction`. Each `DungeonReward` may carry a `classRestriction: ClassName[]` — only members of a listed class roll for it, so a dungeon can hand different loot to different classes (a blade for Knights, a lute for Bards). The server filters floor and first-clear rewards per member by class before rolling.

**Runtime (instance per party).** Dungeon combat reuses the normal party combat engine — a dungeon run is "a `ServerParty` whose encounters come from the current floor instead of the tile." State lives on the `PartyBattleManager` entry as `dungeonRun?: { dungeonId, currentFloorIndex, entrance }`:

- **Entry** (`enterDungeon`): the party owner/leader sends `enter_dungeon` while standing on the linked room. The whole current party enters together (solo party → solo run). Server validates requirements via `validateDungeonEntry`, consumes the entry item from each member if `consumeRequiredItem`, records the entrance room, and restarts combat on floor 1. Henchmen / mid-run joins are out of scope.
- **Floor combat**: `createCombatForParty` draws the encounter from `floors[currentFloorIndex].encounterTable` (3×3 grid for now — non-3×3 grids are a later issue). Monsters drop normal XP/gold/loot; tile-unlocking is skipped (dungeon floors aren't overworld tiles).
- **Progression**: on victory, `handleDungeonFloorCleared` grants the floor's bonus `rewards` (rolled per member), then advances `currentFloorIndex`. Clearing the final floor completes the run: each member who hasn't cleared this dungeon before gets the one-time first-clear bonuses — flat `firstClearGold` + `firstClearXp` (via `PlayerSession.grantGold`/`grantXp`, with level-up handling) plus the rolled `firstClearRewards` items — all tracked per player in `PlayerSession.clearedDungeons`; then the party is returned to the entrance room.
- **Defeat**: a wipe fails the run — `handleDungeonDefeat` ejects the party back to the entrance room (no progress kept).
- **Bail-out** (`leaveDungeon`): owner/leader sends `leave_dungeon` to return to the entrance at any time.
- **Movement is locked** while in a dungeon (`handleMove` rejects). The party stays at the entrance position on the overworld, so other players see them at the dungeon mouth. `getOtherPlayers` flags those members with `inDungeon` + `dungeonName` (from the party's run state) so the client can mark them as delving rather than idling.
- **Persistence**: an active run is saved per-player (`PlayerSaveData.dungeonRun`) and restored on restart (`restoreDungeonRun`), so runs continue offline and across restarts. First-clear history persists in `PlayerSaveData.clearedDungeons`.

**Protocol**: `enter_dungeon`/`leave_dungeon` client messages; `ServerStateMessage.dungeon?: DungeonRunInfo` (`{ dungeonId, name, floor, totalFloors, isBossFloor }`) drives the client HUD. The full dungeon catalog is fetched once via `GET /api/dungeons` and cached in `WorldCache.getDungeon(id)`. **Client UI**: `RoomView` shows an "Enter {name}" button on a linked entrance room; `DungeonEntryPopup` confirms entry (flavor, floor count, requirements); `CombatScreen` shows an in-dungeon banner (name + "Floor X / Y" + "Leave Dungeon") in place of the run bar.

## Shop system

`ShopTypes.ts` defines `ShopDefinition` with `id`, `name`, and `inventory: ShopItem[]` (item ID + stock + price). Shops are linked to tiles via `shopId?: string` on `WorldTileDefinition`. Shop definitions stored in `data/shops.json`, managed by `ContentStore`. The client shows a shop button in the room info popup when the current tile has a shop. `ShopPopup` (`client/src/ui/ShopPopup.ts`) provides buy/sell UI — buy mode shows shop inventory with prices, sell mode shows unequipped inventory items only with quantity controls (-/+/All) and sell prices.

## NPC system

`NpcTypes.ts` defines `NpcDefinition` with `id`, `name`, `emoji` (required), `greeting`, optional `artworkUrl`, and optional `questIds`. NPCs are linked to tiles via `npcId?: string` on `WorldTileDefinition` (mirrors the `shopId` pattern). NPC definitions stored in `data/npcs.json`, managed by `ContentStore`. **Dev-only seed**: `SEED_NPCS` is only seeded when `NODE_ENV !== 'production'` — production deploys boot with an empty NPC catalog. The full NPC catalog is fetched once on login via `GET /api/npcs` (in parallel with `/api/world`) and cached in `WorldCache.getNpc(id)`. The world map renders a 💬 badge over unlocked tiles with NPCs (never on fogged tiles, to avoid leaking presence). The room info modal (`RoomView`) shows the NPC's emoji + name and a "Talk to {name}" button — only when the player is standing on the NPC's tile. Clicking opens `NpcTalkPopup` (portrait, greeting, and quest sections — see Quest system). Admin: `NpcsTab` modal form (id, name, emoji, greeting, multi-select for `questIds`). NPCs are placed via the Map tab's room editor (NPC dropdown next to Shop). Both `ContentStore.deleteNpc` and admin DELETE block deletion when an NPC is referenced by a tile.

## Quest system

`QuestTypes.ts` defines `QuestDefinition` (id, name, description, `scope: 'solo' | 'party_shared'`, `objectives[]`, `rewards[]`, optional `prerequisiteQuestIds`, `requiredLevel`, `repeat: 'once' | 'weekly'`), the `QuestStatus` state machine (`accepted` → `in_progress` → `ready` → `completed`), and helpers (`canAcceptQuest`, `objectivesComplete`, `computeStatus`, `initialProgress`). Three objective kinds: **kill** (`monsterId`, `count`), **collect** (`itemId`, `count` — items consumed on turn-in), **visit** (`tileId`, count fixed at 1). Three reward kinds: **xp**, **gold**, **item**. Quest definitions stored in `data/quests.json`, managed by `ContentStore` (no seed — admins author all quests). Server-side per-player state lives in `QuestSystem` (`server/src/game/QuestSystem.ts`): owns `active` (Map of `QuestProgressEntry`), `completed` (history), and `weeklyCompletions` (last completion ISO per weekly quest). Each `PlayerSession` owns its own `QuestSystem` instance. Persisted in `PlayerSaveData` as `activeQuests`, `completedQuests`, `weeklyCompletions`. **Scope semantics**: `solo` quests can ONLY be accepted while the player is in a solo party (size 1) — enforced at accept time. After accept, both scopes credit the player normally for any kill/visit they participate in (since combat is shared per-party, every party member with the quest accepted gets credit on a kill). **Progress hooks**: `PartyBattleManager.handleBattleEnd` victory branch iterates dead monsters → calls `applyKill(monsterId, allQuests)` on every party member's `QuestSystem`. The `onMove` callback iterates members and calls `applyVisit(tileId, allQuests)`. Collect progress is computed dynamically: `recomputeCollect(allQuests, getInventoryCount)` is called in `PlayerSession.buildQuestState()` before every state push, so the live `collect` progress always reflects current inventory. **Turn-in**: must be at the NPC who offered the quest. Collect items are consumed (`removeFromInventory`) before rewards are granted via `addXp`/`addGold`/`addOneToInventory`. Weekly quests record their completion timestamp; re-accept is blocked for 7 days. **WS protocol**: `accept_quest` and `turn_in_quest` client messages; `ServerStateMessage` includes `activeQuests`, `completedQuests`, `questDefinitions` (only quests the player has interacted with or is currently being offered), and `offeredQuestIds` (the NPC at the player's current room, if any). **Client UI**: `NpcTalkPopup` renders three quest sections — Available (with Accept button — only shown when `canAcceptQuest` returns null), In Progress (with live objective counts), Ready to Turn In (with Turn In button). Quest log card on the Character screen lists active quests with status pill + objective progress, plus a `{N} completed` summary. **Admin**: `QuestsTab` form covers every quest field (objectives builder with kill/collect/visit kinds, rewards builder with xp/gold/item kinds, prerequisites multi-select, required level, repeat). NPCs link to quests via the multi-select `questIds` checklist on the NPC edit form. Both `deleteQuest` paths (live and snapshot) block deletion if any NPC offers the quest or any other quest depends on it as a prerequisite.

## World map & room names

The world map is defined in `data/world.json` (`WorldData`) as an array of `WorldTileDefinition` objects, each with `id` (GUID), `mapId`, `col`, `row`, `type` (TileType), `zone` (zone ID), and `name` (room name, required). Each tile has a stable GUID (`id`) that persists across admin saves but changes when a tile is deleted and re-created. Every tile has an evocative room name (e.g., "Town Square", "Blacksmith", "Thick Trees"). The client receives ALL tiles via `GET /api/world` (auth'd) on login; fog of war rendering is determined client-side from `state.unlocked`.

### Multi-map / interior maps

A world is a collection of independent hex **maps**, not one grid. `WorldData` carries a `maps` registry (`WorldMapMeta[]` — `{ id, name, startTile }`), a `defaultMapId` (the spawn map), and the global `startTile` (a room on the default map). Every tile is tagged with `mapId`; legacy single-map worlds are normalized by `migrateWorldData()` (`shared/src/hex/MapSchema.ts`) into a one-entry `overworld` registry. `migrateWorldData` runs on every world load path — `ContentStore.tryLoadAll`/`replaceAll` and `VersionStore.loadSnapshot` — so old `data/world.json` and old version snapshots self-heal (and re-persist).

The server builds **one `HexGrid` per map** via `WorldGrids` (`server/src/game/WorldGrids.ts`), a stable registry (`Map<mapId, HexGrid>`). Both the registry object and each per-map grid keep their object identity across rebuilds (cleared + repopulated in place), preserving the by-reference invariant relied on by `PartyBattleManager`/`PlayerSession`/`ServerParty`. A `ServerParty` knows its `mapId` and owns the pathfinder for that map; `ServerParty.switchMap(grid, tile, mapId)` swaps both. Because each map's `HexPathfinder` is bound to its own disjoint grid, A* never crosses maps.

**Transitions**: a tile may set `transitions: MapTransitionLink[]` (`{ mapId, tileId, entryRequirements? }`) — a room can have several exits (a manhole and a staircase), each optionally gated (see [Room entry requirements](#room-entry-requirements)). Each target is identified by GUID (robust to col/row edits). Standing on such a room, a party travels via the `enter_transition` client message (which carries the chosen target `tileId`) → `PartyBattleManager.enterTransition(partyId, tileId)`: it verifies the current room actually offers that transition, checks the link's gate and then the destination room's gate, switches the party's grid + position, reveals the arrival area for every member (`PlayerSession.switchMapGrid` re-seats `UnlockSystem` on the new grid from the same GUID set — unlocks span maps for free), and restarts combat for a fresh encounter. Blocked inside a dungeon; falls back to the destination map's `startTile` if the exact tile is gone, else rejects. The state message carries top-level `currentMapId`; `OtherPlayerState.mapId` lets clients hide players on other maps. `migrateWorldData` also upgrades any legacy single `transitionsTo` field into the `transitions` array. Out of scope (separate issues): a zoomed-out overworld/map-select for players (#168), teleport items (#170–#172).

## Fog of war (unlock-based)

Fog of war is driven entirely by the existing `unlockedKeys` from `UnlockSystem` — no separate discovery tracking. Unlock keys are tile GUIDs (not cube coordinates), so renaming/moving tiles in the admin panel invalidates old unlock state. The server sends all tiles to the client; the client determines visibility from `state.unlocked` (sent every tick).

Three-tier rendering: **unlocked tiles** (full brightness), **zone-unlocked tiles** (dimmed; zone has at least one unlocked tile), **foggy tiles** (very dim; zone not yet unlocked). The darken factor lives in `ThreeWorldMap.drawTile` (`isNonTraversable ? 0.42 : isUnlocked ? 1 : isZoneUnlocked ? 0.55 : 0.32`) and is applied to the tile-type color and to the emoji glyph (via `globalAlpha`) so the three tiers read consistently.

Every tile renders in three layers regardless of unlock state — tile-type color (always), real artwork overlay if uploaded (per-tile `/tile-artwork/{tileId}.png` then per-type `/tile-type-artwork/{type}.png`), otherwise the tile-type emoji glyph. No `placehold.co` fallback at the bake layer — missing art falls through to the emoji rather than masking the background color with a stub. See [`client.md`](client.md) → "World map (three.js)" for the perf details (hex-clipped sprite cache + pre-blurred shadow + WebGL composite).

**Non-traversable tiles** (mountains, water, hedges, volcanoes) always render in a fixed dimmed style with their terrain icon — they are unaffected by fog of war or unlock state. Zone names are always visible on all tiles. Players can click and attempt to travel to any visible tile regardless of fog state. Zone unlock is computed client-side by `WorldCache.updateUnlocked()` from the unlock keys.

## Room entry requirements

Rooms and map transitions can be gated behind requirements the whole party must meet. The model lives in `shared/src/systems/RoomRequirements.ts`:

```ts
interface RoomEntryRequirements {
  minLevel?: number;          // every member at or above this level
  requiredItemId?: string;    // every member has it equipped
  requiredQuestIds?: string[]; // every member has completed (turned in) each
}
```

**Party semantics.** ALL members must satisfy EVERY set requirement — the same rule the original item-only gate used. A member with no live session satisfies nothing. `validateRoomEntry(reqs, members, labels)` is a pure shared function (sibling of `validateDungeonEntry`) returning a `RoomEntryFailure` — the unmet requirement kind, player-facing `reason`, and the `missingPlayers` who don't meet it — or `null` when entry is allowed. Checks run item → level → quest, so a purely item-gated room produces the same rejection it always did.

**Where gates attach.**
- `TileTypeDefinition.entryRequirements` — the default for every room of that type.
- `WorldTileDefinition.entryRequirements` — a per-room override, merged with the type's gate **field by field** (`mergeRoomRequirements`). Setting a level requirement on one room therefore does not silently drop the item requirement it inherits. The trade-off: a room cannot *clear* a requirement its type sets.
- `MapTransitionLink.entryRequirements` — requirements on *taking that exit*, which is a room action rather than room entry (the same shape as `DungeonEntryRequirements`). Enforced *in addition to* the destination room's own gate: a door and the room behind it lock independently.

`HexTile.entryRequirements` resolves the merged gate; `HexTile.requiredItemId` is now derived from it.

**Legacy `requiredItemId`.** The original scalar field still exists on both `WorldTileDefinition` and `TileTypeDefinition` and is still honoured — `toRoomRequirements()` folds it into the gate at read time, with an explicit `entryRequirements.requiredItemId` winning. No data migration was needed. The admin forms write the new field and clear the legacy one on save.

**Enforcement** (server-authoritative, in `PartyBattleManager`). A requirement is checked **when the party asks to enter**, and nowhere else:
- `handleMove` scans every room in the requested path up front. A rejected move restores the party's previous path rather than stranding it.
- `enterTransition` checks the transition's own requirements, then the destination room's.

There is deliberately **no per-step re-check** during movement. Once a path is approved it runs; `canMoveToNextTile` stays a pure fog-of-war check. The only thing that can invalidate an approved path is the world changing underneath it, and that is handled by relocation rather than by re-validating every room on every combat tick for every party.

**When the world changes.** A content deploy clears every party's movement queue (`refreshAllPartyTiles` → `ServerParty.relocateTo`), so a queued path is never stale. A party left *standing in* a room whose new requirements it doesn't meet is picked up by `relocateDisplacedParties`, which sends it to the world start tile — the one room guaranteed to be ungated — logs the reason, and raises a `world_room_gated` notification so the move isn't a silent surprise on next login. There is no attempt to find a "nearest room they still qualify for": the neighbours of a gated room are usually gated the same way. This check runs on every map.

Note that the *other* half of that sweep — the pre-existing "is this room still reachable?" flood fill — is scoped to the map holding the world start tile only. Walking one grid from one start tile isn't a meaningful test of reachability on a map whose rooms are entered through (possibly one-way) transitions, and a false "stranded" verdict teleports a party that was somewhere perfectly legitimate. Issue #374 tracks doing this properly across the world graph.

Rejections reach the client as a `move_blocked` message (`ServerMoveBlockedMessage`) carrying `requirement`, `reason`, `missingPlayers`, plus kind-specific fields; blocked transitions reuse the same message. The client renders it as a map toast — there is no client-side preview of gates, because party members' levels, equipment, and quest history are not in the client's state (see `docs/architecture/client.md`).

**Known gap.** A member who joins a party mid-path inherits an approved path they may not qualify for, and gets carried through. Given "weak solo, strong together", being ferried by a friend is arguably fine; if it ever needs closing, the place to do it is `handlePartyJoin`, not the movement tick.

**Equipment lock.** Items required by the current room or any room in the remaining path stay locked — they cannot be unequipped (`PlayerSession.getLockedItemIds`). This reads through the resolved gate, so items authored either way are covered. Level and quest requirements need no equivalent (they can't be un-met). Trades and destroy cannot affect equipped items, so the unequip lock is sufficient.

**Authoring.** Admin: the Map tab's room sidebar and the Tile Types form both render the shared `EntryRequirements` editor (`client/src/admin/components/EntryRequirements.ts`). Per-transition gates are authored via MCP; the Map tab shows a 🔒 summary on a gated exit but does not yet edit it. MCP: `upsert_tiles` accepts `entryRequirements` on a room and on each transition, and `validate_draft` reports gates that reference unknown items or quests.

## Tile types

Data-driven content type stored in `data/tile-types.json`, managed by ContentStore, editable via admin dashboard. `TileTypeDefinition` has `id`, `name`, `icon`, `color` (hex string), `traversable`, and optional `entryRequirements` (the default entry gate for all tiles of this type) plus the legacy `requiredItemId` it supersedes. Seed types: Plains, Forest, Mountain (non-trav), Water (non-trav), Town, Dungeon, Void (non-trav), Desert, Lava Field, Beach, Hedge (non-trav), Volcano (non-trav). Per-tile `entryRequirements` on `WorldTileDefinition` overrides the type-level gate field by field — see [Room entry requirements](#room-entry-requirements). Admin can create, edit, and delete tile types (delete blocked if tiles reference the type). Client receives tile type definitions via `GET /api/world` response and uses them for data-driven map rendering (icons, colors, traversability).

## WorldCache (client)

`WorldCache` (`client/src/network/WorldCache.ts`) is the client-side cache for world data. Loaded once from `GET /api/world` on login (in parallel with WS connect). Stores all tiles (keyed `mapId:col:row`, since two maps may share a `col,row`), the `maps` registry + `defaultMapId`, start position, tile-type defs, and NPC catalog. It tracks a `currentMapId` (driven by `ServerStateMessage.currentMapId` via `setCurrentMap`) and exposes only the current map: `getTiles()`/`getTile(col,row)` are map-scoped, while `getTileByGuid(id)` resolves across maps (used to name a transition's destination). `updateUnlocked(tileIds)` computes unlock state from `state.unlocked` tile GUIDs each tick, scoped to the current map; switching maps invalidates the change-detection short-circuit so fog recomputes. `ThreeWorldMap` builds its `HexGrid` from the current map's tiles and rebuilds + recenters when `currentMapId` changes.

## Artwork & imagery

Every kind of image the game serves is declared once in `ASSET_KIND_INFO` (`shared/src/assets/AssetKinds.ts`) — the single source of truth for the server's Express static mounts, the admin upload API, the MCP asset tools, the client's `artworkUrl()`, and the vite dev proxy. The kind set used to be written down in five places that had drifted apart (the game served 15 kinds while only 7 could be uploaded); adding a kind is now one row in the registry. Each row carries a `label`, `description`, `dir` (folder under the process working directory), `mount` (public URL prefix), `idSource` (drives the coverage report), `idFormat`, `shape`, and optional `fallbacks`/`overrideIdSource`/`fixedIds`/`lowercaseIds`.

**URL convention**: `<mount>/{id}.png`, served statically from `data/<dir>/`. Most kinds follow `/{kind}-artwork/{id}.png`; the three icon sets predate that convention and keep their own mounts, which is why `dir`/`mount` are spelled out per row rather than derived from the kind name. `assetPublicPath(kind, id)` builds the URL — never hand-concatenate one.

| Kind | Art for | Id | Shape |
| --- | --- | --- | --- |
| `item` | Inventory / loot / shop icons | `ItemDefinition.id` | square |
| `monster` | Combat-screen portraits | `MonsterDefinition.id` | square |
| `set` ⏸ | Equipment-set browser | `SetDefinition.id` | square |
| `shop` ⏸ | Room-view shop action button | `ShopDefinition.id` | square |
| `zone` | Zone art, and the last-resort combat backdrop | `ZoneDefinition.id` (the zone tag, not `displayName`) | square |
| `tile` | Per-room map art overriding the room-type art | `WorldTileDefinition.id` (room GUID) | square |
| `tile-type` | Baseline map art for every room of a type | `TileTypeDefinition.id` | square |
| `parchment` | Tiling backdrop behind the world map | `WorldMapMeta.id` | square |
| `class` | Character portraits (combat / character / profile) | Class name, folded to lowercase (`Knight` → `knight.png`) | square |
| `npc` | Talk-popup portraits | `NpcDefinition.id` — but see the NPC note below | square |
| `logo` | Splash-screen logo | fixed single id `idle-party` | any |
| `combat-bg` | Backdrop behind the combat stage | zone id, or `{zoneId}-{col}-{row}` per room | any |
| `room-bg` | Backdrop behind the room view | zone id, or `{zoneId}-{col}-{row}` per room | any |
| `class-icon` | Inline class glyphs (party lists, chat, leaderboard) | Class name as spelled, plus `Unknown`/`Server` (case-sensitive — `CLASS_ICONS` requests `Knight.png`) | square |
| `slot-icon` | Equipment-slot dogear glyphs | `EquipSlot` id | square |
| `nav-icon` | Bottom-nav button glyphs | Nav destination id | square |

`shape: 'square'` rejects non-square uploads; `'any'` accepts any aspect ratio (the wide backdrops and the logo). NPCs may skip the folder entirely by pointing `NpcDefinition.artworkUrl` at any URL.

**⏸ Deferred kinds.** `set` and `shop` are in the registry — still mounted, still served, still type-checked — but listed in `DEFERRED_ASSET_KINDS` rather than `MANAGED_ASSET_KINDS`, so the assets API, the MCP tools, and the coverage report all skip them and the routes reject them with a 400 explaining why. Each is blocked on a client-side problem that would make managing its art misleading:

- `set`: nothing in the client renders set art at all, so coverage would pressure authors to draw art that never appears.
- `shop`: the uploader writes `/shop-artwork/{ShopDefinition.id}.png`, but `RoomView.renderCurrentRoom` fetches `/shop-artwork/{zoneId}.png` — the room's zone tag, not the shop id. Uploaded shop art therefore doesn't render unless a shop's id happens to equal its zone's.

Existing files in `data/set-artwork/` and `data/shop-artwork/` are untouched and keep serving. Un-deferring a kind is a one-line move between the two lists (plus whatever client fix unblocked it); `shared/tests/AssetKinds.test.ts` asserts the two lists partition `ASSET_KINDS`, so a kind can't be added without landing in one of them.

**Fallback chains** — several kinds resolve through a chain rather than a single file, and the registry's `fallbacks` mirror what the render sites actually do:

- **Rooms**: the world map draws per-room `/tile-artwork/{tileId}.png` first, then per-type `/tile-type-artwork/{type}.png`, then the tile-type emoji glyph (no `placehold.co` at the bake layer). Room-type art already covers every room, so a room with no override of its own isn't missing anything — `tile` has `idSource: 'none'`.
- **Combat backdrop** (`CombatScreen.updateCombatBackground`): per-room `/combat-bg-artwork/{zoneId}-{col}-{row}.png` → zone default `/combat-bg-artwork/{zoneId}.png` → `/zone-artwork/{zoneId}.png` → placeholder. The key is the current room's raw `zone` tag, **not** a slug of the zone's display name.
- **Room backdrop** (`RoomView.renderCurrentRoom`): per-room `/room-bg-artwork/{zoneId}-{col}-{row}.png` → zone default `/room-bg-artwork/{zoneId}.png`, layered as two CSS background images so the room-specific one wins when present.
- **Monsters**: art is keyed by `MonsterDefinition.id` (what the admin upload writes). `CombatScreen.monsterArtSrc` falls back to a slug of the monster's name when a combat payload carries no id, so older art dropped in by name still renders — and the coverage report counts a name-slug file as covering the monster rather than reporting it missing.
- **NPCs**: `NpcTalkPopup` renders `NpcDefinition.artworkUrl` verbatim (falling back to the NPC's emoji) rather than fetching `/npc-artwork/{id}.png`. An uploaded NPC PNG only renders once `artworkUrl` points at it. The coverage report accounts for this: an NPC carrying an `artworkUrl` resolves as `external` rather than being counted as a gap.

**Artwork is deliberately NOT versioned.** It is not a field on any content type and is not part of `ContentSnapshot`: half the kinds have no owning entity at all (parchment keys on a map id, backdrops on a zone, the logo is a singleton, the icon sets aren't content), and binary blobs would balloon every version snapshot. So artwork is live and global — an upload is visible immediately regardless of draft mode, and publish/rollback never moves a PNG. The trade-off is that rolling a content version back does not roll its art back.

**Storage & API**: `AssetStore` (`server/src/game/AssetStore.ts`) is the swappable store behind `data/<kind>-artwork/` — see [`persistence.md`](persistence.md). It validates every write (PNG signature + `IHDR` chunk, per-kind shape, 512 KB cap) and refuses any id that could escape its folder. Admins reach it through `/api/admin/assets/*` ([`admin-dashboard.md`](admin-dashboard.md)) and AI authoring reaches it through the MCP asset tools ([`mcp.md`](mcp.md)).

**Coverage report**: `computeAssetCoverage` (`server/src/game/AssetCoverage.ts`) answers "what imagery is missing?" by joining every asset folder against the content that's supposed to have art in it — per kind it reports `required` / `present` / `missing` / `coveredByFallback` (missing its own art but still rendering real art through a fallback) / `overrides` (legitimate per-room files) / `orphans` (files matching no required id and no override shape, usually art left behind by deleted content), plus optional per-id `entries` whose `resolvedVia` says `own`, `fallback:{kind}`, `external` (the entity points at its own artwork URL), or `placeholder`. Accounting for the fallback chains is the whole point: a naive does-the-file-exist check reports thousands of false positives. Served at `GET /api/admin/assets/coverage` and as the `get_asset_coverage` MCP tool.

## Content versioning

Admin content edits go through a draft→publish→deploy pipeline. `VersionStore` manages version metadata (`data/versions/manifest.json`) and snapshots (`data/versions/{id}.json`). Each snapshot freezes all game content (monsters, items, zones, world, sets, shops, npcs, quests, dungeons, tile types, skills, skill slot schedules, design notes). On deploy, `GameLoop.deployVersion()` replaces live content, rebuilds the hex grid, relocates displaced parties (unreachable rooms — start tile's map only, see #374 — and rooms whose entry requirements the party no longer meets), and reconciles every session's skill loadout against the new content.

**When adding new content types to the game, they must be included in `ContentSnapshot` (`VersionStore.ts`) and `ContentStore.toSnapshot()`/`replaceAll()`.**

## Design notes

`DesignNote` (`shared/src/systems/DesignNoteTypes.ts`) is a markdown note — `{id, title, body, tags?, author, createdAt, updatedAt}` — that rides inside a content version snapshot to record the agreed-upon design context for a draft. Stored via `ContentStore` (`data/design-notes.json`, no seed) and included in `ContentSnapshot`/`toSnapshot()`/`replaceAll()` with keep-when-absent semantics on deploy, same as skills. Notes are authored only through MCP tools and are never sent to players. See `docs/architecture/mcp.md` for the full picture (the MCP server, tool catalog, and the read-only Design Notes panel on the admin Versions tab).

# Backlog

Issue-sized backlog items. Each entry is intended to become a single GitHub issue — title, summary, scope/deliverables, optional dependencies. Grouped by theme for browsing; groups have no implied priority order.

Format:
```
### [TAG] Title
**Summary**: Why we want this.
**Deliverables**: Concrete things that need to ship.
**Dependencies**: Other issues that must land first (if any).
**Notes**: Open questions, design caveats.
```

Tags: `engine`, `dungeon`, `world`, `craft`, `consumable`, `item`, `guild`, `social`, `notify`, `admin`, `analytics`, `anticheat`, `mcp`, `qol`, `bigbet`.

---

## Table of Contents

1. [Game Engine & Core Systems](#game-engine--core-systems)
2. [Dungeons](#dungeons)
3. [World & Maps](#world--maps)
4. [Crafting](#crafting)
5. [Consumables & Auto-Use](#consumables--auto-use)
6. [Items, Economy & Progression](#items-economy--progression)
7. [Guilds](#guilds)
8. [Social & Communication](#social--communication)
9. [Notifications & PWA](#notifications--pwa)
10. [Admin & Content Tooling](#admin--content-tooling)
11. [Analytics & Balancing](#analytics--balancing)
12. [Anti-Cheat & Integrity](#anti-cheat--integrity)
13. [AI-Assisted Content (MCP)](#ai-assisted-content-mcp)
14. [Quality of Life](#quality-of-life)
15. [Long Shots / Big Bets](#long-shots--big-bets)

---

## Game Engine & Core Systems

### [engine] World events framework
**Summary**: A scheduler that can apply global modifiers (e.g., "Blood Moon: +50% monster HP, +100% drops") for a time window.
**Deliverables**:
- `WorldEventDefinition` type + `data/world-events.json` via ContentStore.
- Scheduler that activates/deactivates events at timestamps (cron-style).
- Hook into `CombatEngine` so active events can modify damage, HP, drops, XP.
- Admin editor for authoring events.
- Client toast + banner when an event starts/ends.

### [engine] Timed boss spawns
**Summary**: Named bosses that spawn in specific rooms at specific times (daily/weekly cadence).
**Deliverables**:
- `BossSchedule` entries tied to a tile.
- Server spawns a boss encounter at the scheduled time, replaces the normal encounter table temporarily.
- Announcement in global chat N minutes before spawn.
**Dependencies**: Encounter redesign (see `ideas/encounters.md`).

### [engine] Monster targeting-priority overrides
**Summary**: Let `MonsterDefinition` declare non-default targeting rules ("lowest HP," "healer class," "back row").
**Deliverables**:
- Extend `MonsterDefinition` with optional `targetingPriority` enum.
- Update `findTarget()` in `CombatEngine.ts` to honor it.
- Admin form checkbox/dropdown.
- Tests for each priority mode.

### [engine] Multi-action & scripted monsters
**Summary**: Monsters that act more than once per tick, or have scripted abilities (phase changes, enrage, summons).
**Deliverables**:
- Support `actionsPerTick` on `MonsterDefinition`.
- Ability hook system: `onHpThreshold`, `onTick`, `onAllyDeath` — configurable abilities per monster.
- Extend CombatEngine to run these hooks.
- Admin editor for ability scripts.

### [engine] Monster status effects
**Summary**: Monsters can apply the same DoT/HoT/stun/shield effects the skill system already supports.
**Deliverables**:
- `MonsterAbility` type that emits a `PassiveEffect`- or `ActiveEffect`-shaped effect on hit.
- Thread through `applyDamageToPlayer` to register effects on targets.

### [engine] Henchmen (hireable NPCs)
**Summary**: NPCs a solo player can hire to fill party slots. Weaker than players to still incentivize real parties.
**Deliverables**:
- `Henchman` type (class, level, hire cost, fixed equipment).
- Town NPC UI to browse/hire.
- Henchman fills a party grid slot, acts in combat, takes a share of loot (or not — decide).
- Dismiss / replace flow.

### [engine] Pet slot
**Summary**: A single pet that adds passive bonuses and an occasional attack, without occupying a grid position.
**Deliverables**:
- `Pet` definition (name, level, passive bonus, attack stats).
- Pet slot on character.
- Pet acts once every N ticks in combat.
- Pet stable / collection UI.

### [engine] Quest system MVP
**Summary**: Simple kill/collect/visit quests from NPCs, with XP/gold/item rewards.
**Deliverables**:
- `QuestDefinition` + `data/quests.json`.
- NPC tiles (or an NPC component of a tile) that offer quests.
- Quest log UI (active, completed).
- Progress tracking in `PlayerSaveData`.
- Admin editor.

### [engine] Quest chains
**Summary**: Sequential quests that unlock new zones/items.
**Dependencies**: Quest system MVP.
**Deliverables**: Prerequisite field on quests, chain visualization in quest log.

### [engine] Daily/weekly repeatable quests
**Summary**: Give idle players a login goal.
**Dependencies**: Quest system MVP.
**Deliverables**: Repeat cadence on quests, reset cron job, UI indicator.

### [engine] Faction reputation system
**Summary**: Reputation scores tied to zones/NPCs. Unlock quests, vendors, titles.
**Deliverables**:
- `FactionDefinition` + per-player rep map.
- Rep deltas on quest completion and monster kills.
- Opposing factions (helping A hurts B).
- Faction page on the Character screen.

### [engine] Death penalty system
**Summary**: Soft penalty on party wipe to make loss meaningful without being anti-idle.
**Deliverables**: Decide mechanic (XP shave, durability, gold drop). Implement + tune. UI feedback in combat log.
**Notes**: Explicit design decision; should default to opt-in or very mild for idle-friendliness.

### [engine] Class combo system
**Summary**: Certain skills from different classes chained within N ticks trigger a bonus — rewards class diversity.
**Deliverables**:
- Combo definition language (skill A followed by skill B from different player).
- Combo tracker in combat state.
- UI indicator when a combo fires.

### [engine] Status resistance stats on gear
**Summary**: Add resistance stats (poison, stun, silence) to gear affixes.
**Dependencies**: Existing equipment system.
**Deliverables**: New stat fields on `ItemDefinition`, hooked into effect-application code.

### [engine] Expanded damage types
**Summary**: Add `nature`, `cold`, `fire`, `dark` to `DamageType`.
**Deliverables**:
- Extend enum + targeted `computeEquipmentBonuses`.
- Resistance stats per type.
- Elemental weakness matrix per monster.
- Admin UI for new types.
- Tests.

---

## Dungeons

### [dungeon] Dungeon data model + ContentStore integration
**Summary**: Scaffolding for dungeons: definitions, storage, admin CRUD.
**Deliverables**:
- `DungeonDefinition` type with floors, grid shape, entry requirements, rewards.
- `data/dungeons.json` via ContentStore.
- Admin list/create/edit/delete screen (no game behavior yet).
**Notes**: First step — downstream dungeon issues depend on this.

### [dungeon] Dungeon instance runtime
**Summary**: Parties can enter a dungeon and get a private instance with floor progression.
**Dependencies**: Dungeon data model.
**Deliverables**:
- Instance manager — one active instance per party.
- Floor progression on victory.
- Exit / bail-out flow.
- Instance cleanup on party disband or timeout.

### [dungeon] Entry requirements enforcement
**Summary**: Block dungeon entry based on level, required item, required classes, party size.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Entry validation with clear error messages; tests.

### [dungeon] Non-3x3 grid shapes
**Summary**: Support arbitrary grid rectangles (2x3, 5x5, 4x2) for dungeons.
**Deliverables**:
- Generalize `PartyGridPosition` from fixed 0-8 to (col, row) on an arbitrary rectangle.
- Update targeting algorithms.
- Client combat rendering handles variable grids.
- Tests.

### [dungeon] Party size above 5 (raid mode)
**Summary**: Raid dungeons with party cap of 10–20.
**Dependencies**: Non-3x3 grid shapes.
**Deliverables**:
- Remove hard-coded party cap for dungeon instances.
- UI for larger party rosters and grids.
- Loot distribution decisions for large parties.

### [dungeon] Dungeon time limits
**Summary**: Optional timer per dungeon; party kicked or loot forfeited on expiry.
**Deliverables**:
- `timeLimitSec` on `DungeonDefinition`.
- Countdown UI.
- Server-side timeout handling.

### [dungeon] Dungeon lockouts / cooldowns
**Summary**: Daily/weekly lockout per dungeon to protect loot economy.
**Deliverables**:
- Per-player lockout state in `PlayerSaveData`.
- Reset cron.
- UI showing next available time.

### [dungeon] Dungeon boss rooms
**Summary**: Last floor is a unique boss encounter with special mechanics.
**Dependencies**: Dungeon instance runtime, scripted monsters.
**Deliverables**: `isBoss` flag on floor, optional unique drop table, victory fanfare.

### [dungeon] Dungeon-specific loot tables
**Summary**: Unique items + first-clear rewards per dungeon.
**Deliverables**: Reward tables on dungeon floors, one-time first-clear flag per player, UI indicating unclaimed.

### [dungeon] Dungeon tokens + rotating vendor
**Summary**: Earn tokens from dungeon clears, spend at a vendor on rotating cosmetic/utility items.
**Deliverables**: New currency, earn/spend mechanics, weekly rotation config.

### [dungeon] Dungeon leaderboards
**Summary**: Track fastest clear, most damage, least damage taken per dungeon.
**Deliverables**: Leaderboard store, admin-configurable metrics, UI.

### [dungeon] Roguelike dungeon variant
**Summary**: Procedural floors with between-floor buff choices.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Procedural floor generator, buff draft UI, loot only on completion.

### [dungeon] Solo trial dungeons
**Summary**: Single-player dungeons tuned per class to test mastery.
**Deliverables**: Tuning per class, class-locked entry requirement, class-specific rewards.

### [dungeon] Class trial dungeons
**Summary**: "5 of the same class only" dungeons with class-exclusive rewards.
**Deliverables**: Entry requirement: all members same class. Reward gated to that class.

---

## World & Maps

### [world] Multi-map / interior map support
**Summary**: A room can transition to a different hex map (castle interior, floor 2, etc.).
**Deliverables**:
- `transitionsTo: { mapId, tileId }` on `WorldTileDefinition`.
- Multiple `HexGrid` instances, one per map, with consistent WorldCache on the client.
- Party movement across maps (snap to new position on transition).
- Admin UI for creating and linking maps.

### [world] Continents / top-level maps
**Summary**: Multiple top-level maps linked by ports, portals, or airships.
**Dependencies**: Multi-map support.
**Deliverables**: Map-select UI, per-map fog of war, shared global unlock tracking.

### [world] Weather/biome per-room effects
**Summary**: Tiles can declare temporary buffs/debuffs (rain slows casters, night boosts undead).
**Deliverables**: Tile-level modifier list, hook into combat engine, admin UI.

### [world] Town portal scrolls
**Summary**: Consumable that sends party (or self) to a bound town.
**Dependencies**: Consumables framework.
**Deliverables**: Scroll item + "bind to town" action + teleport handler.

### [world] Teleport runes (craftable, one-use)
**Summary**: Crafted consumable teleports bearer to a specific room picked at craft time.
**Dependencies**: Crafting system, town portal scrolls.
**Deliverables**: Rune item with `destinationTileId` field set on craft; UI for picking destination.

### [world] Waypoints / bindstones
**Summary**: Discover waypoints on the map, fast-travel between them for gold.
**Deliverables**:
- Waypoint tile type.
- Per-player discovered-waypoint list.
- Fast-travel UI with gold cost.

### [world] Summon scrolls
**Summary**: Consumable — one player summons a party member from another tile.
**Dependencies**: Consumables framework.
**Deliverables**: Consumable type + target-selection UI + consent prompt on target.

### [world] Recall home (long cooldown)
**Summary**: Free, long-cooldown teleport back to the starting town. Guards against stuck parties.
**Deliverables**: Cooldown tracker on player state, UI button.

---

## Crafting

### [craft] Crafting framework core
**Summary**: Baseline for class-specific crafting queues that run in parallel to combat.
**Deliverables**:
- `CraftingDefinition` + `RecipeDefinition` + `data/recipes.json`.
- Per-player crafting queue (jobs with time-to-complete).
- Tick/offline progress.
- Crafting screen UI.
- Save/restore of queue state.

### [craft] Crafting skill leveling
**Summary**: Separate skill level per player; crafting more yields better quality chance.
**Dependencies**: Crafting framework core.
**Deliverables**: Skill XP per craft type, leveling formula, unlocks gated on skill level.

### [craft] Knight heavy smithing
**Summary**: Class craft — iron/steel/plate/heavy weapons.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, material drops (ore), smithy room type/requirement.

### [craft] Mage alchemy (potions)
**Dependencies**: Crafting framework core, consumables framework.
**Deliverables**: Recipe set, herb/reagent materials, potion outputs.

### [craft] Priest enchanting
**Summary**: Priest applies enchantments to existing gear.
**Dependencies**: Crafting framework core.
**Deliverables**: Enchant recipes that modify an item's stats (limited slots per item).

### [craft] Archer light crafting
**Summary**: Leather, wood, bows, light armor.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, hide/wood materials, workshop flow.

### [craft] Bard jewelry
**Summary**: Rings, amulets, instruments — feeds the socket/gem system.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, gem/metal materials.

### [craft] Material drops & harvest nodes
**Summary**: Raw materials drop from monsters + harvestable from room types (mines, forests, sea).
**Deliverables**: Extend drop tables, add harvest nodes as tile features, UI for harvest actions.

### [craft] Recipe unlock via drops/quests
**Summary**: Recipe discovery mechanics.
**Dependencies**: Crafting framework core, quest system (for quest route).
**Deliverables**: Recipe drop table entries; quest reward recipes; unlock state on player.

### [craft] Output quality tiers
**Summary**: Roll quality (normal/fine/masterwork) on crafted items.
**Dependencies**: Crafting framework core.
**Deliverables**: Quality roll + stat modifiers + visual indicator on item.

### [craft] Craft station room requirements
**Summary**: Some recipes require being at a specific room (forge, alchemy lab).
**Deliverables**: Optional station requirement on recipes; check on queue start; UI call-out.
**Notes**: Open question — should queued jobs require being at the station the whole time, or just at job start?

### [craft] Inter-class recipe dependencies
**Summary**: Recipes that require an item from another class's craft (Archer bowstring → Mage enchanted bow). Encourages trading.
**Deliverables**: Reagent field on recipes referencing arbitrary items; balance pass.

---

## Consumables & Auto-Use

### [consumable] Consumables framework
**Summary**: Core system for usable items — effects, durations, stacking rules.
**Deliverables**:
- `ConsumableDefinition` type (instant, fight-count, time-based, permanent-until-death).
- Effect application (self / party, targets).
- Stacking rules per category.
- Buff bar UI.
- Save/restore of active buffs.

### [consumable] Auto-use toggles
**Summary**: Per-consumable opt-in auto-use with trigger conditions.
**Dependencies**: Consumables framework.
**Deliverables**:
- Triggers: HP threshold, combat start, idle, debuff present, custom.
- Per-item auto-use setting persisted on item instance or inventory slot.
- UI toggle in the Items screen.

### [consumable] Rare-consumable guard
**Summary**: Prevent rare consumables from auto-consuming.
**Dependencies**: Consumables framework.
**Deliverables**: Rarity-based default (rare+ never auto). Explicit admin override per item.

### [consumable] Heal / mana / stamina potions
**Summary**: Baseline potion set.
**Dependencies**: Consumables framework.
**Deliverables**: Potion items, auto-use rules, tuning.

### [consumable] Cure / antidote potions
**Summary**: Cleanse debuffs.
**Dependencies**: Consumables framework, status effect system.
**Deliverables**: Cleanse effect, auto-use trigger "when debuffed."

### [consumable] Stat-buff elixirs
**Summary**: Temp +damage / +DR / +MR / +crit elixirs.
**Dependencies**: Consumables framework.
**Deliverables**: Buff effects, UI, tuning.

### [consumable] XP / gold-find / drop-rate boosters
**Summary**: Time-based progression boosters.
**Dependencies**: Consumables framework.
**Deliverables**: Buff implementations hooked into XP/gold/drop pipeline.

### [consumable] Reset scrolls
**Summary**: Reset a skill cooldown or remove a DoT.
**Dependencies**: Consumables framework.
**Deliverables**: Effect type, target picker UI.

---

## Items, Economy & Progression

### [item] Socket & gem system
**Summary**: Sockets on gear accept gems for extra stats.
**Dependencies**: Bard jewelry craft.
**Deliverables**: `sockets` field on items; gem items; socketing UI; stat integration.

### [item] Gear upgrade (+1 … +10)
**Summary**: Upgrade gear using crafting currency.
**Dependencies**: Crafting framework, currency pass.
**Deliverables**: Upgrade recipe/action; fail/success rolls; visible +N on item name.

### [item] Reforging (reroll stats)
**Summary**: Re-roll stats on an item for a cost.
**Deliverables**: Reforge NPC/station; cost formula; UI.

### [item] Salvage gear for materials
**Summary**: Break down gear into crafting materials.
**Dependencies**: Crafting framework.
**Deliverables**: Salvage action; material drop table per item type/rarity.

### [item] Auction house
**Summary**: Async player-to-player market.
**Deliverables**: Listing/bidding data model; UI with search/filter; expiration + refund; fee.
**Notes**: Large scope — consider splitting into MVP (buy-now only) vs. full (bidding).

### [item] Player mailbox
**Summary**: Send items/gold to a specific player offline.
**Deliverables**: Mailbox store; send/receive UI; expiration/return policy.

### [item] Personal stash
**Summary**: Expandable paid stash.
**Deliverables**: Stash store per player; buy-slot UI; rent/cap decisions.

### [item] Partial set bonuses (2-piece / 4-piece)
**Summary**: Expand set bonuses beyond all-or-nothing.
**Dependencies**: Existing set system.
**Deliverables**: Threshold-based bonuses; UI tooltip showing which tier is active.

### [item] Set visual cosmetics
**Summary**: Particle/outline effect on combat sprite when set is equipped.
**Deliverables**: Cosmetic data field; Phaser renderer hook.

### [item] Vendor buy-low / sell-high anchoring
**Summary**: Vendors buy at fraction of value, sell at multiplier, as an economy anchor.
**Deliverables**: Configurable multipliers on shops; tuning pass.

---

## Guilds

### [guild] Guild ranks & permissions
**Summary**: Configurable ranks (Leader, Officer, Member, Recruit) with per-rank perms.
**Deliverables**:
- Rank structure on `Guild`.
- Permission flags (invite, kick, promote, MOTD, bank).
- UI for rank editing.
- Permission checks in guild routes.

### [guild] Guild MOTD & description
**Summary**: MOTD on login; long-form description on guild page.
**Deliverables**: Fields on `Guild`; edit UI for leaders; display on Guild tab.

### [guild] Guild tags
**Summary**: Short tag (`[IPR]`) shown next to member names everywhere.
**Deliverables**: Tag field; render across Users tab, chat, combat, popup.

### [guild] Guild leveling & XP
**Summary**: Guild earns XP from member activity; levels unlock perks.
**Deliverables**: Guild XP events (kills, dungeon clears), level curve, level display.

### [guild] Guild perk tree
**Summary**: Perks unlocked as guild levels up (+party XP, +loot quality, extra bank tab).
**Dependencies**: Guild leveling.
**Deliverables**: Perk definitions, purchase/unlock UI, effects hooked into the relevant systems.

### [guild] Guild achievements
**Summary**: "Kill 10k goblins," "Clear every dungeon."
**Dependencies**: Analytics event pipeline.
**Deliverables**: Achievement definitions, progress tracker, reveal UI.

### [guild] Guild bank
**Summary**: Shared stash with per-rank limits, deposit/withdraw log.
**Dependencies**: Guild ranks & permissions.
**Deliverables**: Bank store; UI; rate/limit enforcement; audit log.

### [guild] Guild raid / event calendar
**Summary**: Schedule dungeon runs visible to guild.
**Deliverables**: Event data model; RSVP UI; reminder notifications.

### [guild] Guild vs. guild leaderboards
**Summary**: Weekly rankings by XP, dungeons, etc.
**Dependencies**: Analytics event pipeline.
**Deliverables**: Leaderboard store; reset cron; UI.

### [guild] Guild hall / guild tile
**Summary**: Unique room only guild members can enter.
**Dependencies**: Multi-map support (or per-guild private tile).
**Deliverables**: Hall tile type; guild-gated entry; customization UI.

### [guild] Alliances
**Summary**: Two guilds can ally to share a chat channel (and maybe a hall).
**Deliverables**: Alliance data model; alliance chat channel; invite/accept flow.

### [guild] Guild finder
**Summary**: Browse public guilds, filter by size/activity/focus.
**Deliverables**: Search API; browse UI; filters.

### [guild] Apply-to-join flow
**Summary**: In addition to invites, players apply, officers accept/decline.
**Deliverables**: Application data model; application queue UI for officers.

### [guild] Guild audit log
**Summary**: Log of joins/leaves/kicks/bank transactions.
**Deliverables**: Event log; filter UI.

### [guild] Guild roster cap
**Summary**: Hard limit on guild size (target 30–50, likely configurable per guild tier or level).
**Deliverables**:
- `maxMembers` on `Guild` (default constant, overridable by perks).
- Enforcement on invite/accept.
- Clear UI messaging when full.
- Guild-finder filter showing "full" state.
**Notes**: Consider perk tree / guild level unlocks that raise the cap (e.g., +5 slots per tier).

### [guild] Defendable tile data model
**Summary**: Mark specific tiles as defendable and configure their daily reward pool.
**Deliverables**:
- `defendable?: boolean` and `dailyReward?: TileRewardSpec` on `WorldTileDefinition`.
- `TileRewardSpec` supports gold, item drops, currency, guild XP.
- ContentStore persistence + version snapshot.
- Admin UI toggle + reward editor on the tile form.
**Notes**: Rewards are per-tile so admins can tune contested hot-spots differently from frontier tiles.

### [guild] Tile ownership & occupation state
**Summary**: Track which guild currently holds each defendable tile and who they've deployed there.
**Deliverables**:
- New store (`GuildTileStore`) tracking `{ tileId, ownerGuildId, defenders: PlayerDeployment[], since }`.
- Deployment = `{ username, gridPosition }` — who the guild has stationed on the tile.
- Load/save + version on content snapshot? (Probably not — runtime-only, like guild data.)
- Public API to read "who holds this tile" for the room-info modal.
**Dependencies**: Defendable tile data model.

### [guild] Defender deployment UI
**Summary**: Guild officers assign which members defend a held tile and where they sit on the grid.
**Deliverables**:
- Guild tab → "Tile Defenses" sub-section listing held/contested tiles.
- Grid picker per tile for deploying up to N members.
- Members must meet criteria (online? level?) — pick a rule.
- Permissions: officer+ can deploy; configurable via guild rank perms.
- Members can opt in/out of being deployable.
**Dependencies**: Tile ownership & occupation state, guild ranks & permissions.
**Notes**: Decide cap on defenders per tile — probably tied to the combat grid shape (so 9 for 3x3, or more for larger contested-tile grids).

### [guild] Attack declaration flow
**Summary**: A guild declares intent to attack a defendable tile before the daily resolution window.
**Deliverables**:
- Declaration endpoint — officer+ of attacking guild flags the target tile.
- Declaration window (e.g., attacks must be declared N hours before the daily tick).
- Guild deploys attacking party separately from their defensive deployments.
- Pending attacks shown to all involved guilds.
- Cancel window before lockdown.
**Dependencies**: Tile ownership & occupation state.
**Notes**: Open question: one attack declaration per guild per day globally, or per tile? Start with per-tile with a global daily cap.

### [guild] Daily tile combat tick
**Summary**: Once per day, resolve combat on every contested defendable tile.
**Deliverables**:
- Cron job at a configurable UTC time.
- For each contested tile, run combat using the existing `CombatEngine` between deployed parties.
- Emit log events (start, hits, winner) to a persistent tile-battle log.
- Publish results to all involved guilds via chat + an in-app notification.
- Handle no-show cases (attacker declared but deployed nobody → forfeit).
**Dependencies**: Tile ownership & occupation state, attack declaration flow.
**Notes**: Keep the resolution synchronous per tile, but parallelize across tiles. Combat runs at 0ms-per-tick (not real-time) since players aren't watching live.

### [guild] First-attacker rule (prior-holder bias)
**Summary**: If a tile was held before this cycle, the *attacker(s)* get first attack in combat. Fresh/uncontested claims default to the current turn order.
**Deliverables**:
- `CombatEngine` gains an optional `firstActor: 'players' | 'monsters' | 'party-a' | 'party-b'` parameter on `processPartyTick` / `createPartyCombatState`.
- Daily-tile-combat wiring: if `ownerGuildId` existed at the start of the tick, attacker acts first.
- Tests covering party-vs-party with each side acting first.
**Dependencies**: Daily tile combat tick.
**Notes**: This is the big combat-engine lift. Current engine assumes players-then-monsters order; generalizing to "party A then party B" has knock-on effects on grid-targeting code. Spike before committing.

### [guild] Guild-vs-guild PvP combat mode
**Summary**: Adapt the combat engine to resolve party-vs-party (not party-vs-monsters) while reusing as much of the existing skill/equipment system as possible.
**Deliverables**:
- Generalize `processPartyTick` to take two `CombatSide` objects instead of players vs. monsters.
- Skills that target "monsters" map to "opposing side" in PvP.
- Heals/HoTs still target same side.
- Grid-based targeting rules apply to the opposing grid.
- PvP balance pass (flag certain skills as no-op or tuned differently in PvP).
- Unit tests for party-vs-party resolution.
**Dependencies**: Daily tile combat tick.
**Notes**: Largest engine change in this cluster. Consider introducing a `CombatMode = 'pve' | 'pvp'` and branching where necessary.

### [guild] Multi-guild tournament resolution
**Summary**: When 2+ attacker guilds contest a tile, run a single-elimination bracket between the attackers; the tile holder always fights last against the bracket winner.
**Deliverables**:
- **Tile holder seeding**: The current tile holder (if any) does not enter the attacker bracket. They receive a bye to the final and fight the attacker-bracket winner last.
- **Attacker-bracket seeding favors underdogs**: Seed attackers by total party level (sum of levels across deployed members). Pair weaker attackers against each other in early rounds so at least one underdog has a chance to advance; the highest-seeded attacker fights late.
  - Concretely: sort attackers by party level ascending; use standard bracket seeding (1v2 → 3v4 → …) OR "top seed vs. bottom seed" — pick one in the spike and document.
  - Odd-count brackets: give the lowest-level attacker(s) round-1 byes.
- **No prior holder case**: If the tile was uncontrolled, all contestants enter the attacker bracket; the bracket winner takes the tile with no final fight.
- Each round reuses the PvP combat resolution.
- Bracket + per-match log visible to all participating guilds.
- Winner becomes new owner; existing holder retains if they win the final.
**Dependencies**: Guild-vs-guild PvP combat mode, first-attacker rule.
**Notes**: Party-level sum is a simple proxy — may iterate later to account for gear, skill tiers, or past win-rate. Tiebreak rule when parties tie on total level: random. Tiebreak when an attacker's party is fully wiped mid-bracket — drop from tree; advance opponent.

### [guild] Daily reward distribution
**Summary**: Award the daily reward pool to the guild currently holding each defendable tile, after the combat tick resolves.
**Deliverables**:
- Reward computation from `TileRewardSpec`.
- Distribution policy — options: split evenly among deployed defenders; deposit into guild bank; mix. Make policy configurable per-tile.
- Mail / inbox delivery to recipients.
- Audit log entry.
- Tax / fee going to guild bank if individuals get paid directly (optional).
**Dependencies**: Daily tile combat tick, player mailbox (for mail delivery option) or guild bank.

### [guild] Tile control history & leaderboard
**Summary**: Surface who owned each tile over time and reward long holds.
**Deliverables**:
- Append-only ownership log per tile.
- UI: tile info modal shows current owner + last N handovers.
- Leaderboard: guilds ranked by total tile-days held, concurrent tiles, etc.
- Reset/archival cadence (seasonal?).
**Dependencies**: Tile ownership & occupation state.

### [guild] Defendable-tile visualization on map
**Summary**: Defendable tiles are visually distinct; owning guild's tag appears on the tile; contested tiles pulse.
**Deliverables**:
- Render hook in `WorldMapScene` for defendable tile state.
- Owner-guild tag / banner color.
- Pulse or highlight when contested.
- Room-info modal shows owner, deployed defenders (public), pending attackers, next tick time.
**Dependencies**: Tile ownership & occupation state.

---

## Social & Communication

### [social] Room arrival toast
**Summary**: When a player enters your room, show a subtle toast with their class/level.
**Deliverables**: Toast component; mute-by-default for own entries; setting to disable.

### [social] Emote system
**Summary**: Zero-commitment "hi" — emotes play a tiny animation over the sprite and broadcast to room chat.
**Deliverables**: Emote catalog; emote wheel UI; server broadcast; client animation.

### [social] "Form a party?" suggestion banner
**Summary**: When N players are in a room and not partied, banner suggests forming.
**Deliverables**: Banner component; class-icon preview; one-click party create + invites.

### [social] Shared-class-diversity buff
**Summary**: Temporary buff when a room has X different classes together — rewards recruiting strangers.
**Dependencies**: World events framework.
**Deliverables**: Buff logic; tuning; UI badge.

### [social] LFG / queue for dungeons
**Summary**: Auto-group players looking for the same dungeon with compatible classes.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Queue server; matchmaking logic; UI.

### [social] Chat reactions
**Summary**: Emoji reactions on chat messages.
**Deliverables**: Reaction data model; UI; rate limit.

### [social] @mentions
**Summary**: `@username` pings the mentioned user.
**Deliverables**: Parser; notification; highlight in receiver's chat.

### [social] Chat slash commands
**Summary**: `/roll`, `/me`, `/who`, etc.
**Deliverables**: Command registry; dispatch; help text.

### [social] Threaded replies on chat messages
**Summary**: Reply to a specific message, show a small thread.
**Deliverables**: Message parent-id; UI for replies; notification to original poster.

### [social] Victory poses
**Summary**: After a win, combat sprites briefly do a pose animation.
**Deliverables**: Pose assets; Phaser renderer hook; optional mute setting.

### [social] Mentor badge
**Summary**: Flag high-level players willing to help newbies. Mentor+new-player party gets bonus XP.
**Deliverables**: Mentor opt-in setting; bonus hook in combat engine; badge on Users tab.

### [social] Nearby players tab
**Summary**: List players on adjacent tiles for easy discovery.
**Deliverables**: New sub-tab or Users filter; real-time updates.

### [social] Recently partied list
**Summary**: Remember people you played with; re-invite quickly.
**Deliverables**: Persisted list (capped); UI in Party tab or popup.

### [social] "People you might like" suggestions
**Summary**: Surface players with similar play patterns.
**Dependencies**: Analytics event pipeline.
**Deliverables**: Matching heuristic (zones overlap, times active, class compat); opt-out setting.

### [social] Player report button
**Summary**: Report a player for cheating/harassment/etc.
**Deliverables**: Report UI in popup; reason picker; admin queue; disposition flow.

---

## Notifications & PWA

All notification channels are **opt-in** and **granular** — users pick which categories they want on which channels. PWA is the chosen mobile path (not a native app).

### [notify] Notification framework core
**Summary**: Central system for emitting notifications from game events, routing to enabled channels, and persisting a per-user inbox.
**Deliverables**:
- `NotificationEvent` type catalog: `{ id, category, severity, title, body, payload, timestamp, readAt? }`.
- Category registry (initial set: `party`, `guild_combat`, `dm`, `friend`, `trade`, `world_event`, `quest`, `system`).
- Per-user preference store: for each category, which channels are enabled (`in_app`, `browser_push`, `email`).
- Server-side dispatcher: `NotificationService.notify(username, event)` → fans out to enabled channels.
- Persisted inbox (capped at N entries per user) in `PlayerSaveData`.
- Opt-in defaults: only `in_app` is on by default; push and email require explicit enable.
**Notes**: All downstream notification issues build on this. Keep channel drivers pluggable (add SMS/Discord later without refactoring).

### [notify] Preference UI (granular opt-in)
**Summary**: Settings page where users toggle each notification category per channel, with a master kill-switch per channel.
**Dependencies**: Notification framework core.
**Deliverables**:
- Grid layout: rows = categories, columns = channels, checkboxes at intersections.
- Per-channel master toggle + "Enable all / Disable all" shortcuts.
- Email / push channels show a setup flow (verify email / grant permission) if enabled without prior setup.
- Preferences persisted server-side so they sync across devices.
- Reasonable defaults that err on the side of quiet.

### [notify] In-app notification center
**Summary**: Bell icon with unread badge; dropdown or panel showing recent notifications; mark-as-read and deep links to the relevant screen.
**Dependencies**: Notification framework core.
**Deliverables**:
- Bell icon in the global header (visible on every screen).
- Unread count badge.
- Notification list with title, body, timestamp, click-to-navigate.
- Mark read / mark all read.
- Infinite scroll or pagination.
- Live update over WS when new events arrive.

### [notify] PWA scaffolding
**Summary**: Make the web client installable as a PWA (manifest, service worker, icons, offline splash). Foundation for mobile push.
**Deliverables**:
- `manifest.webmanifest` with app name, icons, theme colors, start URL.
- Service worker with offline-friendly caching of the app shell (not game state — that stays live).
- iOS/Android install prompts handled gracefully.
- Admin build pipeline includes PWA artifacts.
- Dev mode correctly disables SW to avoid stale dev builds.
**Notes**: Install prompt behavior differs on iOS vs. Android vs. desktop — document the quirks.

### [notify] Browser push via Service Worker
**Summary**: Deliver push notifications to users who've installed the PWA or enabled notifications in their browser.
**Dependencies**: PWA scaffolding, notification framework core.
**Deliverables**:
- Web Push subscription flow (request permission, register with VAPID keys).
- Server stores per-user push subscriptions.
- `browser_push` channel driver that sends via standard Web Push Protocol.
- Handles unsubscribe cleanup (410 Gone responses).
- Icons + click-to-focus so tapping a notification opens the relevant screen.
**Notes**: iOS Safari supports Web Push only for installed PWAs (iOS 16.4+). Document the iOS install path prominently.

### [notify] Email notification channel
**Summary**: Deliver notifications via email for users who opt in. Reuses the existing AWS SES setup from magic-link auth.
**Dependencies**: Notification framework core.
**Deliverables**:
- `email` channel driver using SES.
- Email templates per category (HTML + plaintext).
- One-click unsubscribe links (per-category + global).
- Throttling to avoid email floods (see digest issue).
- Bounce + complaint handling (mark email invalid, disable channel).
- Compliance with CAN-SPAM / GDPR basics: clear sender, unsubscribe, no dark patterns.

### [notify] Digest / bundling
**Summary**: Instead of one email per event, bundle multiple notifications into a daily or hourly digest (per-user preference).
**Dependencies**: Email notification channel.
**Deliverables**:
- Digest cadence options per channel: instant, hourly, daily.
- Queue & flush worker.
- Digest template aggregating all pending events into one message.
- Smart grouping (5 party invites → "5 new party invites" not 5 separate lines).
**Notes**: Important for email hygiene — spammy per-event emails will get users marking us as spam.

### [notify] Quiet hours / do-not-disturb
**Summary**: Users can specify time ranges where push/email are suppressed (still captured in the in-app inbox).
**Dependencies**: Notification framework core.
**Deliverables**:
- Quiet-hours schedule in preferences (per weekday, or a simple start/end time).
- Timezone awareness.
- Dispatcher respects quiet hours per channel.
- Optional "urgent bypass" flag on certain events (guild combat results? probably not — let the user decide).

### [notify] Rate limiting & deduplication
**Summary**: Prevent notification spam — e.g., 20 DMs in a minute shouldn't yield 20 push notifications.
**Dependencies**: Notification framework core.
**Deliverables**:
- Per-user, per-category rate limits on outbound push/email.
- Deduplication window — identical events within N seconds coalesce.
- Overflow behavior: either drop with counter ("and 12 more") or fall back to digest.

### [notify] Party notifications
**Summary**: Notify on party events — invite received, you were kicked, promoted, demoted, ownership transferred, member joined/left.
**Dependencies**: Notification framework core.
**Deliverables**:
- Emit `party:*` events from `PartySystem` / `PlayerManager`.
- Per-event opt-in defaults (invite = on; member-joined = off by default).
- Category: `party`.

### [notify] DM notifications
**Summary**: Notify when a user receives a direct message while they're offline or not looking at chat.
**Dependencies**: Notification framework core.
**Deliverables**:
- Emit from `ChatSystem` on DM receipt.
- Suppress if the recipient is currently focused on the Chat tab for that conversation (and has focus) — avoid self-noise.
- Category: `dm`.

### [notify] Friend-request notifications
**Summary**: Notify on incoming friend requests and when an outgoing request is accepted.
**Dependencies**: Notification framework core.
**Deliverables**:
- Emit from `FriendsSystem`.
- Category: `friend`.

### [notify] Trade notifications
**Summary**: Notify when a trade is proposed, countered, confirmed, or cancelled involving you.
**Dependencies**: Notification framework core, existing trade system.
**Deliverables**:
- Emit from `TradeSystem`.
- Category: `trade`.
**Notes**: Cancellations from movement are noisy — consider excluding those from push by default.

### [notify] Guild combat notifications
**Summary**: Notify guild members when tile combat is declared, resolved, won, or lost; include bracket outcomes.
**Dependencies**: Notification framework core, daily tile combat tick.
**Deliverables**:
- Events: `guild_combat:attack_declared`, `:bracket_seeded`, `:match_result`, `:tile_won`, `:tile_lost`.
- Per-event opt-in granularity (some users want per-match, most just want final results).
- Category: `guild_combat`.

### [notify] Guild event notifications
**Summary**: Notify on non-combat guild events — invite received, promoted, demoted, guild achievement unlocked, scheduled raid reminder.
**Dependencies**: Notification framework core.
**Deliverables**:
- Emit from `GuildSystem` + any future event/raid scheduler.
- Category: `guild` (distinct from `guild_combat`).

### [notify] World event notifications
**Summary**: Push global announcements — world events starting, timed bosses spawning, server maintenance.
**Dependencies**: Notification framework core, world events framework.
**Deliverables**:
- Admin-authored broadcast notifications.
- Respect per-user opt-in (category `world_event`).
- Rate limit sharply — no more than X per day by default.

### [notify] Quest notifications
**Summary**: Notify on quest progress milestones and daily/weekly resets.
**Dependencies**: Notification framework core, quest system MVP.
**Deliverables**:
- Events: quest completed, chain advanced, daily reset.
- Category: `quest`.
**Notes**: Off by default — quest notifications are easy to over-send.

### [notify] Admin broadcast tool
**Summary**: Admin UI to send a one-off notification to all or filtered users (maintenance window, apology, event announcement).
**Dependencies**: Notification framework core.
**Deliverables**:
- Admin page with audience filter (all, guild, zone, level range).
- Channel picker (respecting user opt-ins unless flagged as critical).
- Preview + confirmation.
- Audit log.

---

## Admin & Content Tooling

### [admin] Bulk tile paint & fill
**Summary**: Paint multiple tiles at once; rectangular fill; flood fill by zone.
**Deliverables**: Multi-select tool; fill tools; bulk-save flow.

### [admin] Copy/paste tile regions
**Summary**: Select a hex region, paste elsewhere.
**Deliverables**: Region select; clipboard; paste with type/zone preserved.

### [admin] Undo/redo in world editor
**Summary**: History stack on the admin editor.
**Deliverables**: Local history; keyboard shortcuts; conflict warning on concurrent edits.

### [admin] Layered map view
**Summary**: Toggle layers for zones, encounters, shops, tile types.
**Deliverables**: Layer toggles; rendering variants per layer.

### [admin] Version diff preview
**Summary**: Before publishing, show which tiles/items/monsters changed.
**Deliverables**: Diff computation between draft and live; UI.

### [admin] Version rollback
**Summary**: Roll back to any previous version.
**Deliverables**: Rollback action on version list; confirmation; post-rollback redeploy.

### [admin] Scheduled deploys
**Summary**: Queue a content deploy for a specific time.
**Deliverables**: Schedule store; cron worker; admin UI.

### [admin] Battle simulator
**Summary**: Drop party + encounter into admin UI, step through ticks.
**Deliverables**: Sim harness reusing `CombatEngine`; admin UI to configure party and encounter; play/step/pause; log viewer.

### [admin] Balance preview tool
**Summary**: "If I set X stat to Y, here's how 100 sim runs go."
**Dependencies**: Battle simulator.
**Deliverables**: Batch sim runner; win-rate / avg-damage reporting.

### [admin] Content sanity linter
**Summary**: Flags orphan data (tiles without zones, items without cost, monsters without drops, dangling refs).
**Deliverables**: Linter pass; results panel; one-click fixes where possible.

### [admin] Skill tree editor
**Summary**: GUI for authoring skill trees.
**Deliverables**: Skill tree visualization; edit UI; validation; persistence.

### [admin] Item editor quality-of-life
**Summary**: Stat roll preview; drop-rate simulator.
**Deliverables**: Preview widgets on item form; sim panel.

### [admin] Encounter designer UI
**Summary**: Build encounters with mixed monster groups and placements.
**Dependencies**: Encounter redesign (see `ideas/encounters.md`).
**Deliverables**: Per `ideas/encounters.md`.

### [admin] Shop bulk import
**Summary**: Paste JSON to populate shop inventory.
**Deliverables**: Import UI; validation; diff preview.

### [admin] Player inspector
**Summary**: Full read-only view of a player's state + export.
**Deliverables**: Inspector modal; export JSON.

### [admin] Impersonate (read-only)
**Summary**: View what a player sees, for support.
**Deliverables**: Read-only session fork; audit log of impersonations.

### [admin] Mass-mail / gift tool
**Summary**: Send item/gold to all or filtered players.
**Dependencies**: Player mailbox.
**Deliverables**: Filter UI; confirmation; batch job; audit log.

### [admin] Gift codes
**Summary**: Generate redeemable codes.
**Deliverables**: Code store; redeem endpoint; admin UI for creating/listing.

### [admin] Staging server / env
**Summary**: Test content changes on a staging deploy before live.
**Deliverables**: Env config; deploy pipeline fork; promote-to-live action.
**Notes**: Infra-flavored; spike first.

---

## Analytics & Balancing

### [analytics] Event pipeline MVP
**Summary**: Append-only structured event log covering core player actions.
**Deliverables**:
- NDJSON append store in `data/events/`.
- Emit events from `PlayerManager`, `PartyBattleManager`, combat, social, inventory.
- Rolling rotation + retention policy.
- Replay tool.
**Notes**: Foundation for most analytics issues below.

### [analytics] Class distribution dashboard
**Summary**: Admin dashboard: players per class, levels per class.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Query + chart on admin dashboard.

### [analytics] Class XP rate dashboard
**Summary**: XP/hour per class — reveals over/underperformers.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Aggregation; chart with historical comparison.

### [analytics] Skill usage frequency dashboard
**Summary**: Which skills are equipped vs. ignored.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Equip/unequip tracking; popularity chart; ignored-skills list.

### [analytics] Death / wipe rate dashboard
**Summary**: By zone, encounter, class composition.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Wipe event; aggregation; hot-spot map overlay.

### [analytics] Loot distribution dashboard
**Summary**: Drops, equipped, vendored, ignored per item.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Item lifecycle tracking; chart.

### [analytics] Economy health dashboard
**Summary**: Gold inflow/outflow, player gold distribution, price trends.
**Dependencies**: Event pipeline MVP, auction house (for prices).
**Deliverables**: Aggregations; charts.

### [analytics] Retention cohort dashboard
**Summary**: D1, D7, D30 retention by class, starting zone, etc.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Cohort table; filters.

### [analytics] Active hours heatmap
**Summary**: When are players online?
**Dependencies**: Event pipeline MVP.
**Deliverables**: Login/logout tracking; heatmap chart.

### [analytics] Party composition stats
**Summary**: Solo vs partied; avg party size; popular class combos.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Aggregations; chart.

### [analytics] New-player funnel
**Summary**: Login → class-select → first battle → first level → first party. Where do they drop?
**Dependencies**: Event pipeline MVP.
**Deliverables**: Funnel chart; per-step drop rate; segmentable by date.

### [analytics] Live metrics dashboard
**Summary**: Real-time online count, active battles, tile occupancy.
**Deliverables**: In-memory counters; admin UI auto-refresh; no DB dependency.

---

## Anti-Cheat & Integrity

### [anticheat] Global WS rate-limit pass
**Summary**: Every WS message handler has a rate limit.
**Deliverables**: Central limiter; per-message-type budgets; 429-like reply for exceeded limits.

### [anticheat] Input-validation audit
**Summary**: Every WS + REST handler validates its payload and rejects malformed input, logging offenders.
**Deliverables**: Central validator (zod-like); audit pass across all handlers; tests.

### [anticheat] Device-token overlap detection
**Summary**: Surface accounts sharing a device token more loudly (boost/farming heuristic).
**Deliverables**: Enhanced admin alert; watch-list; allowlist (families share devices — false positive mitigation).

### [anticheat] Trade-abuse heuristics
**Summary**: Detect chain trades funneling wealth to mains.
**Dependencies**: Event pipeline MVP.
**Deliverables**: Trade graph; rules engine flagging suspicious patterns; admin review queue.

### [anticheat] Chat rate limit + spam filter
**Summary**: Rate-limit outbound chat; basic pattern filter for spam.
**Deliverables**: Token bucket per user; spam pattern library; offense tracker.

### [anticheat] Report queue & disposition workflow
**Summary**: Admin queue for player reports with dispositions and audit.
**Dependencies**: Player report button.
**Deliverables**: Queue UI; disposition actions (ignore/warn/suspend/ban); history per player.

### [anticheat] WebSocket session rotation
**Summary**: Rotate session secret periodically; re-auth on rotation.
**Deliverables**: Rotation schedule; graceful reconnect; test.

### [anticheat] Trade confirm nonce
**Summary**: Nonce to prevent replay on trade confirm.
**Deliverables**: Per-trade nonce; server validation.

### [anticheat] Transparent ban changelog
**Summary**: Public pseudonymous log of bans/suspensions.
**Deliverables**: Admin toggle for public log; opt-in disclosure; sanitized view.

---

## AI-Assisted Content (MCP)

### [mcp] MCP server scaffold (`idle-party-mcp`)
**Summary**: Initial MCP server exposing read-only content tools to Claude.
**Deliverables**:
- MCP server project skeleton.
- Tools: `list_monsters`, `list_items`, `list_zones`, `list_tiles`, `list_dungeons`.
- Auth via admin API token.
- README for running.

### [mcp] MCP write tools (draft only)
**Summary**: Add `create_*`, `update_*`, `delete_*` tools that write to drafts, not live.
**Dependencies**: MCP server scaffold, version system.
**Deliverables**: Draft-scoped write tools; clear separation of draft/live; admin approval required to publish.

### [mcp] MCP simulate_battle tool
**Summary**: Call the battle simulator via MCP.
**Dependencies**: Battle simulator, MCP server scaffold.
**Deliverables**: Tool that takes a party + encounter and returns combat log + outcome.

### [mcp] MCP balance_stats tool
**Summary**: Expose current balance metrics via MCP.
**Dependencies**: Analytics event pipeline, MCP server scaffold.
**Deliverables**: Aggregation tool; rate limit.

### [mcp] MCP propose_version tool
**Summary**: Create a draft version with a changelog note.
**Dependencies**: Version system, MCP write tools.
**Deliverables**: Draft-creating tool + approval flow.

### [mcp] Community content sandbox (far future)
**Summary**: Let trusted users author content in a sandbox world.
**Dependencies**: MCP write tools, staging env.
**Deliverables**: Sandbox env; user-facing flow; upvote + promote to live.

---

## Quality of Life

### [qol] Damage numbers in combat
**Summary**: Floating damage numbers above combatants (toggleable).
**Deliverables**: Render hook; toggle in settings.

### [qol] Combat log filters
**Summary**: Filter by damage, heal, skill, loot.
**Deliverables**: Filter UI; persist selection.

### [qol] Combat log auto-scroll pin
**Summary**: Lock to bottom unless user scrolls up.
**Deliverables**: Scroll detection; pin indicator.

### [qol] Skill timeline UI
**Summary**: Show upcoming active-skill triggers on the combat bar.
**Deliverables**: Cooldown tracker UI element; per-player skill previews.

### [qol] Minimap
**Summary**: Minimap with party marker and waypoints.
**Deliverables**: Minimap component; camera sync; toggle.

### [qol] Map path preview
**Summary**: Hover a tile to see the hex path and ETA.
**Deliverables**: Preview render in WorldMapScene; pathfinder integration.

### [qol] Tile hover tooltips
**Summary**: Hover to see room name, zone, encounters.
**Deliverables**: Tooltip component; show on hover; hide on move.

### [qol] Map search
**Summary**: "Find room: Blacksmith" → camera pans.
**Deliverables**: Search input; tile index; pan animation.

### [qol] Gear loadouts
**Summary**: Save skill + equipment sets, swap between them.
**Deliverables**: Loadout data model; per-player storage; UI.

### [qol] Item comparison tooltip
**Summary**: Hover a new item, see diff vs. currently equipped.
**Deliverables**: Tooltip diff computation; show green/red deltas.

### [qol] Auto-equip upgrades (opt-in)
**Summary**: Auto-equip items with clearly better stats when the slot isn't locked.
**Deliverables**: "Better item" heuristic; opt-in setting; log entry on auto-equip.

### [qol] Bulk sell
**Summary**: Select multiple items at a shop and sell in one click.
**Deliverables**: Multi-select UI in ShopPopup; confirm dialog.

### [qol] Drag to equip/sell
**Summary**: Drag-and-drop in Items screen.
**Deliverables**: DnD handlers; fallback for mobile.

### [qol] Browser title flash
**Summary**: Flash tab title on new message / invite while in background.
**Deliverables**: Title flasher; cancel on focus.

### [qol] Unified toast system
**Summary**: Consolidate ad-hoc toasts into a single component.
**Deliverables**: Toast API; migrate existing call sites.

### [qol] Colorblind modes
**Summary**: Alternate palettes for class/rarity colors.
**Deliverables**: Theme switcher; audit contrast.

### [qol] Font size scale setting
**Summary**: Larger text option.
**Deliverables**: CSS scale variable; settings UI.

### [qol] Reduced motion setting
**Summary**: Disable screen shake / flashes.
**Deliverables**: Setting; guard all animations behind it.

### [qol] Screen reader labels audit
**Summary**: Ensure interactive elements have accessible labels.
**Deliverables**: Audit pass; add aria labels; test with screen reader.

### [qol] i18n scaffold
**Summary**: Extract strings to a table for community translation.
**Deliverables**: i18n library integration; first-pass extraction; locale switcher.

### [qol] Per-tick broadcast perf audit
**Summary**: Profile state-message fan-out under load.
**Deliverables**: Benchmarks; batching or diffing improvements.

---

## Long Shots / Big Bets

### [bigbet] Native mobile app
**Summary**: Wrap the web client (or go native) for app-store presence.
**Notes**: Explicitly out of scope near-term — PWA (see Notifications & PWA) is the mobile path of choice. Revisit only if store presence or device features (background audio, advanced push) demand it.

### [bigbet] PvP arenas
**Summary**: Party-vs-party arenas, tournaments, seasonal ladders.
**Dependencies**: Combat engine fairness audit, anti-cheat hardening.
**Notes**: Huge design effort; do separate design doc before committing.

### [bigbet] Player housing / guild halls
**Summary**: Customize a personal or guild tile; invite friends to visit.
**Dependencies**: Multi-map support.

### [bigbet] Lore / cinematic system
**Summary**: Scripted cutscenes triggered by quests/boss kills.

### [bigbet] Client mod / theme system
**Summary**: User-contributed cosmetic themes & UI layouts (non-gameplay).
**Notes**: Needs strict sandboxing.

### [bigbet] Cosmetic money sinks (dyes, pet skins)
**Summary**: Absorb gold inflation via non-power cosmetics.

### [bigbet] Seasonal ladders / resets
**Summary**: Quarterly seasonal resets with cosmetic rewards for top finishers.

### [bigbet] Cross-shard portal play
**Summary**: Multiple instanced worlds that can cross-visit via portals.

---

## Meta

### [meta] Monthly backlog grooming
**Summary**: Review this doc monthly — promote actionable items to GitHub issues, retire stale ones.
**Deliverables**: Recurring calendar reminder; process notes.

### [meta] Link implemented items back to PRs
**Summary**: When an item ships, strike through and link the PR/design doc.
**Deliverables**: Convention captured in the file header.

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
**Feedback**:
- Low priority for now, interesting idea we can keep in the backlog.

### [engine] Timed boss spawns
**Summary**: Named bosses that spawn in specific rooms at specific times (daily/weekly cadence).
**Deliverables**:
- `BossSchedule` entries tied to a tile.
- Server spawns a boss encounter at the scheduled time, replaces the normal encounter table temporarily.
- Announcement in global chat N minutes before spawn.
**Dependencies**: Encounter redesign (see `ideas/encounters.md`).
**Feedback**:
- Doesn't quite work with the current boss model. I like the idea, but not sure how to make it "fair" if we have 5 parties sitting at a boss for two days waiting for loot. Worth keeping in consideration as we strive to improve.

### [engine] Monster targeting-priority overrides
**Summary**: Let `MonsterDefinition` declare non-default targeting rules ("lowest HP," "healer class," "back row").
**Deliverables**:
- Extend `MonsterDefinition` with optional `targetingPriority` enum.
- Update `findTarget()` in `CombatEngine.ts` to honor it.
- Admin form checkbox/dropdown.
- Tests for each priority mode.
**Feedback**:
- Skills should be required for priority targeting, not the player/monster defintion. This is a no-go.

### [engine] Multi-action & scripted monsters
**Summary**: Monsters that act more than once per tick, or have scripted abilities (phase changes, enrage, summons).
**Deliverables**:
- Support `actionsPerTick` on `MonsterDefinition`.
- Ability hook system: `onHpThreshold`, `onTick`, `onAllyDeath` — configurable abilities per monster.
- Extend CombatEngine to run these hooks.
- Admin editor for ability scripts.
**Feedback**:
- These can all fall under skills. There will need to be engine requirements to "phase change" or "summon" though. Enrage or multiple actions sound like existing skills. We should probably work on a larger skill framework/pool to pull from when building monsters though.

### [engine] Monster status effects
**Summary**: Monsters can apply the same DoT/HoT/stun/shield effects the skill system already supports.
**Deliverables**:
- `MonsterAbility` type that emits a `PassiveEffect`- or `ActiveEffect`-shaped effect on hit.
- Thread through `applyDamageToPlayer` to register effects on targets.
**Feedback**:
- Again, just skills. Maybe we need more skills, and passives even for monsters. This would help players strive to target specific monsters creatively if they had a powerful passive.

### [engine] Henchmen (hireable NPCs)
**Summary**: NPCs a solo player can hire to fill party slots. Weaker than players to still incentivize real parties.
**Deliverables**:
- `Henchman` type (class, level, hire cost, fixed equipment).
- Town NPC UI to browse/hire.
- Henchman fills a party grid slot, acts in combat, takes a share of loot (or not — decide).
- Dismiss / replace flow.
**Feedback**:
- Yes. This is still a need. Don't even worry about equipment, just have them have some fixed hp/damage/skills. MVP doesn't require a cost to hire. But the henchmen should be lower than the lowest party member. You'd have to kick the henchmen to invite someone lower level and go find another henchman from another town if you felt you still needed that gap to fill. They should be a "last resort" feature. Not allowed in dungeons. Just used on occassion ideally.

### [engine] Pet slot
**Summary**: A single pet that adds passive bonuses and an occasional attack, without occupying a grid position.
**Deliverables**:
- `Pet` definition (name, level, passive bonus, attack stats).
- Pet slot on character.
- Pet acts once every N ticks in combat.
- Pet stable / collection UI.
**Feedback**:
- Right now if we had 5 party members, 9 slots, each party member having a pet, that wouldn't work very well. If we do go with pets, I would expect it to be a skill thing for specific classes. This is a low priority item. I think I might even expect pets to fall into a "class specialization" (future feature) like Druid (Archer specializaiton) or Necromancer (Priest specialization).

### [engine] Quest system MVP
**Summary**: Simple kill/collect/visit quests from NPCs, with XP/gold/item rewards.
**Deliverables**:
- `QuestDefinition` + `data/quests.json`.
- NPC tiles (or an NPC component of a tile) that offer quests.
- Quest log UI (active, completed).
- Progress tracking in `PlayerSaveData`.
- Admin editor.
**Feedback**:
- Yes, high priority.

### [engine] Quest chains
**Summary**: Sequential quests that unlock new zones/items.
**Dependencies**: Quest system MVP.
**Deliverables**: Prerequisite field on quests, chain visualization in quest log.
**Feedback**:
- I like the idea of quest chains that unlock new quests. Some quests probably require levels as well. However, I don't think quests should unlock zones. I like the idea of power leveling as an option if the players are strong enough to carry around a low level player. Item requirements for areas are already a thing and dungeons may have level requirements. Zones probably don't need them.

### [engine] Daily/weekly repeatable quests
**Summary**: Give idle players a login goal.
**Dependencies**: Quest system MVP.
**Deliverables**: Repeat cadence on quests, reset cron job, UI indicator.
**Feedback**:
- I don't know if daily quests are a great idea for a game that is strictly focused on "not needing to play" (idle). Weeklies for sure though.

### [engine] Faction reputation system
**Summary**: Reputation scores tied to zones/NPCs. Unlock quests, vendors, titles.
**Deliverables**:
- `FactionDefinition` + per-player rep map.
- Rep deltas on quest completion and monster kills.
- Opposing factions (helping A hurts B).
- Faction page on the Character screen.
**Feedback**:
- Low priority. This one feels like something that can come as the game expands.

### [engine] Death penalty system
**Summary**: Soft penalty on party wipe to make loss meaningful without being anti-idle.
**Deliverables**: Decide mechanic (XP shave, durability, gold drop). Implement + tune. UI feedback in combat log.
**Notes**: Explicit design decision; should default to opt-in or very mild for idle-friendliness.
**Feedback**:
- A no-go for the time being. I've considered this but all of the above mentioned could be very penalizing to players if they are afk. They come back and have lost a ton of xp or gold or because durability loss, they weren't able to ever get any more wins while afk. Losing battles continuously should discourage a player enough from trying an area. Or maybe they're trying to kill a boss and just "rolling the dice" many, many times hoping they'll get the RNG to win. I'm ok with that.

### [engine] Class combo system
**Summary**: Certain skills from different classes chained within N ticks trigger a bonus — rewards class diversity.
**Deliverables**:
- Combo definition language (skill A followed by skill B from different player).
- Combo tracker in combat state.
- UI indicator when a combo fires.
**Feedback**:
- Already implemented with skills. Not really "combos" but there are complimentary skills that benefit other classes (or similar classes).

### [engine] Status resistance stats on gear
**Summary**: Add resistance stats (poison, stun, silence) to gear affixes.
**Dependencies**: Existing equipment system.
**Deliverables**: New stat fields on `ItemDefinition`, hooked into effect-application code.
**Feedback**:
- This does feel like something we should implement. Not only gear, but sets as well. There will probably be a long list of buffs, resistances, special effects that gear (and sets) will be able to benefit from.

### [engine] Expanded damage types
**Summary**: Add `nature`, `cold`, `fire`, `dark` to `DamageType`.
**Deliverables**:
- Extend enum + targeted `computeEquipmentBonuses`.
- Resistance stats per type.
- Elemental weakness matrix per monster.
- Admin UI for new types.
- Tests.
**Feedback**:
- Yes, but lower priority for now. Long term, maybe. Magical damage would have to be split and we'd have to really consider how to handle overall magic resistance vs specific magical resistance. It would just complicate balancing for the naer-term.

---

## Dungeons

### [dungeon] Dungeon data model + ContentStore integration
**Summary**: Scaffolding for dungeons: definitions, storage, admin CRUD.
**Deliverables**:
- `DungeonDefinition` type with floors, grid shape, entry requirements, rewards.
- `data/dungeons.json` via ContentStore.
- Admin list/create/edit/delete screen (no game behavior yet).
**Notes**: First step — downstream dungeon issues depend on this.
**Feedback**:
- Yes for sure.

### [dungeon] Dungeon instance runtime
**Summary**: Parties can enter a dungeon and get a private instance with floor progression.
**Dependencies**: Dungeon data model.
**Deliverables**:
- Instance manager — one active instance per party.
- Floor progression on victory.
- Exit / bail-out flow.
- Instance cleanup on party disband or timeout.
**Feedback**:
- This might be a little complicated... Almost like there needs to be a staging area for groups. As mentioned before, I'd like to allow different party sizes for dungeons, which leaves people without a party after the dungeon. I guess this could be okay. If players want to run a dungeon, that probably won't be afk the whole time, and they can manually party up with whoever after the dungeon.

### [dungeon] Entry requirements enforcement
**Summary**: Block dungeon entry based on level, required item, required classes, party size.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Entry validation with clear error messages; tests.
**Feedback**:
- I like the required item. Maybe even a consumable item. That leaves the possibility of a limited entry granted by performing quests or something. A little more interesting than just a level. All of these requirements are nice.

### [dungeon] Non-3x3 grid shapes
**Summary**: Support arbitrary grid rectangles (2x3, 5x5, 4x2) for dungeons.
**Deliverables**:
- Generalize `PartyGridPosition` from fixed 0-8 to (col, row) on an arbitrary rectangle.
- Update targeting algorithms.
- Client combat rendering handles variable grids.
- Tests.
**Feedback**:
- This sounds interesting. Lower proirity than the above dungeon tasks though.

### [dungeon] Party size above 5 (raid mode)
**Summary**: Raid dungeons with party cap of 10–20.
**Dependencies**: Non-3x3 grid shapes.
**Deliverables**:
- Remove hard-coded party cap for dungeon instances.
- UI for larger party rosters and grids.
- Loot distribution decisions for large parties.
**Feedback**:
- This should be arbitrary sizes. Some many even be smaller than 5. So I would consider this part of the Entry requirements. You can strike this task specifically.

### [dungeon] Dungeon time limits
**Summary**: Optional timer per dungeon; party kicked or loot forfeited on expiry.
**Deliverables**:
- `timeLimitSec` on `DungeonDefinition`.
- Countdown UI.
- Server-side timeout handling.
**Feedback**:
- I think I recommended this one. Not liking it yet, so very low priority if we even get to it.

### [dungeon] Dungeon lockouts / cooldowns
**Summary**: Daily/weekly lockout per dungeon to protect loot economy.
**Deliverables**:
- Per-player lockout state in `PlayerSaveData`.
- Reset cron.
- UI showing next available time.
**Feedback**:
- I think we may be able to handle this via the other requirements. I'd say hold off on this unless we see that it becomes a need.

### [dungeon] Dungeon boss rooms
**Summary**: Last floor is a unique boss encounter with special mechanics.
**Dependencies**: Dungeon instance runtime, scripted monsters.
**Deliverables**: `isBoss` flag on floor, optional unique drop table, victory fanfare.
**Feedback**:
- Lower priority for now. I think we can handle this with the existing encounters and monsters arrangements. Well, maybe dungeon encounters will need special grid sizes to handle arranging monsters differently. But that's about it. Monsters drop the loot. Victory fanfare does sound nice, but more so for the dungeon, not the boss.

### [dungeon] Dungeon-specific loot tables
**Summary**: Unique items + first-clear rewards per dungeon.
**Deliverables**: Reward tables on dungeon floors, one-time first-clear flag per player, UI indicating unclaimed.
**Feedback**:
- I kind of like this. Mid-priority.

### [dungeon] Dungeon tokens + rotating vendor
**Summary**: Earn tokens from dungeon clears, spend at a vendor on rotating cosmetic/utility items.
**Deliverables**: New currency, earn/spend mechanics, weekly rotation config.
**Feedback**:
- This could lead to a very non-idle mechanic. I'm going to say low priority, or needs refinement maybe. If there are dozens of dungeons in the game eventually and players have to farm every dungeon, every week or so, then it becomes very grindy. The opposite of what this game was designed to go against.

### [dungeon] Dungeon leaderboards
**Summary**: Track fastest clear, most damage, least damage taken per dungeon.
**Deliverables**: Leaderboard store, admin-configurable metrics, UI.
**Feedback**:
- Yeah sure. This is a nice to have.

### [dungeon] Roguelike dungeon variant
**Summary**: Procedural floors with between-floor buff choices.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Procedural floor generator, buff draft UI, loot only on completion.
**Feedback**:
- This could be a very fun part of the game. Maybe there's a special dungeon or dungeon type that handles this. Low priority for the time being.

### [dungeon] Solo trial dungeons
**Summary**: Single-player dungeons tuned per class to test mastery.
**Deliverables**: Tuning per class, class-locked entry requirement, class-specific rewards.
**Feedback**:
- Yes. But I don't think this actually needs to be a task. We have party size limits mentioned earlier. We also mentioned dungeon rewards earlier as well.

### [dungeon] Class trial dungeons
**Summary**: "5 of the same class only" dungeons with class-exclusive rewards.
**Deliverables**: Entry requirement: all members same class. Reward gated to that class.
**Feedback**:
- Again, this is handled by restrictions mentioned in another task.

---

## World & Maps

### [world] Multi-map / interior map support
**Summary**: A room can transition to a different hex map (castle interior, floor 2, etc.).
**Deliverables**:
- `transitionsTo: { mapId, tileId }` on `WorldTileDefinition`.
- Multiple `HexGrid` instances, one per map, with consistent WorldCache on the client.
- Party movement across maps (snap to new position on transition).
- Admin UI for creating and linking maps.
**Feedback**:
- Mid-priority.

### [world] Continents / top-level maps
**Summary**: Multiple top-level maps linked by ports, portals, or airships.
**Dependencies**: Multi-map support.
**Deliverables**: Map-select UI, per-map fog of war, shared global unlock tracking.
**Feedback**:
- I like the ability to zoom "way out" and see the whole world. We could have "map fog" as another layer over "zone fog" and "tile fog". Essentially once we zoom out far enough, it just becomes an overworld map view instead of a navigation map view.

### [world] Weather/biome per-room effects
**Summary**: Tiles can declare temporary buffs/debuffs (rain slows casters, night boosts undead).
**Deliverables**: Tile-level modifier list, hook into combat engine, admin UI.
**Feedback**:
- Low priority. Sounds interesting, but balancing challenges come with this.

### [world] Town portal scrolls
**Summary**: Consumable that sends party (or self) to a bound town.
**Dependencies**: Consumables framework.
**Deliverables**: Scroll item + "bind to town" action + teleport handler.
**Feedback**:
- Yes please.

### [world] Teleport runes (craftable, one-use)
**Summary**: Crafted consumable teleports bearer to a specific room picked at craft time.
**Dependencies**: Crafting system, town portal scrolls.
**Deliverables**: Rune item with `destinationTileId` field set on craft; UI for picking destination.
**Feedback**:
- Low priority. Let's stick with scrolls for the time being.

### [world] Waypoints / bindstones
**Summary**: Discover waypoints on the map, fast-travel between them for gold.
**Deliverables**:
- Waypoint tile type.
- Per-player discovered-waypoint list.
- Fast-travel UI with gold cost.
**Feedback**:
- Waypoints don't sound bad for fast travel between towns, for instance.

### [world] Summon scrolls
**Summary**: Consumable — one player summons a party member from another tile.
**Dependencies**: Consumables framework.
**Deliverables**: Consumable type + target-selection UI + consent prompt on target.
**Feedback**:
- I don't like this for some reason... Maybe this leaves room for "player skills" on certain classes such as a mage being able to summon guild mates or friend or something. But... I don't know what we would add to other classes for the time being, so let's low priority this one.

### [world] Recall home (long cooldown)
**Summary**: Free, long-cooldown teleport back to the starting town. Guards against stuck parties.
**Deliverables**: Cooldown tracker on player state, UI button.
**Feedback**:
- I don't think this is terrible. I don't even think it really needs a long cooldown. If we have a waypoint system then we could just let a player "bind" to a waypoint and they could teleport their party back to that waypoint at any time. I think it has a low chance of being abused.

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
**Feedback**:
- Yes, this sounds good. I'm confused on the save/restore of queue state comment. This should run in the background just like combat I would think, maybe even following the same ticks that combat do. This could be something that is unlocked at level 20 or so.

### [craft] Crafting skill leveling
**Summary**: Separate skill level per player; crafting more yields better quality chance.
**Dependencies**: Crafting framework core.
**Deliverables**: Skill XP per craft type, leveling formula, unlocks gated on skill level.
**Feedback**:
- I do like this. I don't think there really has to be craft types to start though. As mentioned below, each class kind of only has one craft, for now.

### [craft] Knight heavy smithing
**Summary**: Class craft — iron/steel/plate/heavy weapons.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, material drops (ore), smithy room type/requirement.
**Feedback**:
- I like it.

### [craft] Mage alchemy (potions)
**Dependencies**: Crafting framework core, consumables framework.
**Deliverables**: Recipe set, herb/reagent materials, potion outputs.
**Feedback**:
- I like it.

### [craft] Priest enchanting
**Summary**: Priest applies enchantments to existing gear.
**Dependencies**: Crafting framework core.
**Deliverables**: Enchant recipes that modify an item's stats (limited slots per item).
**Feedback**:
- I like it.

### [craft] Archer light crafting
**Summary**: Leather, wood, bows, light armor.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, hide/wood materials, workshop flow.
**Feedback**:
- I like it.

### [craft] Bard jewelry
**Summary**: Rings, amulets, instruments — feeds the socket/gem system.
**Dependencies**: Crafting framework core.
**Deliverables**: Recipe set, gem/metal materials.
**Feedback**:
- I like it.

### [craft] Material drops & harvest nodes
**Summary**: Raw materials drop from monsters + harvestable from room types (mines, forests, sea).
**Deliverables**: Extend drop tables, add harvest nodes as tile features, UI for harvest actions.
**Feedback**:
- We already have materials in the game that drop from monsters. The harvestable rooms are interesting, but low priority for now. We can handle this by just having certain monsters drop wood/ore/etc for the short-term.

### [craft] Recipe unlock via drops/quests
**Summary**: Recipe discovery mechanics.
**Dependencies**: Crafting framework core, quest system (for quest route).
**Deliverables**: Recipe drop table entries; quest reward recipes; unlock state on player.
**Feedback**:
- This sounds good.

### [craft] Output quality tiers
**Summary**: Roll quality (normal/fine/masterwork) on crafted items.
**Dependencies**: Crafting framework core.
**Deliverables**: Quality roll + stat modifiers + visual indicator on item.
**Feedback**:
- I like this... This idea makes me think of a much more dynamic loot system in the game, similar to Diablo type loot... "Fine shining staff of the bear" with modifiers all the way around. Probably don't want an exact ripoff of that, but something to consider if it's not mentioned down further.

### [craft] Craft station room requirements
**Summary**: Some recipes require being at a specific room (forge, alchemy lab).
**Deliverables**: Optional station requirement on recipes; check on queue start; UI call-out.
**Notes**: Open question — should queued jobs require being at the station the whole time, or just at job start?
**Feedback**:
- This may punish "crafters" from gaining xp with their friends. Low priority for now, but it may come into play.

### [craft] Inter-class recipe dependencies
**Summary**: Recipes that require an item from another class's craft (Archer bowstring → Mage enchanted bow). Encourages trading.
**Deliverables**: Reagent field on recipes referencing arbitrary items; balance pass.
**Feedback**:
- Yes, absolutely. I don't know that this needs to be its own class, but we'll see. This does bring up intermediate components, which are not mentioned above. This could be handled as simply as having a player craft material into material into material into a weapon, for example.

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
**Feedback**:
- Lowish priority at the moment. Will be a requirement for crafting as mages wouldn't be able to craft consuable without it.

### [consumable] Auto-use toggles
**Summary**: Per-consumable opt-in auto-use with trigger conditions.
**Dependencies**: Consumables framework.
**Deliverables**:
- Triggers: HP threshold, combat start, idle, debuff present, custom.
- Per-item auto-use setting persisted on item instance or inventory slot.
- UI toggle in the Items screen.
**Feedback**:
- This feels like a requirement when we build out the consumables framework.

### [consumable] Rare-consumable guard
**Summary**: Prevent rare consumables from auto-consuming.
**Dependencies**: Consumables framework.
**Deliverables**: Rarity-based default (rare+ never auto). Explicit admin override per item.
**Feedback**:
- Not necessary. A player should always opt-in to auto-consuming, so this can be dropped.

### [consumable] Heal / mana / stamina potions
**Summary**: Baseline potion set.
**Dependencies**: Consumables framework.
**Deliverables**: Potion items, auto-use rules, tuning.
**Feedback**:
- Heals make sense. There's no mana or stamina, so not important for those two. Let's mark this as a low priority and focus on buffing potions that have a duration for now.

### [consumable] Cure / antidote potions
**Summary**: Cleanse debuffs.
**Dependencies**: Consumables framework, status effect system.
**Deliverables**: Cleanse effect, auto-use trigger "when debuffed."
**Feedback**:
- This sounds good. Could be handy for killing bosses with dots, stuns etc.

### [consumable] Stat-buff elixirs
**Summary**: Temp +damage / +DR / +MR / +crit elixirs.
**Dependencies**: Consumables framework.
**Deliverables**: Buff effects, UI, tuning.
**Feedback**:
- Yeah, these make sense.

### [consumable] XP / gold-find / drop-rate boosters
**Summary**: Time-based progression boosters.
**Dependencies**: Consumables framework.
**Deliverables**: Buff implementations hooked into XP/gold/drop pipeline.
**Feedback**:
- Interesting, let's say yes.

### [consumable] Reset scrolls
**Summary**: Reset a skill cooldown or remove a DoT.
**Dependencies**: Consumables framework.
**Deliverables**: Effect type, target picker UI.
**Feedback**:
- I kind of like the idea of this being a way for players to be "active" in dungeons or when fighting bosses. While the game is typically idle, this is a framework that could work for active play. Mid-priority.

---

## Items, Economy & Progression

### [item] Socket & gem system
**Summary**: Sockets on gear accept gems for extra stats.
**Dependencies**: Bard jewelry craft.
**Deliverables**: `sockets` field on items; gem items; socketing UI; stat integration.
**Feedback**:
- Almost a dependency for the bard crafting. I think these need to go together.

### [item] Gear upgrade (+1 … +10)
**Summary**: Upgrade gear using crafting currency.
**Dependencies**: Crafting framework, currency pass.
**Deliverables**: Upgrade recipe/action; fail/success rolls; visible +N on item name.
**Feedback**:
- I'm going to say no on this for now. Simple damage, MR, DR, etc. is probably going to go away in favor of other class specific bonuses soon.

### [item] Reforging (reroll stats)
**Summary**: Re-roll stats on an item for a cost.
**Deliverables**: Reforge NPC/station; cost formula; UI.
**Feedback**:
- I'm okay with this. We just need to understand "item roll stats" first.

### [item] Salvage gear for materials
**Summary**: Break down gear into crafting materials.
**Dependencies**: Crafting framework.
**Deliverables**: Salvage action; material drop table per item type/rarity.
**Feedback**:
- Not sure why I didn't think of this before. This makes sense. We'd just need to make sure that items are salvagable (have a defined loot table) before letting the player salvage them.

### [item] Auction house
**Summary**: Async player-to-player market.
**Deliverables**: Listing/bidding data model; UI with search/filter; expiration + refund; fee.
**Notes**: Large scope — consider splitting into MVP (buy-now only) vs. full (bidding).
**Feedback**:
- I like this. Honestly, even if we only have buy-now forever, that's probably fine.

### [item] Player mailbox
**Summary**: Send items/gold to a specific player offline.
**Deliverables**: Mailbox store; send/receive UI; expiration/return policy.
**Feedback**:
- This is probably an upgrade to the trade system. The existing trade system in the game doesn't work well as it requires both players to be online and in the same room. Maybe this is a refactor of that.

### [item] Personal stash
**Summary**: Expandable paid stash.
**Deliverables**: Stash store per player; buy-slot UI; rent/cap decisions.
**Feedback**:
- Low priority, but nice if we have a limited inventory in the future.

### [item] Partial set bonuses (2-piece / 4-piece)
**Summary**: Expand set bonuses beyond all-or-nothing.
**Dependencies**: Existing set system.
**Deliverables**: Threshold-based bonuses; UI tooltip showing which tier is active.
**Feedback**:
- This is understandable. Low priority.

### [item] Set visual cosmetics
**Summary**: Particle/outline effect on combat sprite when set is equipped.
**Deliverables**: Cosmetic data field; Phaser renderer hook.
**Feedback**:
- We need a lot of graphics enhancements before this becomes beneficial.

### [item] Vendor buy-low / sell-high anchoring
**Summary**: Vendors buy at fraction of value, sell at multiplier, as an economy anchor.
**Deliverables**: Configurable multipliers on shops; tuning pass.
**Feedback**:
- Yeah, this makes sense. Low priority.

---

## Guilds

### [guild] Guild ranks & permissions
**Summary**: Configurable ranks (Leader, Officer, Member, Recruit) with per-rank perms.
**Deliverables**:
- Rank structure on `Guild`.
- Permission flags (invite, kick, promote, MOTD, bank).
- UI for rank editing.
- Permission checks in guild routes.
**Feedback**:
- I suppose this makes sense.

### [guild] Guild MOTD & description
**Summary**: MOTD on login; long-form description on guild page.
**Deliverables**: Fields on `Guild`; edit UI for leaders; display on Guild tab.
**Feedback**:
- This feels low priority to me. Depends on demand.

### [guild] Guild tags
**Summary**: Short tag (`[IPR]`) shown next to member names everywhere.
**Deliverables**: Tag field; render across Users tab, chat, combat, popup.
**Feedback**:
- Yes this is nice.

### [guild] Guild leveling & XP
**Summary**: Guild earns XP from member activity; levels unlock perks.
**Deliverables**: Guild XP events (kills, dungeon clears), level curve, level display.
**Feedback**:
- Sounds difficult to balance. Let's leave this as low priority. There are other guild benefits that may be listed below.

### [guild] Guild perk tree
**Summary**: Perks unlocked as guild levels up (+party XP, +loot quality, extra bank tab).
**Dependencies**: Guild leveling.
**Deliverables**: Perk definitions, purchase/unlock UI, effects hooked into the relevant systems.
**Feedback**:
- Low priority. Need to be careful on this one.

### [guild] Guild achievements
**Summary**: "Kill 10k goblins," "Clear every dungeon."
**Dependencies**: Analytics event pipeline.
**Deliverables**: Achievement definitions, progress tracker, reveal UI.
**Feedback**:
- Sounds interesting. Could lead to unlocks of some sort in the future.

### [guild] Guild bank
**Summary**: Shared stash with per-rank limits, deposit/withdraw log.
**Dependencies**: Guild ranks & permissions.
**Deliverables**: Bank store; UI; rate/limit enforcement; audit log.
**Feedback**:
- Yeah, will be nice.

### [guild] Guild raid / event calendar
**Summary**: Schedule dungeon runs visible to guild.
**Deliverables**: Event data model; RSVP UI; reminder notifications.
**Feedback**:
- Low priority for now.

### [guild] Guild vs. guild leaderboards
**Summary**: Weekly rankings by XP, dungeons, etc.
**Dependencies**: Analytics event pipeline.
**Deliverables**: Leaderboard store; reset cron; UI.
**Feedback**:
- This sounds interesting, low priority.

### [guild] Guild hall / guild tile
**Summary**: Unique room only guild members can enter.
**Dependencies**: Multi-map support (or per-guild private tile).
**Deliverables**: Hall tile type; guild-gated entry; customization UI.
**Feedback**:
- Low priority. Having a guild hall sounds cool, but with the "always in combat" idea of the game, what are we fighting in the guild hall? Does combat disable? Need to consider a few things...

### [guild] Alliances
**Summary**: Two guilds can ally to share a chat channel (and maybe a hall).
**Deliverables**: Alliance data model; alliance chat channel; invite/accept flow.
**Feedback**:
- Not for now. Very low priority.

### [guild] Guild finder
**Summary**: Browse public guilds, filter by size/activity/focus.
**Deliverables**: Search API; browse UI; filters.
**Feedback**:
- This could be nice as the game scales. Low priority for now.

### [guild] Apply-to-join flow
**Summary**: In addition to invites, players apply, officers accept/decline.
**Deliverables**: Application data model; application queue UI for officers.
**Feedback**:
- Yes, this sounds good.

### [guild] Guild audit log
**Summary**: Log of joins/leaves/kicks/bank transactions.
**Deliverables**: Event log; filter UI.
**Feedback**:
- Sure, this sounds nice.

### [guild] Guild roster cap
**Summary**: Hard limit on guild size (target 30–50, likely configurable per guild tier or level).
**Deliverables**:
- `maxMembers` on `Guild` (default constant, overridable by perks).
- Enforcement on invite/accept.
- Clear UI messaging when full.
- Guild-finder filter showing "full" state.
**Notes**: Consider perk tree / guild level unlocks that raise the cap (e.g., +5 slots per tier).
**Feedback**:
- Yes, this is important.

### [guild] Defendable tile data model
**Summary**: Mark specific tiles as defendable and configure their daily reward pool.
**Deliverables**:
- `defendable?: boolean` and `dailyReward?: TileRewardSpec` on `WorldTileDefinition`.
- `TileRewardSpec` supports gold, item drops, currency, guild XP.
- ContentStore persistence + version snapshot.
- Admin UI toggle + reward editor on the tile form.
**Notes**: Rewards are per-tile so admins can tune contested hot-spots differently from frontier tiles.
**Feedback**:
- This one will be a nice incentive for guilds.

### [guild] Tile ownership & occupation state
**Summary**: Track which guild currently holds each defendable tile and who they've deployed there.
**Deliverables**:
- New store (`GuildTileStore`) tracking `{ tileId, ownerGuildId, defenders: PlayerDeployment[], since }`.
- Deployment = `{ username, gridPosition }` — who the guild has stationed on the tile.
- Load/save + version on content snapshot? (Probably not — runtime-only, like guild data.)
- Public API to read "who holds this tile" for the room-info modal.
**Dependencies**: Defendable tile data model.
**Feedback**:
- Yes, this is good.

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
**Feedback**:
- Sounds good. We will leave this as the default 5 player in a 3x3 layout. A guild may assign less than 5 players if they wish.

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
**Feedback**:
- This seems unnecessary. Whatever the assigned players are at the combat tick is what will engage in combat. It doesn't need to be defined at any length of time in advnace.

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
**Feedback**:
- There's no declarations. Just assignments. The instant combat sounds fine as long as we have a log.

### [guild] First-attacker rule (prior-holder bias)
**Summary**: If a tile was held before this cycle, the *attacker(s)* get first attack in combat. Fresh/uncontested claims default to the current turn order.
**Deliverables**:
- `CombatEngine` gains an optional `firstActor: 'players' | 'monsters' | 'party-a' | 'party-b'` parameter on `processPartyTick` / `createPartyCombatState`.
- Daily-tile-combat wiring: if `ownerGuildId` existed at the start of the tick, attacker acts first.
- Tests covering party-vs-party with each side acting first.
**Dependencies**: Daily tile combat tick.
**Notes**: This is the big combat-engine lift. Current engine assumes players-then-monsters order; generalizing to "party A then party B" has knock-on effects on grid-targeting code. Spike before committing.
**Feedback**:
- Yes, this will probably need to be redefined over time. There's a good chance that we overhaul the combat system in the future anyway.

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
**Feedback**:
- Low priority. This will be a nice to have.

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
**Feedback**:
- Also low priority, nice to have.

### [guild] Daily reward distribution
**Summary**: Award the daily reward pool to the guild currently holding each defendable tile, after the combat tick resolves.
**Deliverables**:
- Reward computation from `TileRewardSpec`.
- Distribution policy — options: split evenly among deployed defenders; deposit into guild bank; mix. Make policy configurable per-tile.
- Mail / inbox delivery to recipients.
- Audit log entry.
- Tax / fee going to guild bank if individuals get paid directly (optional).
**Dependencies**: Daily tile combat tick, player mailbox (for mail delivery option) or guild bank.
**Feedback**:
- This sounds good.

### [guild] Tile control history & leaderboard
**Summary**: Surface who owned each tile over time and reward long holds.
**Deliverables**:
- Append-only ownership log per tile.
- UI: tile info modal shows current owner + last N handovers.
- Leaderboard: guilds ranked by total tile-days held, concurrent tiles, etc.
- Reset/archival cadence (seasonal?).
**Dependencies**: Tile ownership & occupation state.
**Feedback**:
- This sounds good.

### [guild] Defendable-tile visualization on map
**Summary**: Defendable tiles are visually distinct; owning guild's tag appears on the tile; contested tiles pulse.
**Deliverables**:
- Render hook in `WorldMapScene` for defendable tile state.
- Owner-guild tag / banner color.
- Pulse or highlight when contested.
- Room-info modal shows owner, deployed defenders (public), pending attackers, next tick time.
**Dependencies**: Tile ownership & occupation state.
**Feedback**:
- I think the map UI needs an update before we do this.

---

## Social & Communication

### [social] Room arrival toast
**Summary**: When a player enters your room, show a subtle toast with their class/level.
**Deliverables**: Toast component; mute-by-default for own entries; setting to disable.
**Feedback**:
- Sounds good.

### [social] Emote system
**Summary**: Zero-commitment "hi" — emotes play a tiny animation over the sprite and broadcast to room chat.
**Deliverables**: Emote catalog; emote wheel UI; server broadcast; client animation.
**Feedback**:
- Interesting, needs more definition.

### [social] "Form a party?" suggestion banner
**Summary**: When N players are in a room and not partied, banner suggests forming.
**Deliverables**: Banner component; class-icon preview; one-click party create + invites.
**Feedback**:
- This could be nice. Maybe refine this to "Add me to your party, please!" where a player auto-joins if invited. The auto-join would be toggleable by the player, so even if someone picks them up and drops them off then they would still be in auto-join mode. They would not be able to be "picked from a party" though. Only in effect when they are not in a party.

### [social] Shared-class-diversity buff
**Summary**: Temporary buff when a room has X different classes together — rewards recruiting strangers.
**Dependencies**: World events framework.
**Deliverables**: Buff logic; tuning; UI badge.
**Feedback**:
- No. This would be a skills thing only. There may be skills that benefit other classes or even classes of the same type. There should be no specific incentive for a party to have one of each class type. There may be incentives to have multiple of the same type...

### [social] LFG / queue for dungeons
**Summary**: Auto-group players looking for the same dungeon with compatible classes.
**Dependencies**: Dungeon instance runtime.
**Deliverables**: Queue server; matchmaking logic; UI.
**Feedback**:
- Similar to the Looking for party idea above. However, I think all players should be present when joining a dungeon.

### [social] Chat reactions
**Summary**: Emoji reactions on chat messages.
**Deliverables**: Reaction data model; UI; rate limit.
**Feedback**:
- Yeah sure.

### [social] @mentions
**Summary**: `@username` pings the mentioned user.
**Deliverables**: Parser; notification; highlight in receiver's chat.
**Feedback**:
- This is a nice to have.

### [social] Chat slash commands
**Summary**: `/roll`, `/me`, `/who`, etc.
**Deliverables**: Command registry; dispatch; help text.
**Feedback**:
- I like the /roll at the very least.

### [social] Threaded replies on chat messages
**Summary**: Reply to a specific message, show a small thread.
**Deliverables**: Message parent-id; UI for replies; notification to original poster.
**Feedback**:
- I actually don't like this. I've seen this implemented in annoying ways in other chat apps.

### [social] Victory poses
**Summary**: After a win, combat sprites briefly do a pose animation.
**Deliverables**: Pose assets; Phaser renderer hook; optional mute setting.
**Feedback**:
- We are going to need combat sprites first!

### [social] Mentor badge
**Summary**: Flag high-level players willing to help newbies. Mentor+new-player party gets bonus XP.
**Deliverables**: Mentor opt-in setting; bonus hook in combat engine; badge on Users tab.
**Feedback**:
- This brings up a few different badge opportunities. Will consider more. Needs a better map UI. Could work in the Users UI though.

### [social] Nearby players tab
**Summary**: List players on adjacent tiles for easy discovery.
**Deliverables**: New sub-tab or Users filter; real-time updates.
**Feedback**:
- I don't know how urgent this is. The map already shows players within your zone. It might be nice to see guildmates further away than we do right now though.

### [social] Recently partied list
**Summary**: Remember people you played with; re-invite quickly.
**Deliverables**: Persisted list (capped); UI in Party tab or popup.
**Feedback**:
- Interesting, low priority.

### [social] "People you might like" suggestions
**Summary**: Surface players with similar play patterns.
**Dependencies**: Analytics event pipeline.
**Deliverables**: Matching heuristic (zones overlap, times active, class compat); opt-out setting.
**Feedback**:
- Nope. Sounds complicated and rarely beneficial.

### [social] Player report button
**Summary**: Report a player for cheating/harassment/etc.
**Deliverables**: Report UI in popup; reason picker; admin queue; disposition flow.
**Feedback**:
- I'm ok with this. Low priority for now though.

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
**Feedback**:
- Yes, this is nice.

### [notify] Preference UI (granular opt-in)
**Summary**: Settings page where users toggle each notification category per channel, with a master kill-switch per channel.
**Dependencies**: Notification framework core.
**Deliverables**:
- Grid layout: rows = categories, columns = channels, checkboxes at intersections.
- Per-channel master toggle + "Enable all / Disable all" shortcuts.
- Email / push channels show a setup flow (verify email / grant permission) if enabled without prior setup.
- Preferences persisted server-side so they sync across devices.
- Reasonable defaults that err on the side of quiet.
**Feedback**:
- Basically required before rolling out notifications.

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
**Feedback**:
- This sounds nice.

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

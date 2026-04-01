# Encounter System Redesign

## Overview

Replace the current alpha encounter system (single monster type per encounter, organized grid positions) with a full encounter designer that supports mixed monster groups, random and explicit placement, and a proper admin UI.

---

## Current State

- **EncounterTableEntry**: `{ monsterId, weight, minCount, maxCount }` — single monster type per entry
- **createEncounter()**: Picks one weighted entry, spawns N copies of that monster, positions them in a fixed pattern (`MONSTER_GRID_POSITIONS = [4, 1, 7, 3, 5, 0, 2, 6, 8]`)
- **Encounter tables** live on zones and optionally on individual room tiles
- **MonsterDefinition**: `{ id, name, level, hp, damage, damageType, xp, goldMin, goldMax, drops? }`
- **Admin UI**: Encounter editing is inline in the zone/tile sidebar — just add/remove single-monster entries with weight/min/max

---

## Part 1: Encounter Redesign

### New Encounter Data Model

An encounter is now a **named, standalone entity** stored in `data/encounters.json` via ContentStore.

```ts
interface EncounterDefinition {
  id: string;           // unique ID (e.g., "goblin_ambush")
  name: string;         // display name (e.g., "Goblin Ambush")
  type: 'random' | 'explicit';
  // Random encounters:
  monsterPool?: RandomMonsterEntry[];
  roomMax?: number;     // max total monsters (1-9), defaults to 9
  // Explicit encounters:
  placements?: ExplicitPlacement[];
}

interface RandomMonsterEntry {
  monsterId: string;
  min: number;          // minimum of this monster (>= 0)
  max: number;          // maximum of this monster (>= min)
}

interface ExplicitPlacement {
  monsterId: string;
  gridPosition: PartyGridPosition; // 0-8
}
```

**Random encounter resolution:**
1. For each `RandomMonsterEntry`, roll a count between `min` and `max`.
2. Collect all rolled monsters into a pool.
3. If pool size exceeds `roomMax`, randomly remove monsters until it fits (removing from the entries with the most rolled, to keep variety).
4. Shuffle the pool, then assign random grid positions (no duplicates).

**Explicit encounter resolution:**
1. Create one monster instance per placement at the specified grid position. No randomness.

### Encounter Tables (zones & rooms)

The encounter table format changes to reference encounter IDs with weights:

```ts
// New format
interface EncounterTableEntry {
  encounterId: string;  // references EncounterDefinition.id
  weight: number;
}

// Old format (removed)
// interface EncounterTableEntry {
//   monsterId: string;
//   weight: number;
//   minCount: number;
//   maxCount: number;
// }
```

Zones and rooms just pick a weighted encounter ID, then resolve it.

### Admin UI: Encounter Designer

**Full-screen modal** (replaces the current inline sidebar editing).

#### Layout

- **Header**: Encounter name (editable text field) + encounter type dropdown (`Random` / `Explicit`)
- **Body**: Depends on type
- **Footer**: Save / Cancel buttons

#### Random Mode

- **Monster entries list**: Each row has:
  - Monster dropdown (from monster definitions)
  - Min spinner (0-9)
  - Max spinner (min-9)
  - Remove button
- **Add Monster button** below the list
- **Room Max** spinner (1-9, default 9) — shown when total possible max > 9 or when multiple monster types are added
- **Preview**: A 3x3 grid showing a sample roll (re-rollable) so the admin can see what encounters might look like

#### Explicit Mode

- **3x3 grid** displayed visually
- Click a cell to open a monster picker dropdown
- Click an occupied cell to clear it or change the monster
- Each cell shows the monster name/icon when occupied

#### Where encounters appear

In the zone editor and tile editor, the encounter table becomes a list of:
- Encounter name (linked to the encounter definition)
- Weight spinner
- Remove button
- Add Encounter button (opens a picker of existing encounters)

This keeps the zone/tile UI simple — just encounter name + weight.

---

## Part 2: Monster Stat Updates

### Remove `level`

The `level` field on `MonsterDefinition` is cosmetic and unused in combat math. Remove it.

- Remove from `MonsterDefinition` interface
- Remove from `MonsterInstance` interface
- Remove from all seed data
- Remove from admin monster editor UI
- Remove from `createMonsterInstance()`

### Add Resistances

```ts
interface Resistance {
  damageType: DamageType;      // 'physical' | 'magical' | 'holy'
  flatReduction: number;       // flat damage reduced (applied first? or second? — see below)
  percentReduction: number;    // percentage reduced (-100 = double damage, 50 = half damage)
}

interface MonsterDefinition {
  // ... existing fields minus level ...
  resistances?: Resistance[];
}
```

**Resistance application order** (per incoming hit):
1. Apply `percentReduction` first: `damage = damage * (1 - percentReduction / 100)`
2. Apply `flatReduction` second: `damage = damage - flatReduction`
3. Floor at 0 (monsters can fully block damage)

Only the resistance matching the incoming `damageType` applies. Holy is its own type (not lumped with magical for monster resistance purposes — that simplification was only for player-side Priest Bless).

**Negative resistances** = vulnerability. A monster with `-100% magical` takes double magical damage. A monster with `-50 flat physical` takes 50 extra physical damage per hit.

**Admin UI**: In the monster editor, a "Resistances" section:
- List of resistance rows, each with:
  - Damage type dropdown (physical / magical / holy)
  - Flat reduction number input (can be negative)
  - Percent reduction number input (can be negative)
  - Remove button
- Add Resistance button
- Prevent duplicate damage types (one resistance entry per type max)

### Add Monster Skills

Monsters get a skill system similar to but simpler than player skills.

```ts
interface MonsterSkillDefinition {
  id: string;
  name: string;
  description: string;
  damageType?: DamageType;
  targeting: 'aoe_all' | 'lowest_hp_enemy' | 'lowest_hp_ally' | 'all_class';
  targetClasses?: string[];       // for 'all_class' targeting (e.g., ['archer', 'mage'])
  effect: 'damage' | 'stun' | 'dot' | 'heal';
  value: number;                  // damage amount, heal amount, or dot damage per tick
  dotDuration?: number;           // ticks for DoT effects
  cooldown: number;               // ticks between uses
}
```

**Initial monster skills:**

| ID | Name | Effect | Targeting | Value | CD | Notes |
|---|---|---|---|---|---|---|
| `fireball` | Fireball | damage (magical) | aoe_all | X | 3 | Hits all players |
| `fear` | Fear | stun | all_class (archer, mage) | 1 turn | 3 | Stuns all archers and mages |
| `rot` | Rot | dot (magical) | lowest_hp_enemy | X/tick | 2 | Stacking DoT on weakest player |
| `heal` | Heal | heal | lowest_hp_ally | X | 2 | Heals the monster with lowest HP |
| `assassinate` | Assassinate | damage (physical) | lowest_hp_enemy | X | 5 | Big hit on weakest player |

**Monster skill assignment:**

```ts
interface MonsterDefinition {
  // ... existing fields ...
  skills?: MonsterSkillEntry[];
}

interface MonsterSkillEntry {
  skillId: string;    // references MonsterSkillDefinition.id
  value: number;      // the X value for this monster's use of the skill
  cooldown: number;   // cooldown in ticks (per-monster, not from catalog)
}
```

The `value` is per-monster so the same skill (e.g., Fireball) can hit for 10 on a goblin shaman but 50 on a dragon.

**Combat integration:**
- Monsters check skill availability each turn (off cooldown?)
- If a skill is available, use it instead of basic attack
- Priority: use skills in the order they're listed in the monster's `skills` array (first off-cooldown skill wins)
- Track cooldowns per monster instance (add `skillCooldowns: Record<string, number>` to `MonsterInstance`)

**Admin UI**: In the monster editor, a "Skills" section:
- List of skill rows, each with:
  - Skill dropdown (from the predefined monster skill catalog)
  - Value number input
  - Remove button
- Add Skill button
- Show cooldown and targeting info as read-only labels next to each entry

---

## Part 3: Loot Table Update

### Sub-1% Drop Rates

The current `ItemDrop.chance` is already a float (e.g., `0.01` = 1%, `0.005` = 0.5%), so the data model already supports sub-1% drops. The change is purely in the **admin UI**:

- Display drop chance as a percentage with up to 3 decimal places (e.g., `0.1%`, `0.05%`, `0.001%`)
- Allow input of values like `0.001` (= 0.001%) which translates to `0.00001` in the data
- Consider showing expected drops per 1000 kills as a helper label (e.g., "~1 per 1000 kills")

---

## Migration

- Existing `EncounterTableEntry` data (zones, rooms) needs migration to the new format
- Auto-migrate: for each old entry `{ monsterId, weight, minCount, maxCount }`, create a `RandomEncounterDefinition` named after the monster (e.g., "Goblins") and update the encounter table to reference it
- `MonsterDefinition.level` removed — strip from existing data on load (ContentStore migration)
- New fields (`resistances`, `skills`) default to empty/undefined — no migration needed

---

## Implementation Order

1. **Data model changes** (shared types) — new encounter types, monster resistances, monster skills, updated encounter table format
2. **Monster stat updates** — remove level, add resistance application to CombatEngine, add monster skill execution to CombatEngine
3. **Encounter resolution** — new `createEncounter()` that handles random (multi-monster pool + random placement) and explicit encounters
4. **ContentStore updates** — load/save encounters.json, migration logic for old encounter tables
5. **Admin UI: Monster editor** — resistance editor, skill editor, loot table precision
6. **Admin UI: Encounter designer** — full-screen modal, random/explicit modes, 3x3 grid preview
7. **Admin UI: Zone/tile encounter tables** — simplified to encounter name + weight
8. **Tests** — encounter resolution, resistance math, monster skill execution, migration

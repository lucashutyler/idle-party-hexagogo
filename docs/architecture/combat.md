# Combat

This document covers the combat engine, class system, damage types, skill system, and the various combat invariants that govern how rules interact. For full skill catalog and design rationale see `ideas/skill-trees.md`.

## Class system

Five playable classes designed to be weak solo, strong together. `CharacterStats.ts` defines `ClassDefinition` with `baseHp`, `hpPerLevel`, `baseDamage`, `damagePerLevel`, and `damageType`. No abstract stats (STR/INT/etc.) — HP and damage scale linearly per class.

| Class  | HP                    | Damage         | Type     |
|--------|-----------------------|----------------|----------|
| Knight | 50 HP +5/lvl          | 1 dmg +1/lvl   | physical |
| Archer | 8 HP +1/lvl           | 15 dmg +2/lvl  | physical |
| Priest | 20 HP +2/lvl          | 3 dmg +1/lvl   | holy     |
| Mage   | 8 HP +1/lvl           | 15 dmg +2/lvl  | magical  |
| Bard   | 10 HP +1/lvl          | 1 dmg +1/lvl   | physical |

A player's character does not exist until they select a class — `PlayerSession.character` is `null` until class selection. Before choosing a class, the player has a WebSocket session but is invisible to the game (no party, no combat, no chat, no social presence). Old saves with invalid/legacy classes get `character = null`, forcing class re-selection.

Each class has a **skill tree** (`SkillTypes.ts`) with 11 skills (6 passives, 5 actives) unlocked sequentially. 5 equip slots: passive@Lv1, active@Lv5, passive@Lv10, passive@Lv30, passive@Lv50. Players choose 4/6 passives and 1/5 actives to equip. Skill points earned every 5 levels (`LEVELS_PER_SKILL_POINT = 5`); first passive is free. By level 50, all 11 skills are unlocked. Class selection screen shows baseHp, damage, damageType, and starting skill. Players cannot change their own class — only admins can change an existing player's class via `forceSetClass`.

## Class icons

`CLASS_ICONS` and `UNKNOWN_CLASS_ICON` are exported from `shared/CharacterStats.ts`. Used everywhere a username is displayed: combat sprites, social screens, tile info modal, character screen. Knight=🛡️, Archer=🏹, Priest=☥, Mage=🪄, Bard=🎵, Unknown=❓.

## Character & leveling

Each player has a `CharacterState` (className, level, xp, gold, inventory, equipment, skillLoadout, skillPoints). XP is earned on victory. XP to next level = `floor(18000 * L^1.2 * 1.06^L)`. Max HP = `baseHp + (level-1) * hpPerLevel` via `calculateMaxHp(level, className)`. Base damage = `baseDamage + (level-1) * damagePerLevel` via `calculateBaseDamage(level, className)`. Skill points granted every 5 levels (at levels 5, 10, 15...).

## XP rate calculator

Client-side trip counter on the Character tab. Tracks cumulative XP earned since last reset, divides by elapsed time to show XP/hr. Formatted with suffixes (k/m/b/t, `?` for >= 1 quadrillion). Reset button clears the counter. Handles level-ups by computing total cumulative XP across all levels.

## Combat engine

Pure functions in `CombatEngine.ts`. Party: `createPartyCombatState()`/`processPartyTick()` — turn-based, one combatant acts per tick.

Player damage = `baseDamage + variance(-2..+2) + equipBonus`, min 1, multiplied by Bard Rally if present, doubled on crit (Archer Pierce). Active skills trigger every Nth attack based on cooldown. Stun causes target to skip their next turn (doesn't stack, refreshes to 1).

At combat start: Mage Burn adds `2 * level` to baseDamage, Rally multiplier precomputed (`0.20 * partySize` per equipped Bard).

Monster damage reduced by equipment DR + Knight Guard (physical) or Priest Bless (magical/holy).

`findTarget()` implements grid-based targeting on the 3x3 grid (positions 0-8): row = floor(pos/3), col = pos%3. Same row first; players prefer low-column monsters (front), monsters prefer high-column players (front); if no same-row target, scan up then down.

**Starting passives**: Guard (physical DR), Rally (+20% all damage/member), Bless (magical DR party), Pierce (20% crit), Burn (+2 dmg/lvl).

**First actives**: Bash (stun CD2), Dissonance (AoE dmg CD3), Minor Heal (CD1), Cut Down (lowest HP CD3), Magic Missile (4×30% CD3).

Advanced mechanics include: DoTs (Bleed, Ignite), HoTs (Mending), damage shields (Sanctuary), stacking marks (Sunder +25% incoming/stack), conditional damage (Marksman, Brave, Exploit Weakness, War Cry), cooldown reduction (Bard **Tempo** = self only, Bard **Encore** = party-wide; controlled by `PassiveEffect.partyWide` flag in `getEffectiveCooldown`), party XP bonus (Inspiration), and many more.

## Damage types

`DamageType = 'physical' | 'magical' | 'holy'`. Monsters and player classes each have a damage type. Knight Guard passive reduces physical damage to the target only. Priest Bless passive reduces magical/holy damage party-wide. Equipment DR (`damageReductionMin/Max`) reduces physical damage only. Equipment MR (`magicReductionMin/Max`) reduces magical damage only. Holy damage is unaffected by both DR and MR — only the Priest Bless skill reduces it.

## Combat invariants

These are subtle rules that drive defensive interactions. Read carefully before touching the combat engine.

### No-op fallback for actives

When a player's queued active skill would do nothing (Priest Minor Heal at full party HP, Cure with no debuffs to remove, Sanctuary when target is already shielded, Bard Drumroll where RNG lands no stuns, etc.), `executeActiveSkill` returns `isNoOp: true` and `processPartyTick` falls through to a normal attack instead of wasting the turn. The `activeSkillCount` (Arcane Surge cadence) is rewound on no-op so it isn't burned.

### DoT resistance rule

All DoTs apply resistance at **tick time**, not at application time. The `damagePerTick` value stored on a `DotEffect` is the raw pre-resistance damage; the DoT processor in `processTickEffects` applies monster resistance (or player equip DR + Knight Guard / Priest Bless) every tick. This honors mid-fight resistance changes (debuffs, etc.) and keeps every DoT consistent — no DoT bakes resistance into its stored damage.

### Mage Ignite (permanent stacking DoT)

Unlike other DoTs, Ignite stacks last for the rest of combat. Each auto-attack adds a stack worth `25% of pre-MR damage` per tick (calculated from the `preMrDamage` captured at the top of `applyDamageToMonster`). Implemented via `DotEffect.permanent` (skip tick decrement). MR is still applied at tick time per the rule above — so against high-MR enemies, individual stacks tick for very little, but they accumulate over long fights.

### Monster skill direct damage

All direct-damage monster skills (Fireball AoE, Assassinate single-target, etc.) flow through `applyMonsterDirectDamage`, which honors the same defenses as a normal monster attack: damage-type reductions (equip DR + Knight Guard for physical, equip MR + Priest Bless for magical, Bless only for holy), damage shields, brace accumulation, Shield Bash retaliation, Martyr trigger, and resurrection. **Nimble dodge** applies to any direct-damage skill — for AoE, each player rolls dodge independently. **Intercept** redirects single-target skills the same way it redirects normal attacks. Stuns and DoT applications are not "direct damage" and bypass dodge.

### Shield Slam / Shield Bash physical-only rule

Knight Shield Slam (brace_reflect) only accumulates *physical* damage into `braceDamageTaken`; magical and holy hits don't contribute to the reflect. Knight Shield Bash (stun_on_phys_hit) only triggers from physical hits. This keeps Knight's reactive defenses paired with physical attackers and avoids reflecting magical fireballs as physical damage.

### Martyr trigger rule

Any damage to a Knight (direct attack, AoE skill, single-target skill, or DoT tick) queues a Priest Martyr heal-bonus stack via `triggerMartyr`. The bonus is **capped at a single stack between heals** — multiple damage events do not stack the bonus. Each Priest with Martyr equipped gets their own stack independently; the next heal that Priest casts consumes their stack.

## Server-side combat log

`PlayerSession` maintains the last 1000 log entries (battle start/end, damage, level-ups, movement, tile unlocks) with a running `battleCount`. Both are included in every `ServerStateMessage`. The client `CombatScreen` is a pure renderer of the server-provided log — no client-side state-transition tracking.

## Floating HP bars

`CombatScreen` renders HP bars floating above each combat sprite (players and enemies) arranged in grid formation rows (3 rows based on `gridPosition`). Player labels show username (current player highlighted in gold); monster labels show name only. HP shown as percentage bar only. Dead combatants are dimmed.

## Battle state machines

`ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). Each party's battle loop runs continuously and never stops: `battle` → `result` (`RESULT_PAUSE = 600ms` celebration/move window) → `battle` → … Movement happens instantly at the start of the result window; the client animates the tween during the celebration pause. Battle duration is determined by tick-based HP combat (1s per tick).

## Dungeon combat mode

A party inside a dungeon reuses this exact loop — the only differences are driven by `PartyBattleManager` reading the entry's `dungeonRun`: encounters come from the current floor's `encounterTable` (not the tile), victory advances the floor / completes the run rather than unlocking neighbours, and a wipe ejects the party to the entrance instead of retrying in place. Because the party has no destination inside a dungeon, the loop just re-triggers combat on the same floor until it's cleared. See `docs/architecture/content.md` → Dungeon system for the full lifecycle.

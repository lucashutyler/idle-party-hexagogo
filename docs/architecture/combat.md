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

Skills are **versioned content** (seeded from `SEED_SKILLS` in `SkillTypes.ts`, edited in the World Manager Skills tab, stored in `ContentStore` — see `content.md` → Skill system). Each skill belongs to a class tree, is passive or active, and is composed of one or more effect **options** from `SKILL_OPTION_CATALOG` (`SkillOptionCatalog.ts`) — the closed set of engine-supported effect kinds; any skill composable from existing kinds needs no code, new kinds still require engine work. Skills auto-unlock at their per-skill `unlockLevel` (seed: 6 passives + 5 actives per class at Lv 1/5/10…50); `unlockLevel: null` marks grant-only skills that come from items/sets. Equip slots come from a per-class **slot schedule** (content; seed: passive@Lv1, active@Lv5, passive@Lv10/30/50). Class selection screen shows baseHp, damage, damageType, and starting skill (the class's level-1 passive, if any). Players cannot change their own class — only admins can change an existing player's class via `forceSetClass`.

## Class icons

`CLASS_ICONS` (image paths under `/class-icons`), `UNKNOWN_CLASS_ICON` and `classIconHtml` are exported from `shared/src/systems/CharacterStats.ts`. Used everywhere a username is displayed: combat cards, social screens, room view, character screen. When the icon art is missing, `classIconHtml` swaps in the class's `CLASS_GLYPHS` emoji: Knight=🛡️, Archer=🏹, Priest=✨, Mage=🔮, Bard=🎵, Unknown=❔.

## Character & leveling

Each player has a `CharacterState` (className, level, xp, gold, inventory, equipment, skillLoadout). XP is earned on victory. XP to next level = `floor(18000 * L^1.2 * 1.06^L)`. Max HP = `baseHp + (level-1) * hpPerLevel` via `calculateMaxHp(level, className)`. Base damage = `baseDamage + (level-1) * damagePerLevel` via `calculateBaseDamage(level, className)`. Skills auto-unlock at each skill's content-defined `unlockLevel` (there are no skill points); `unlockedSkills` is derived state, recomputed from level + content on every level-up and restore.

## XP rate calculator

Client-side trip counter on the Character tab. Tracks cumulative XP earned since last reset, divides by elapsed time to show XP/hr. Formatted with suffixes (k/m/b/t, `?` for >= 1 quadrillion). Reset button clears the counter. Handles level-ups by computing total cumulative XP across all levels.

## Combat engine (real-time timeline)

Pure, deterministic functions in `shared/src/systems/CombatEngine.ts`, with helpers split into `shared/src/systems/combat/` (`CombatTargeting`, `CombatPassives`, `CombatNeeds`, `CombatSnapshot`). Every timing constant lives in `CombatTiming.ts`; events and client snapshot types live in `CombatEvents.ts`. Engine time is only `state.elapsedMs` — the engine never reads a wall clock.

Public API: `createPartyCombatState(PartyCombatantInit[], MonsterInstance[])`, `processCombatStep(state, dtMs?)` (dt clamped to `(0, COMBAT_STEP_MS]`), `advanceCombat(state, ms)` (runs `ceil(ms / 100)` steps, stops when finished), `buildClientCombatSnapshot(state, battleId, full)`, plus `findTarget`, `applyMonsterResistance`, `wouldHaveEffect`, `isInterruptFlashMode`, `effectiveCooldownMs`. Each step returns a `TickResult` (`logEntries`, `events`, `finished`, `result`).

**The rule: one old round ≡ one second.** Every combatant has its own action timer and acts once per `BASE_ACTION_INTERVAL_MS` (1 s) — everyone acts simultaneously on their own clock, not in turn order. Anything that used to be counted in turns (cooldowns, stuns, DoT ticks, debuff durations, Run availability) is now measured in seconds.

### State and timers

`createPartyCombatState` owns every per-battle field — `PartyCombatantInit` omits them, so session, henchman and test builders never set timers. Players sort front-to-back (col desc) then top-to-bottom; monsters sort front first (col asc) then row.

- **Action timers** — `actionRemainingMs` counts down; `actionTotalMs` is the current wait (for the client's action ring). Players' first action lands at `FIRST_ACTION_PLAYER_MS` (1000) + 100 ms × sorted index (index capped at 5); monsters' at `FIRST_ACTION_MONSTER_MS` (1400) + 100 ms × index (capped at 8), so the party strikes first. Monsters act every `attackInterval` seconds (content; default 1, clamped ≥ `MIN_MONSTER_ACTION_INTERVAL_MS` = 300 ms). Passive monsters (walls) get no action timer (still consume a stagger index).
- **Status pulses** — each unit has its own `pulseRemainingMs` (same first offset), firing every `STATUS_PULSE_MS` (1 s): DoT and HoT ticks happen on the owner's pulse. Pulses run while stunned; walls pulse too.
- **Durations** — debuffs/buffs carry `remainingMs` (`duration: N` → N × 1000, `-1` = permanent); `DotEffect`/`HotEffect.ticksRemaining` counts pulses.
- **Cooldowns** — `skillCooldowns` (ms remaining) and `skillCooldownTotals` (length of the current/last cooldown, warm-up included) per equipped active; monster `skillCooldowns` in ms, starting at 0.
- **Casts** — `CombatCast { skillId, skillName, totalMs, remainingMs, target?, counter? }` on players and monsters. Pending interrupt counters live on `state.pendingCounters` (the `cast.counter` field is only a mirror).

### Step order (`processCombatStep`, 100 ms)

1. Finished → empty result. `elapsedMs += dt`, `tickCount++`; the first step emits `battle_start`.
2. **Status pass** (players in turn order, then monsters): expire debuffs/buffs, tick pulses (DoT grouped by name with resistance applied at pulse time, Martyr on Knight, HoT). A DoT death emits `death` (players get an immediate Resurrection check). **End check.**
3. **Pending counters** whose `atMs ≤ elapsedMs` resolve. **End check.**
4. **Actor pass** — players (col desc, row asc), then monsters (col asc, row asc); dead and passive units skip. Per unit: stunned → only the stun timer counts down; else cooldowns tick (a cooldown started this step is not decremented this step), an in-progress cast progresses/resolves, then the action timer counts down and, if due and not casting, the unit **acts** and schedules its next action (`+= castMs > 0 ? max(interval, castMs) : interval`). **End check after every actor slot**, acting or not.
5. **Level triggers** (`ally_afflicted`, `ally_low_hp`) are evaluated once. **End check.**
6. **Stalemate**: the HP sum of all living monsters, walls included, is tracked, so chipping through a wall counts as progress; whenever it reaches a new low `lastProgressMs` is stamped. After `STALEMATE_WINDOW_MS` (30 s) without progress the fight ends in defeat with "The fight drags on — the party withdraws." Victory still ignores walls.

End check: all non-passive monsters dead → victory; else all players dead → defeat. Victory is tested first everywhere, so a mutual wipe is a victory. Finishing emits `battle_end {result}`.

### Actions

A player's action walks equipped skills in slot order and uses the first usable active that is off cooldown and passes the **needed check** (`wouldHaveEffect`); with none, it auto-attacks. Reaction skills are skipped (except interrupts in flash mode, below). A monster's action uses the first skill in its array that is off cooldown **and** would do something (heal: a wounded living non-passive monster, the caster included — lowest HP first, never a wall; fear: a living player of a target class; damage/dot: a living target), else auto-attacks — a monster skill with nothing to do does not burn its cooldown. A monster flagged by Chaos spends its next action hitting a random monster instead.

Player damage = `baseDamage + variance(-2..+2) + equipBonus` (min 1), then Intensify, Rally, War Song and set `damagePercent`, then conditional bonuses (Marksman/Brave/Exploit Weakness/War Cry), Focus stacks, Sunder marks and Scorch; crit (Archer Pierce) last. At combat start Mage Burn (`bonus_damage`) adds per-level damage and `max_hp_percent` scales max HP; the Rally multiplier (`0.20 × partySize` per equipped Bard) is precomputed. Monster damage is reduced by equipment DR + Knight Guard (physical) or equipment MR + Priest Bless (magical/holy). Unnerve, Lullaby and Crippling Shot reduce monster auto-attacks only; monster skill values are flat.

`findTarget()` implements grid-based targeting on the 3x3 grid (positions 0-8): row = floor(pos/3), col = pos%3. Same row first; players prefer low-column monsters (front), monsters prefer high-column players (front); if no same-row target, scan up then down. `stun_single` (Bash) prefers the first living monster that is mid-cast (so Bash interrupts spellcasters), else `findTarget`.

### Stuns

`STUN_MS` = 1 s, and a stun never stacks: `stunRemainingMs = max(current, STUN_MS)`. A stun freezes the victim's action timer, cooldowns and cast progress. A stun on a **casting monster interrupts** the cast (`interrupt` event, "X's Fireball is interrupted!"); a stun on a **casting player pauses** the cast, which resumes when the stun ends or is cured. Iron Will (`stun_immune`) resists at application time (`resist` event, "X's Iron Will resists the stun!") and never shows as stunned. "X is stunned!" is logged once when a monster stun lands. Walls can never be stunned: `stun_single` still hits a wall but skips the stun; `stun_aoe`, Lullaby and Chaos skip walls entirely.

## Skills as cards

Every skill has a **card type**, derived by `getSkillCardType(skill)` (`SkillTypes.ts`, first match wins) and described by `SKILL_CARD_TYPE_INFO` (label, icon, blurb):

| Card | Icon | Rule | Meaning |
|---|---|---|---|
| Triggered | ↯ | passive with any of stun_on_phys_hit, martyr, resurrection, dot_on_auto, overflow, scorch, stacking_same_target, arcane_surge | Passive that fires on an event |
| Passive | ◆ | any other passive | Always on |
| Interrupt | ✋ | trigger `enemy_cast` | Counters an enemy spell |
| Instant | ⚡ | any other trigger | Fires off-turn when its trigger happens |
| Support | ✚ | every active option ∈ heal_lowest, hot_lowest, cure_debuffs, shield_non_knight | Held until someone needs it |
| Enchantment | ✨ | any option ∈ party_buff_permanent, enemy_debuff_aoe, chaos | Lingering effect |
| Attack | ⚔️ | everything else | Uses your action when ready |

Active skills carry optional `cooldown` (seconds, default 1), `castTime` (seconds, 0–10, default 0), `warmup` (seconds, 0–60) and `trigger`. `getSkillTrigger(skill)` returns the explicit `trigger`, else **infers** one: any `redirect_hit` option → `ally_targeted`, any `brace_reflect` → `self_hit`. The inference is load-bearing — live servers hold Intercept/Shield Slam skills authored before `trigger` existed. `SKILL_TRIGGER_INFO` holds each trigger's label and description.

### Needed check: held vs fizzle

`wouldHaveEffect` (`shared/src/systems/combat/CombatNeeds.ts`) uses the same target helpers as the executor:

- heal_lowest / hot_lowest: some living ally below `LOW_HP_THRESHOLD` (50 %) or missing ≥ half of one heal/pulse → lowest-HP% such ally.
- cure_debuffs: some living ally stunned or carrying a DoT/debuff → stunned first, then lowest HP%.
- shield_non_knight: some living non-Knight ally with no shield.
- redirect_hit / brace_reflect: only inside their trigger.
- stun_aoe: a living non-wall monster; every other enemy-targeting kind: a living monster.

A skill whose options all fail is **held** — it stays ready with no cooldown and the next skill (or the auto-attack) is considered. A skill that passes but whose options all turn out to do nothing at execution (e.g. Drumroll rolling no stuns) **fizzles**: the cooldown stays spent, a `fizzle` event and "X's Y fizzles!" line go out, Arcane Surge's `activeSkillCount` is rewound, and an instant (castTime 0) action skill falls back to an auto-attack in the same action. A multi-option skill executes all its options in order and counts as a fizzle only when every option no-ops. Summing passives sum across all equipped options; first-match passives (martyr, scorch, resurrection, stun-on-hit, intensify, focus, healing-received) use the first matching option.

### Cooldowns, warm-up, CDR

`effectiveCooldownMs(owner, skill, allPlayers) = max(MIN_COOLDOWN_MS, cooldown × 1000 − CDR)` where CDR (seconds) is the owner's own `cooldown_reduction` options, other *living* members' party-wide ones (`PassiveEffect.partyWide`: Bard Tempo is self-only, Encore party-wide) and the set bonus `cooldownReduction`. `MIN_COOLDOWN_MS` = 1 s. **Interrupts (`enemy_cast`) ignore CDR.** The cooldown is computed whenever it (re)starts and starts *before* the skill resolves (at cast start for cast-time skills).

Warm-up (cooldown remaining at battle start): explicit `warmup` if set; otherwise action skills and interrupts start at `max(0, effectiveCooldown − 1 s)` and other reactions start ready. With the first action at 1.0 s, a 2 s action skill is therefore usable on its first action.

### Casts

Skills with `castTime > 0` (players) or an effective monster cast time (below) are telegraphed (cast lengths round up to whole 100 ms combat steps):

1. **Start** — the cooldown starts, `cast` is set, `cast_start {src, dst?, skill, skillId, durationMs}` is emitted and "X begins casting Y!" logged. Single-target kinds lock their target (`cast.target`); AoE kinds pick at resolution. The next action is pushed out by `max(interval, castMs)`.
2. **Progress** — `remainingMs` counts down on every non-stunned step; a unit never starts an action while casting.
3. **Resolve** — `cast` is cleared and `cast_end` emitted **before** the effects run, so a stun landing during resolution (Shield Bash on an Assassinate) is an ordinary stun, not an interrupt. Single-enemy kinds re-pick only if the locked target died; ally kinds always re-pick; nothing valid → `fizzle` (cooldown stays spent, no fallback auto-attack). A unit whose action is due in the same step acts after its cast resolves. A player cast's resolving `attack` event carries `skill` but no `skillId` (the client restarts cooldown sweeps from `skillId`).
4. **Stun** — interrupts a monster cast, pauses a player cast (see Stuns).
5. **Death** clears the cast silently. Cooldowns are never refunded.

### Reactions (instants)

A skill with a trigger never uses its owner's action timer. It may fire while its owner is casting, never while stunned or dead. One reaction per trigger event: the first eligible player in player order, first eligible skill in slot order, and only if `wouldHaveEffect` passes against the trigger context. The cooldown starts before effects resolve, so reactions raised while another reaction resolves run synchronously depth-first and always terminate.

| Trigger | Kind | Fires when |
|---|---|---|
| `ally_targeted` | event | a monster single-target attack (auto-attack or single-target damage skill, at resolution) targets a player other than the reactor — after targeting, before dodge/damage |
| `self_hit` | event | step 5 of the hit pipeline (the reactor took damage and survived) |
| `enemy_cast` | event | a monster starts a cast (interrupts, below) |
| `ally_afflicted` | level | end of every step: a living player is stunned or has a DoT/debuff (stunned first, then lowest HP%) |
| `ally_low_hp` | level | end of every step: a living player is below 50 % HP (lowest HP%) |

Reactions target from the trigger context: ally kinds take the trigger's ally, single-enemy kinds its enemy, falling back to the kind's normal rule when that slot is missing or dead.

- **Intercept (`redirect_hit`)** fires only for `ally_targeted`, only when the original target's max HP is lower than the reactor's, and never re-redirects. While a monster has a telegraphed damage cast locked on a *different* player, Intercept holds itself for that cast's resolution. The reactor becomes the target (`reaction` + `redirect {src: reactor, dst: original}` events); if an `ally_targeted` reaction killed or stunned the attacker, the attack is cancelled (a telegraphed cast that already resolved still lands).
- **Shield Slam (`brace_reflect`)** fires only for `self_hit` on a physical hit, dealing `max(1, floor(hit × reflectPercent))` direct damage to every living monster (doubled on Arcane Surge's even count; Intensify does not apply). Its `reaction` event uses the reactor itself as `dst`.
- **Cure** (`ally_afflicted`) and **Mending** (`ally_low_hp`) are the seed level-trigger instants.

### Interrupts (`enemy_cast`)

When a monster starts a cast, the first off-cooldown `enemy_cast` skill (player order, slot order; no needed check) **commits**: a `reaction {cardType: 'interrupt'}` is emitted and its cooldown starts. `INTERRUPT_DELAY_MS` (300 ms) later — or immediately if the cast would finish sooner — its effects hit the caster (stun options roll their normal chance, e.g. Drumroll's 25 % per enemy; a stun landing on the caster does not raise its own interrupt). Then, if the caster is alive and still casting that spell, the cast is **countered**: cancelled, exactly one `interrupt {src: reactor, dst: caster, cardType: 'interrupt'}` event (a stun's interrupt carries no `cardType`), and "X's Dispel counters Y's Fireball!" logged. The monster's skill stays on cooldown and its action timer is not refunded. A counter still applies its effects if another stun cancelled the cast first. A reactor that is dead or stunned when the delay elapses loses the counter: its cooldown stays spent and a `fizzle` is emitted. Casts started in the same step are handled in monster order, each committing its own interrupt.

**Flash mode** (`isInterruptFlashMode`): when no living non-passive monster has a known skill with a cast time that could do something this fight (fear needs a target-class player, heal and damage/dot always — a lone healer can heal itself), `enemy_cast` skills behave as ordinary action skills (needed check, fizzle fallback, snapshot `ready`/`held`). It is re-evaluated at each owner action and each cast; both modes share one cooldown.

### Seed skills

Seed actives (fresh worlds only; live content may differ): Knight Bash 2 s (attack; prefers a casting target), Intercept 2 s (instant, `ally_targeted`), Shield Slam 1 s (instant, `self_hit`, reflects 10 %), Sunder 3 s (`warmup: 1`), Dispel 5 s (interrupt); Archer Cut Down 3 s, Triple Shot 4 s, Snipe 5 s (cast 1 s), Bleed 3 s, Crippling Shot 3 s; Priest Minor Heal 1 s (support), Smite 2 s, Cure 3 s (instant, `ally_afflicted`), Mending 4 s (instant, `ally_low_hp`), Sanctuary 1 s (support); Mage Magic Missile 3 s, Zap 1 s, Blizzard 6 s (cast 1.5 s), Chain Lightning 1 s, Arcane Blast 5 s (cast 1 s); Bard Dissonance 3 s, Drumroll 4 s (interrupt), War Song 4 s (enchantment, `warmup: 0`), Lullaby 5 s, Chaos 6 s. Starting passives: Guard (physical DR), Rally (+20 % all damage/member), Bless (magical DR party), Pierce (20 % crit), Burn (+2 dmg/lvl). Tempo / Encore give −1 s cooldown (self / party).

Advanced mechanics include: DoTs (Bleed, Ignite), HoTs (Mending), damage shields (Sanctuary), stacking marks (Sunder +25 % incoming/stack), conditional damage (Marksman, Brave, Exploit Weakness, War Cry), cooldown reduction, party XP bonus (Inspiration), and many more.

## Monsters in combat

- `MonsterDefinition.attackInterval` (seconds, default 1, clamped ≥ 0.3). `createMonsterInstance` copies it and clones `skills`/`resistances` per instance.
- Monster skills come from the hardcoded `MONSTER_SKILL_CATALOG` (`MonsterSkills.ts`). Each entry's `cooldown` is seconds (0 = every action); cast time is `MonsterSkillEntry.castTime` if set, else the catalog default — fireball 1.5 s, fear 1 s, heal 1 s, assassinate 1 s (target locked and telegraphed), rot 0 (`getMonsterSkillCastTimeMs`). Unknown skill ids are skipped.
- Cast-time monster skills follow the cast lifecycle above and raise `enemy_cast`.
- Walls (`passive: true`) never act or cast, still take DoT pulses, are never flagged by Chaos, never healed by monster Heal, and don't count toward victory.
- Seed casters: `goblin_shaman` (Fireball + Heal) in the Darkwood and Crystal Caves goblin pools, `bandit_cutthroat` (Assassinate) in the Darkwood bandit pool. Seed wolves attack every 0.8 s, bandits every 1.25 s. See `content.md` → Monster system.

## Damage types

`DamageType = 'physical' | 'magical' | 'holy'`. Monsters and player classes each have a damage type. Knight Guard passive reduces physical damage to the target only. Priest Bless passive reduces magical/holy damage party-wide. Equipment DR (`damageReductionMin/Max`) reduces physical damage only. Equipment MR (`magicReductionMin/Max`) reduces magical damage only. Holy damage is unaffected by both DR and MR — only the Priest Bless skill reduces it.

## Combat invariants

These are subtle rules that drive defensive interactions. Read carefully before touching the combat engine.

### Held, not wasted

An action skill that would do nothing is **held** (no cooldown, next skill or auto-attack instead) — Minor Heal at full party HP, Cure with nothing to cure, Sanctuary with everyone shielded. Only a skill that passed the needed check but no-op'd at execution (RNG, e.g. Drumroll landing no stuns) fizzles; an instant fizzle falls through to an auto-attack in the same action and rewinds Arcane Surge's `activeSkillCount`. A cast-time fizzle has no fallback.

### DoT resistance rule

All DoTs apply resistance at **pulse time**, not at application time. The `damagePerTick` value stored on a `DotEffect` is the raw pre-resistance damage; the status pulse (`pulseMonster` / `pulsePlayer`) applies monster resistance (or the player's set resistance, equip DR + Knight Guard / Priest Bless) every pulse. This honors mid-fight resistance changes and keeps every DoT consistent — no DoT bakes resistance into its stored damage.

### Mage Ignite (permanent stacking DoT)

Unlike other DoTs, Ignite stacks last for the rest of combat. Each single-target hit adds a stack worth `25% of pre-MR damage` per pulse (captured at the top of `applyDamageToMonster`). Implemented via `DotEffect.permanent` (never decremented). MR is still applied at pulse time per the rule above — so against high-MR enemies individual stacks tick for very little, but they accumulate over long fights.

### Monster hit pipeline

Every direct monster hit on a player goes through `applyMonsterDirectDamage` in this exact order: (1) set resistance %, flat DR/MR/Guard/Bless, shield absorb (`absorb`), HP loss (`damage`); (2) Shield Bash — physical hit, attacker alive, even at 0 damage → stun the attacker; (3) Martyr — Knight victim, damage > 0; (4) HP 0 → Resurrection check (`revive`) else `death`; (5) victim alive and damage > 0 → raise `self_hit`. A reactor that died at (4) never reacts. For single-target attacks `ally_targeted` (Intercept) is raised after targeting and before dodge, so Intercept runs before any of the above.

### Monster skill direct damage

All direct-damage monster skills (Fireball AoE, Assassinate single-target) use the same pipeline as a normal monster attack: damage-type reductions, damage shields, Shield Bash retaliation, Martyr, resurrection and `self_hit` (Shield Slam). **Nimble dodge** applies to any direct-damage skill — for AoE, each player rolls dodge independently. **Intercept** redirects single-target skills the same way it redirects normal attacks. Stuns and DoT applications are not "direct damage" and bypass dodge.

### Shield Slam / Shield Bash physical-only rule

Knight Shield Slam (`brace_reflect`) only reflects *physical* hits, per hit, as they land; magical and holy hits never reflect. Knight Shield Bash (`stun_on_phys_hit`) only triggers from physical hits. This keeps Knight's reactive defenses paired with physical attackers and avoids reflecting magical fireballs as physical damage.

### Martyr trigger rule

Any damage to a Knight (direct attack, AoE skill, single-target skill, or DoT pulse) queues a Priest Martyr heal-bonus stack via `triggerMartyr`. The bonus is **capped at a single stack between heals** — multiple damage events do not stack the bonus. Each Priest with Martyr equipped gets their own stack independently; the next heal that Priest casts consumes their stack.

### Stun rules

A stun never stacks (refreshes to the longer of current and `STUN_MS`), freezes the victim's action timer, cooldowns and cast, interrupts a casting monster, pauses a casting player, and is resisted at application by Iron Will. Stunned units still take DoT/HoT pulses.

## Events and snapshots

Each step emits timestamped `CombatEvent`s (`id` monotonic per battle via `state.nextEventId`, `t` = `elapsedMs`): `battle_start`, `battle_end`, `attack` (animation trigger; `skill`/`skillId` when a skill), `damage` (`dmgType`, `crit`, `overTime`), `heal`, `dodge`, `absorb`, `shield`, `stun`, `resist`, `cast_start`, `cast_end`, `interrupt`, `reaction` (`cardType`), `redirect`, `status` (a named status gained — Bleed, Ignite, Sunder, Crippling Shot, Lullaby, Scorch, Chaos, Rot, War Song), `cleanse`, `death`, `revive`, `buff`, `fizzle`.

`buildClientCombatSnapshot(state, battleId, full)` produces a `ClientCombatSnapshot` of every unit: `hp`, `maxHp` (always), `shield`, stun remaining/total, `actionMs`/`actionTotalMs`, `cast` (`paused` when a stunned player is casting), `statuses`, and for real players (not henchmen) `skills` in slot order with `remainingMs`, `cooldownMs` and a derived `state` — `casting` if casting it, `cooldown` if time remains, `armed` for a trigger skill (interrupts only outside flash mode), `held` if the needed check fails, else `ready`. Static fields (names, monster `id`, `className`, `henchman`, `passive`, `description`, `actionIntervalMs` — the normal action interval, players and non-passive monsters only — equipped `passives`, skill `name`/`cardType`/`trigger`/`castTimeMs`) are included only when `full`.

## Server battle loop

### Battle state machine

`ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). Each party's loop runs continuously: `battle` → finish → `KILL_BEAT_MS` (800 ms, the killing blow stays on screen) → `result` (`RESULT_PAUSE` = 600 ms) → move (`MOVE_DURATION` = 400 ms) or stay → next `battle`. Rewards are granted when the kill beat ends, before the move check, so rooms unlocked by a victory are walkable that cycle. Movement happens instantly at the start of the move window; the client animates the tween.

- The timer steps the engine every `COMBAT_STEP_MS` (100 ms) with a fixed dt, so it is deterministic under fake timers. Battle duration is combat time (`elapsedMs`).
- `battleId` comes from one process-wide counter (seeded from `Date.now()`) and changes on every `triggerBattle`, including restarts and escapes.
- The constructor never starts a battle. `start()` is idempotent; `restartBattle()` on a never-started timer acts as `start()`; `destroy()` is valid at any time. `PartyBattleManager.createEntry` starts the timer, `createEntryFromSave` does not — `PlayerManager` calls `startEntry` only after members, the dungeon run and henchmen are restored.
- `settlePendingResult()` grants a finished-but-unshown result immediately (no move) and marks it settled; the kill beat then skips the grant. `PartyBattleManager` calls it before `restartBattle`, `enterDungeon`, `leaveDungeon`, `enterTransition`, `relocateParty`, `destroyEntry` and `removeMember` (before the member is deleted, so a leaver who fought is paid), so a fight won during its kill beat is always paid exactly once.
- **Failure guard**: every timer callback and `triggerBattle` run inside one guard. On a throw it logs once per battleId, clears timers, sets combat to null / state `result` / visual `none`, broadcasts, and retries after `min(30 s, 1 s × 2^n)` (n = consecutive failures, reset after a normal finish). A throw inside the reward grant is never retried, so rewards are never granted twice. A destroyed timer's callbacks return immediately.
- **Run** is available `RUN_AVAILABLE_MS` (5 s) of combat time into a fight: `canEscape()` gates `escapeBattle()`, and the `run` handler answers "Run becomes available 5 seconds into a fight" before that. Run is not available inside a dungeon.

### Combat message protocol

State pushes (`type: 'state'`) no longer happen per tick — only on battle start, result, move and non-combat triggers. Live combat streams separately:

- `ServerCombatMessage { type: 'combat', battleId, snapshot?, events, log }`. The timer batches events and log lines and flushes every `COMBAT_SEND_MS` (200 ms) of combat time, immediately on start (full snapshot) and on finish (dynamic snapshot + `battle_end`). A dynamic snapshot is attached when ≥ `COMBAT_SNAPSHOT_MS` (500 ms) has passed since the last one, so in practice every 600 ms. A boundary with nothing to say sends nothing.
- `PartyBattleManager.deliverCombat` serialises each flush once per party and skips building/stringifying entirely when no member has a socket showing combat (`setCombatDelivery({ isOnline, sendRaw })`, wired by `PlayerManager`), so offline parties and dev bots cost almost nothing.
- **Visibility gating**: each socket has a combat-view flag (visible by default). The client sends `combat_view {visible}` from `CombatScreen` activation and tab visibility; `PlayerManager.sendCombatRaw` sends only to open, visible sockets, and skips non-full messages on sockets with more than 256 KB buffered.
- **Resync**: after the initial state on login, after every `request_state`, and when a socket flips back to visible, that socket gets one combat message with a **full** snapshot, `events: []`, and `log` = the timer's ring of the last 30 live lines (cleared each battle). The ring holds only lines already streamed: `buildCombatResync` first calls `ServerBattleTimer.flushPending()`, which streams any queued events and lines to the party, so the snapshot, the ring and the stream agree. Nothing is sent between battles.
- `ServerBattleState.combat` (in state pushes) is always a full snapshot.

## Journal vs live log

`PlayerSession` keeps a **journal** of the last 1000 entries (victory/defeat, rewards, level-ups, moves, unlocks, departures, server notices) with a running `battleCount`; saves keep 1000 and each state message carries only the last `STATE_LOG_TAIL` (100). Per-hit engine lines are **not** journaled — they exist only as the `log` field of combat messages (plus the timer's 30-line resync ring). "Battle begins!" is no longer logged; the battle count still increments. The client merges both streams into one buffer (see `client.md` → Combat screen).

## Dungeon combat mode

A party inside a dungeon reuses this exact loop — the only differences are driven by `PartyBattleManager` reading the entry's `dungeonRun`: encounters come from the current floor's `encounterTable` (not the tile), victory advances the floor / completes the run rather than unlocking neighbours, and a wipe ejects the party to the entrance instead of retrying in place. Because the party has no destination inside a dungeon, the loop just re-triggers combat on the same floor until it's cleared. See `docs/architecture/content.md` → Dungeon system for the full lifecycle.

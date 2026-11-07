# Combat

This document covers the combat engine, class system, damage types, skill system, and the various combat invariants that govern how rules interact. For full skill catalog and design rationale see `ideas/skill-trees.md`. Fight times here are authored time unless they say real: see [Combat pace](#combat-pace).

## Class system

Five playable classes designed to be weak solo, strong together. `CharacterStats.ts` defines `ClassDefinition` with `baseHp`, `hpPerLevel`, `baseDamage`, `damagePerLevel`, and `damageType`. No abstract stats (STR/INT/etc.) — HP and damage scale linearly per class. Damage below is authored: a hit in play also scales by the class's [kit](#combat-pace).

| Class  | HP                    | Damage         | Type     |
|--------|-----------------------|----------------|----------|
| Knight | 50 HP +5/lvl          | 1 dmg +1/lvl   | physical |
| Archer | 8 HP +1/lvl           | 15 dmg +2/lvl  | physical |
| Priest | 20 HP +2/lvl          | 3 dmg +1/lvl   | holy     |
| Mage   | 8 HP +1/lvl           | 15 dmg +2/lvl  | magical  |
| Bard   | 10 HP +1/lvl          | 1 dmg +1/lvl   | physical |

A player's character does not exist until they select a class — `PlayerSession.character` is `null` until class selection. Before choosing a class, the player has a WebSocket session but is invisible to the game (no party, no combat, no chat, no social presence). Old saves with invalid/legacy classes get `character = null`, forcing class re-selection.

Skills are **versioned content** (seeded from `SEED_SKILLS` in `SkillTypes.ts`, edited in the World Manager Skills tab, stored in `ContentStore` — see `content.md` → Skill system). Each skill belongs to a class tree, is passive, active or a class's Attack (see [Charge and recovery](#charge-and-recovery)), and is composed of one or more effect **options** from `SKILL_OPTION_CATALOG` (`SkillOptionCatalog.ts`) — the closed set of engine-supported effect kinds; any skill composable from existing kinds needs no code, new kinds still require engine work. Skills auto-unlock at their per-skill `unlockLevel` (seed: 6 passives + 5 actives per class at Lv 1/5/10…50); `unlockLevel: null` marks grant-only skills that come from items/sets. Equip slots come from a per-class **slot schedule** (content; seed: passive@Lv1, active@Lv5, passive@Lv10/30/50). Class selection screen shows baseHp, damage as it hits in play (`paceHitDamage`, with the per-level gain to one decimal), damageType, how often the class acts (its Attack skill's charge plus recovery when it has one, else `paceActionSeconds`, to one decimal) and starting skill (the class's level-1 passive, if any). Players cannot change their own class — only admins can change an existing player's class via `forceSetClass`.

## Class icons

`CLASS_ICONS` (image paths under `/class-icons`), `UNKNOWN_CLASS_ICON` and `classIconHtml` are exported from `shared/src/systems/CharacterStats.ts`. Used everywhere a username is displayed: combat cards, social screens, room view, character screen. When the icon art is missing, `classIconHtml` swaps in the class's `CLASS_GLYPHS` emoji: Knight=🛡️, Archer=🏹, Priest=✨, Mage=🔮, Bard=🎵, Unknown=❔.

## Character & leveling

Each player has a `CharacterState` (className, level, xp, gold, inventory, equipment, skillLoadout). XP is earned on victory. XP to next level = `floor(18000 * L^1.2 * 1.06^L)`. Max HP = `baseHp + (level-1) * hpPerLevel` via `calculateMaxHp(level, className)`. Base damage = `baseDamage + (level-1) * damagePerLevel` via `calculateBaseDamage(level, className)`. Skills auto-unlock at each skill's content-defined `unlockLevel` (there are no skill points); `unlockedSkills` is derived state, recomputed from level + content on every level-up and restore.

## XP rate calculator

Client-side trip counter on Hero › Stats. Tracks cumulative XP earned since last reset, divides by elapsed time to show XP/hr. Formatted with suffixes (k/m/b/t, `?` for >= 1 quadrillion). Reset button clears the counter. Handles level-ups by computing total cumulative XP across all levels.

## Combat engine (real-time timeline)

Pure, deterministic functions in `shared/src/systems/CombatEngine.ts`, with helpers split into `shared/src/systems/combat/` (`CombatTargeting`, `CombatPassives`, `CombatNeeds`, `CombatSnapshot`). Every timing constant lives in `CombatTiming.ts` and the game's speed in `CombatPace.ts`; events and client snapshot types live in `CombatEvents.ts`. Engine time is only `state.elapsedMs` — the engine never reads a wall clock.

Public API: `createPartyCombatState(PartyCombatantInit[], MonsterInstance[], setup?: CombatSetup)` (`setup.pace`, see [Combat pace](#combat-pace)), `processCombatStep(state, dtMs?, rng?)` (dt clamped to `(0, COMBAT_STEP_MS]`), `advanceCombat(state, ms, rng?)` (runs `ceil(ms / 100)` steps, stops when finished), `cloneCombatState(state)`, `buildClientCombatSnapshot(state, battleId, full)`, `combatRealStepMs(state)`, `combatRealElapsedMs(state)`, plus `findTarget`, `applyMonsterResistance`, `wouldHaveEffect`, `effectiveCooldownMs`. Each step returns a `TickResult` (`logEntries`, `events`, `finished`, `result`).

**Randomness and cloning.** Every random draw in the engine (and `createEncounter`/`resolveEncounter`/`pickWeightedEncounter`) goes through an optional `rng` argument that defaults to `Math.random`, read at call time so `vi.spyOn(Math, 'random')` still works. `createRng(seed)` (`combat/CombatRng.ts`, mulberry32) gives a seeded stream. `cloneCombatState` shares read-only content and deep-copies every mutable per-battle field (timers, casts, DoTs, Ignite stacks, enrage clocks, `minPartyHpFrac`), so a clone plus the same seed replays the original's future exactly and never touches it — the basis of [Forecasting](#forecasting). The state also tracks `minPartyHpFrac` (lowest Σ player HP / Σ max HP seen at a step boundary), used for the recap's "closest call".

**The rule: one old round ≡ one authored second.** Every combatant has its own action timer — everyone acts simultaneously on their own clock, not in turn order. As written, a player acts once per `BASE_ACTION_INTERVAL_MS` (1 s) and a monster once per `attackInterval`; in play each class and monster keeps its own slower speed (see [Combat pace](#combat-pace)). Anything that used to be counted in turns (cooldowns, stuns, DoT ticks, debuff durations) is now measured in authored seconds. Run availability is the exception: it is in real seconds.

### Combat pace

`COMBAT_PACE` (`shared/src/systems/CombatPace.ts`) is how fast combat plays. It lives in code, not content: no setting, admin control or MCP tool changes it.

| Field | Value | Meaning |
|---|---|---|
| `clock` | 1.8 | real seconds per authored second, for every combat timer |
| `classSeconds` | Knight 3.6, Archer 2, Priest 1.8, Mage 2.5, Bard 2.5 | real seconds between a class's actions, before they snap to whole steps (see Kit below) |
| `castsAddTime` | true | a player's next action waits interval + cast, not max(interval, cast); monsters keep max() |
| `rewardMultiplier` | 1.8 | XP and gold, and drop chances below 0.5 (up to 0.5 at most) |

**Authored and real time.** Content, the engine's constants and everything in the combat state stay in authored time. Real time exists only at the edges:

- A step is always `COMBAT_STEP_MS` (100 ms) of engine time, live and in forecasts. The pace only spaces the live steps out: one every `combatRealStepMs` (180 ms) of real time, with a fixed 100 ms `dt`. So every timer stays on its authored grid, the same seed plays the same fight at any clock with the same kits, and a forecast's cadence matches the fight's.
- `paceRealMs` converts what clients see: `buildClientCombatSnapshot`, event `t` and `durationMs`, forecast `medianMs`, `p90Ms`, `atMs` and `killEtaMs`, and the enrage reason's text. Log lines that state a length (Lullaby, DoT and HoT pulses) say real seconds, rounded to one decimal.
- `ServerBattleTimer` gates on real time (`combatRealElapsedMs`); see [Server battle loop](#server-battle-loop).

**Fight times and engine constants elsewhere in this document are authored time unless they say real.** At a clock of 1.8 a 1 s stun lasts 1.8 s, a 30 s stalemate window 54 s and a 480 s enrage starts at 14:24. The server's own plumbing (send cadence, kill beat, forecast slices and caches) is real time.

`AUTHORED_PACE` (clock 1, no class seconds, casts absorbed, rewards ×1) plays content exactly as written. `createPartyCombatState` uses it when no pace is passed, so engine tests read in authored time. Real fights and forecasts pass `COMBAT_PACE` from `PartyBattleManager`, and the state keeps it as `state.pace` for the whole fight.

**Kit.** `paceKit` = `classSeconds / clock`, snapped to tenths: Knight 2.0, Archer 1.1, Priest 1, Mage and Bard 1.4. The snap puts every action on a whole step, because an interval between steps would land late and drift against every cooldown. So the real gap between a class's actions is kit × `clock`, which `paceActionSeconds` returns (Knight 3.6 s, Archer 1.98 s, Priest 1.8 s, Mage and Bard 2.52 s), nothing overshoots a step, and a cooldown of N is exactly every Nth action. A class that acts less often per authored second does that much more per action, so its output per authored second stays the same. For a player's actions (autos and non-triggered skills):

- Action interval, cooldown and cast scale by kit. A warm-up scales only past the first action (see [Cooldowns, warm-up, CDR](#cooldowns-warm-up-cdr)).
- So do damage, heals, shields, the holy rider, debuff durations and Scorch. Amounts round to the nearest whole number, except a flat per-level AoE, which is `floor(damagePerLevel × level × kit)`. DoTs and Ignite are shares of the hit, so they follow it.
- Ignite's stack cap is `round(8 / kit)`: its stacks are bigger, so fewer of them keep the capped total. A Mage's cap is 6.
- Sunder and War Song add up to kit stacks at once without passing their caps. Stacks can be fractional; snapshots round them.
- A stun's chance scales by kit up to 100 %, and any excess lengthens the stun (`rollActionStunMs`).

Reactions (a skill with a trigger, firing on that trigger) keep kit 1: they run on the clock, not on the class's actions.

**Why Priest stays equal to the clock.** Its kit is 1 on purpose. Heals are capped by missing HP, so heals bigger and rarer than the monsters' hits get wasted on the same HP pool. A Priest therefore acts exactly as often as a monster with a 1 s `attackInterval`.

**Rule of thumb for authors.** Write content in authored seconds and balance it in authored time: both sides slow down together, so a monster tuned against party DPS per authored second stays tuned. The match isn't exact, since bigger hits overkill more, so measure with `tools/content-lab`.

| Content | Real time |
|---|---|
| Monster `attackInterval`, monster skill `cooldown` and `castTime`, `enrage` times | authored × `clock` |
| Action skill `cooldown`, `castTime` | authored × `paceActionSeconds`; `cooldown: N` means every Nth action |
| Action skill `warmup` | the first authored second × `clock`, the rest × `paceActionSeconds`; `warmup: N` is ready on action N |
| Reaction skill `cooldown`, `warmup` | authored × `clock` |

A player's cast costs its length on top of the action, so price it into the skill's effect. A description is shown as written, so when it states a time, write the real one.

**Rewards.** Slower fights mean fewer kills per hour, so `PartyBattleManager` multiplies XP and gold by `rewardMultiplier` and rolls monster drops through `paceDropChance`. Chances of 0.5 and up stay as authored: they are deliberate near-guarantees, not rates. Lower ones scale up to 0.5 at most, so a rarer drop never passes a commoner one. Kill counts for quests and mastery don't change, so those take longer in real time.

**Changing the pace.** Edit the one constant; no content or save data changes. What depends on it:

- `classSeconds` are real seconds, so a new `clock` changes every kit. Kits snap to tenths, so read what `paceActionSeconds` gives rather than assuming a class acts at its `classSeconds`. Keep Priest equal to the clock.
- Keep `rewardMultiplier` in step with how much longer fights get, or income per hour moves.
- A real step is `COMBAT_STEP_MS` × `clock`, rounded to a whole ms, so keep `clock` to two decimals. Past that, the step timer drifts from the real times the conversions report.
- These follow on their own: snapshots, events and forecasts, the flush and snapshot cadence, skill chips, Hero's ATK, class select, hire offers, MCP `combatPace`, the World Manager hint and the content lab's `SPEED_TARGET`.
- These don't: times written in content descriptions, the seed skills' included, and the real-time examples in this document. Re-measure with `tools/content-lab`, and ship it with patch notes and a `GAME_VERSION` bump.

**Known limits.**

- Descriptions in content state times by hand and the code doesn't rewrite them, so one can disagree with the skill chip beside it until an author fixes it.
- Item ATK text and the gear compare stay authored while hits and Hero's ATK scale, so an item's ATK reads low on a slow class.
- Floor rewards and first-clear rewards are per run and don't scale.
- A drop only scales up to 0.5, so one of 0.28 or more can't keep up with the slower kills and falls per hour.
- A few per-use effects aren't compensated for firing less often: Chaos flags each monster's next action whatever the kit, Focus ramps one stack per hit, and a buff strip just happens less often.
- The pace is a single constant, so a release changes every server at once, whatever content each one holds.

### State and timers

`createPartyCombatState` owns every per-battle field — `PartyCombatantInit` omits them, so session, henchman and test builders never set timers. Players sort front-to-back (col desc) then top-to-bottom; monsters sort front first (col asc) then row.

- **Action timers** — `actionRemainingMs` counts down; `actionTotalMs` is the current wait (for the client's action ring; with an Attack skill, see [Charge and recovery](#charge-and-recovery)). Players' first action lands at `FIRST_ACTION_PLAYER_MS` (1000) + 100 ms × sorted index (index capped at 5), whatever the class; monsters' at `FIRST_ACTION_MONSTER_MS` (1400) + 100 ms × index (capped at 8), so the party strikes first. Players then act every `actionIntervalMs` = `BASE_ACTION_INTERVAL_MS` × kit, always a whole number of steps. Monsters act every `attackInterval` seconds (content; default 1, clamped ≥ `MIN_MONSTER_ACTION_INTERVAL_MS` = 300 ms). Passive monsters (walls) get no action timer (still consume a stagger index).
- **Status pulses** — each unit has its own `pulseRemainingMs` (same first offset), firing every `STATUS_PULSE_MS` (1 s): DoT and HoT ticks happen on the owner's pulse. Pulses run while stunned; walls pulse too.
- **Durations** — debuffs/buffs carry `remainingMs` (`duration: N` → N × 1000, `-1` = permanent); `DotEffect`/`HotEffect.ticksRemaining` counts pulses.
- **Cooldowns** — `skillCooldowns` (ms remaining) and `skillCooldownTotals` (length of the current/last cooldown, warm-up included) per equipped active; monster `skillCooldowns` in ms, starting at 0.
- **Casts** — `CombatCast { skillId, skillName, totalMs, remainingMs, target?, counter? }` on players and monsters. Pending interrupt counters live on `state.pendingCounters` (the `cast.counter` field is only a mirror).

### Step order (`processCombatStep`, at most 100 ms of engine time)

1. Finished → empty result. `elapsedMs += dt`, `tickCount++`; the first step emits `battle_start`. **Enrage pass**: each living monster with an enrage clock gains any stacks now due (see [Monster tiers and enrage](#monster-tiers-and-enrage)).
2. **Status pass** (players in turn order, then monsters): expire debuffs/buffs, tick pulses (DoT grouped by name and source, each group scaled by its own source at pulse time, Martyr on Knight, HoT). A DoT death emits `death` (players get an immediate Resurrection check). **End check.**
3. **Pending counters** whose `atMs ≤ elapsedMs` resolve. **End check.**
4. **Actor pass** — players (col desc, row asc), then monsters (col asc, row asc); dead and passive units skip. Per unit: stunned → only the stun timer counts down; else cooldowns tick (a cooldown started this step is not decremented this step), an in-progress cast progresses/resolves, then the action timer counts down and, if due and not casting, the unit **acts** and schedules its next action (`+= interval`; after starting a cast, `+= interval + castMs` for a player when the pace has `castsAddTime`, otherwise `+= max(interval, castMs)`). **End check after every actor slot**, acting or not.
5. **Level triggers** (`ally_afflicted`, `ally_low_hp`) are evaluated once. **End check.**
6. **Stalemate**: the HP sum of all living monsters, walls included, is tracked, so chipping through a wall counts as progress; whenever it reaches a new low `lastProgressMs` is stamped. After `STALEMATE_WINDOW_MS` (30 s) without progress — `BOSS_STALEMATE_WINDOW_MS` (180 s) while a living boss/raid-tier monster is present — the fight ends in defeat with "The fight drags on — the party withdraws." The window also stretches to twice a living player's slowest Attack, the longer of its initial charge and its cycle, so authored timing near the validator's limits can't lose before Attack has landed; only long Attacks reach this, and a combatant with no attack skill never does. Victory still ignores walls: a wall-only fight is won once every living player has acted with no cast running, or has resolved a cast of a skill with charge or recovery, so those casts chained with no recovery can't hold it open. A cast of a skill with neither keeps the fight open until it resolves.

End check: all non-passive monsters dead → victory (in a fight with only walls: all walls dead, or every living player has finished a first action, so the opening hits show and a tall wall doesn't become a grind); else all players dead → defeat. Victory is tested first everywhere, so a mutual wipe is a victory. Finishing emits `battle_end {result}`. `CombatResult` is `'victory' | 'defeat' | 'retreat'`, but the engine only ever produces the first two — `'retreat'` is set by the server timer (see [Auto-retreat](#auto-retreat)).

### Actions

A player's action walks equipped skills in slot order and uses the first usable active that is off cooldown and passes the **needed check** (`wouldHaveEffect`); with none, it auto-attacks. Reaction skills are skipped. With [charge and recovery](#charge-and-recovery) the walk follows the player's priority list and includes Attack, and a player with nothing ready stays idle and rechecks next step. A monster's action uses the first skill in its array that is off cooldown **and** would do something (heal: a wounded living non-passive monster, the caster included — lowest HP first, never a wall; fear: a living player of a target class; damage/dot: a living target), else auto-attacks — a monster skill with nothing to do does not burn its cooldown. A monster flagged by Chaos spends its next action hitting a random monster instead.

Player damage = `baseDamage + variance(-2..+2) + equipBonus` (min 1), then Intensify, Rally, War Song and set `damagePercent`, then conditional bonuses (Marksman/Brave/Exploit Weakness/War Cry), Focus stacks (≤ 5), Sunder marks (≤ 3) and Scorch; crit (Archer Pierce, chance capped at 1) last; the result is then multiplied by the action's [kit](#combat-pace), rounded, and goes through the monster's resistance, the level gap and mastery (see [Level-relative scaling](#level-relative-scaling)). At combat start Mage Burn (`bonus_damage`) adds per-level damage and `max_hp_percent` scales max HP; the Rally multiplier (`0.20 × partySize` per equipped Bard) is precomputed. Damage to players is mitigated by rating (gear DR + Knight Guard for physical, gear MR + Priest Bless for magical, Bless alone for holy). Unnerve, Lullaby and Crippling Shot reduce monster auto-attacks only (combined, capped); monster skill values ignore them.

`findTarget()` implements grid-based targeting on the 3x3 grid (positions 0-8): row = floor(pos/3), col = pos%3. Same row first; players prefer low-column monsters (front), monsters prefer high-column players (front); if no same-row target, scan up then down. `stun_single` (Bash) prefers the first living monster that is mid-cast (so Bash interrupts spellcasters), else `findTarget`.

### Stuns

`STUN_MS` = 1 s (a player's action can stun for longer, see [Combat pace](#combat-pace)), and a stun never stacks: `stunRemainingMs = max(current, new)`. A stun freezes the victim's action timer, cooldowns and cast progress. A stun on a **casting monster interrupts** the cast (`interrupt` event, "X's Fireball is interrupted!"); a stun on a **casting player pauses** the cast, which resumes when the stun ends or is cured. Iron Will (`stun_immune`) resists at application time (`resist` event, "X's Iron Will resists the stun!") and never shows as stunned. "X is stunned!" is logged once when a monster stun lands. Walls can never be stunned: `stun_single` still hits a wall but skips the stun; `stun_aoe`, Lullaby and Chaos skip walls entirely.

## Skills as cards

Every skill has a **card type**, derived by `getSkillCardType(skill)` (`SkillTypes.ts`, first match wins) and described by `SKILL_CARD_TYPE_INFO` (label, icon, blurb):

| Card | Icon | Rule | Meaning |
|---|---|---|---|
| Instant | ⚡ | any trigger, explicit or inferred; or a passive with any of stun_on_phys_hit, martyr, resurrection, dot_on_auto, overflow, scorch, stacking_same_target, arcane_surge | Fires on its own when something happens |
| Passive | ◆ | any other passive | Always on |
| Basic attack | 🗡️ | type `attack` | The class's auto-attack, always in use |
| Action | ⚔️ | every other active | Uses your turn when ready, once it would do something |

Action and Basic attack use their owner's turn and have charge and recovery. An active Instant has charge only. A passive shown as an Instant is still a passive, with no charge and its usual slot and behaviour. Only the label is shared.

Active skills carry optional `cooldown` (seconds, default 1), `castTime` (seconds, 0–10, default 0), `warmup` (seconds, 0–60) and `trigger`. `getSkillTrigger(skill)` returns the explicit `trigger`, else **infers** one: any `redirect_hit` option → `ally_targeted`, any `brace_reflect` → `self_hit`. The inference is load-bearing — live servers hold Intercept/Shield Slam skills authored before `trigger` existed. `SKILL_TRIGGER_INFO` holds each trigger's label and description.

### Charge and recovery

A skill with `charge` or `recovery` (`isTimedSkill`) plays on them instead of `cooldown`. Both are real seconds, 0 to 120, and a missing one reads as 0 when the other is set. Passives have neither, and a skill with a trigger has no recovery (`skillRecoveryMs` returns 0, ignoring any stale value, and validation rejects one above 0). A use runs **cast (if any) → recovery → charge → ready**:

- **Charge** is how long the skill takes to be ready again once its own recovery ends. Its timer is set to cast + recovery + charge at use and ticks like any cooldown, freezing during a stun. Other skills' timers keep ticking.
- **Time until the next action.** `nextActionWaitMs` (`CombatNeeds`) answers "when does this player act next, as things stand": the action choice's walk over the priority list, taking the soonest charge among Attack and skills that pass the needed check, at least the wait for the owner's cast and recovery, and at least one step, since a player acts at most once a step. It reads state and changes no timer, so it can't move a fight. A player with an Attack skill records it in `actionTotalMs` at the start of the fight and at each action, once that action's effects have landed, and carries it as `nextActionMs` on that action's `attack` or `cast_start` event; a snapshot sends it live. Since charges only run down, the prediction is exact unless a skill's need changes or a stun or death intervenes. A skill that becomes needed brings it forward, and the ring jumps on the next snapshot. Players without an Attack skill keep the plain action timer, and old-content fights stay byte-identical.
- **Recovery** starts when a cast resolves, or at use with no cast. While it runs (`recoveryRemainingMs`) the player takes no turn, but instants still fire. A cast blocks actions but not instants, as before.
- **Conversion.** `paceEngineMs` turns real seconds into engine time, to the nearest step, and a nonzero time stays at least one step. Clients show `paceRealMs` of that snapped value, to one decimal. `castTime` stays authored × kit and telegraphed.
- **Initial charge** is the existing `warmup`, read in real seconds on these skills: blank starts at the full charge with no recovery part, and 0 is ready immediately.
- **Cooldown reduction** of N takes N × `clock` real seconds off charge and never off recovery, and a cycle can't fall below `min(base cycle, MIN_COOLDOWN_MS × clock)`. `enemy_cast` instants ignore it, and so does Attack: kit stays fixed, so a reduced Attack would otherwise be a straight damage multiplier.
- **Kit doesn't follow Attack.** `classSeconds` still sizes a class's hits and heals, so a faster Attack in content is really stronger. Charge and recovery are real power knobs.
- **A fizzle** keeps the charge and recovery spent, and the player gets no Attack in that action.

**Attack skills.** `type: 'attack'`, at most one per class, `unlockLevel` 1, no effects, and at least one of the two times must be nonzero. An attack skill never takes a slot and can't be equipped; old saves may list its id in `unlockedSkills`, never in a slot. Its effect is `playerAutoAttack`, with every passive that hooks autos. `PartyCombatantInit.attack` carries it from content for real players and hires. It opens at its charge (or `warmup`) plus 100 ms of engine time × the player's sorted index, capped at 5, so a party doesn't strike in one frame. A low-charge class opens fast and a high-charge one slow, on purpose. An attack skill with neither time set is ignored, so that class plays as if it had none.

**Priority.** `SkillLoadout.actionOrder` lists the attack skill and any equipped action skills (`isActionSkill`: non-trigger actives). `resolveActionOrder` turns it into the walk, and the first skill charged and needed wins, so Attack above a skill doesn't starve it: the skill fires in the window while Attack recharges. Absent or partial lists default safely: stale ids are ignored, and equipped skills it leaves out follow in slot order, above Attack unless Attack is listed. With no attack skill the list still reorders actives, and autos stay the fallback. It never changes passive first-match order or reaction order, which stay in slot order. Clients set it with `set_action_order`, validated by `PlayerSession.handleSetActionOrder` (at most `MAX_ACTION_ORDER_LENGTH` unique strings, all owned by that player, empty resets it). It lives in the loadout, so it saves and pushes with it, and `forceSetClass` clears it. Fights read it when they are built, so a reorder applies from the next fight, and forecasts carry it. Hires use the default.

**Compatibility.** Live servers hold content with neither field until an operator publishes new content. Such a skill keeps `cooldown`, `warmup`, action-time scaling and the class interval, and a player with no attack skill keeps today's opener and action interval, with seeded determinism intact (`shared/tests/CombatChargeRecovery.test.ts` pins this against digests from the earlier engine). Partly migrated content works too: only skills with a field play on it.

### Needed check: held vs fizzle

`wouldHaveEffect` (`shared/src/systems/combat/CombatNeeds.ts`) uses the same target helpers as the executor:

- heal_lowest / hot_lowest: some living, wounded ally below `HEAL_NEEDED_THRESHOLD` (70 % HP) → lowest-HP% such ally. (The old "below 50 % or missing half a heal" rule heal-locked a solo Priest once every hit dealt at least 1.)
- cure_debuffs: some living ally stunned or carrying a DoT/debuff → stunned first, then lowest HP%.
- shield_non_knight: some living non-Knight ally with no shield.
- party_buff_permanent (War Song): fewer than `WAR_SONG_MAX_STACKS` (5) stacks and a living monster — at the cap it is held, not wasted.
- redirect_hit / brace_reflect: only inside their trigger.
- stun_aoe: a living non-wall monster; every other enemy-targeting kind: a living monster.

A skill whose options all fail is **held** — it stays ready with no cooldown and the next skill (or the auto-attack) is considered. A skill that passes but whose options all turn out to do nothing at execution (e.g. Drumroll rolling no stuns) **fizzles**: the cooldown stays spent, a `fizzle` event and "X's Y fizzles!" line go out, Arcane Surge's `activeSkillCount` is rewound, and a no-cast action skill with neither charge nor recovery falls back to an auto-attack in the same action. With either field there is no fallback. A multi-option skill executes all its options in order and counts as a fizzle only when every option no-ops. Summing passives sum across all equipped options; first-match passives (martyr, scorch, resurrection, stun-on-hit, intensify, focus, healing-received) use the first matching option.

### Cooldowns, warm-up, CDR

This is the timing of a skill with neither `charge` nor `recovery`; see [Charge and recovery](#charge-and-recovery) for the rest.

`effectiveCooldownMs(owner, skill, allPlayers) = max(MIN_COOLDOWN_MS, cooldown × 1000 − CDR)` where CDR (seconds) is the owner's own `cooldown_reduction` options, other *living* members' party-wide ones (`PassiveEffect.partyWide`: Bard Tempo is self-only, Encore party-wide) and the set bonus `cooldownReduction`. `MIN_COOLDOWN_MS` = 1 s. **`enemy_cast` instants ignore CDR.** The cooldown is computed whenever it (re)starts and starts *before* the skill resolves (at cast start for cast-time skills). An action skill's use starts that × kit (`useCooldownMs`). Any skill with a trigger starts it as is. So on an action skill a cooldown of N means every Nth action and each second of CDR is one action sooner. `getSetBonusText` words a set's `cooldownReduction` that way ("-1 action Active CD") only when the catalog it is given has no skill with charge or recovery; otherwise, or with no catalog, it uses real seconds of charge ("-1.8s skill charge"). A catalog holding both kinds gets the charge wording.

Warm-up (cooldown remaining at battle start, `initialWarmupMs`): an explicit `warmup` if set; otherwise `effectiveCooldown − 1 s` for action skills and `enemy_cast` instants, while other instants start ready. Either goes through `warmupFromOpenerMs`. The first action lands at 1.0 s whatever the class, so time up to that opener stays as it is and only time past it is in the owner's time: × kit on an action skill, as is on anything with a trigger. So an explicit `warmup` of 0 or 1 is usable on the first action at any kit, and `warmup: N` on action N. A derived warm-up comes to `1 s + (effectiveCooldown − 2 s) × kit` past the opener, which makes a cooldown of N usable on action N − 1: a 2 s action skill on its first action, a 3 s one on its second. An `enemy_cast` instant's stays `effectiveCooldown − 1 s` at any kit.

### Casts

Skills with `castTime > 0` (players) or an effective monster cast time (below) are telegraphed (a player's action cast lasts `castTime` × kit; cast lengths round up to whole 100 ms of engine time):

1. **Start** — the cooldown starts, `cast` is set, `cast_start {src, dst?, skill, skillId, durationMs, nextActionMs?}` is emitted and "X begins casting Y!" logged. Single-target kinds lock their target (`cast.target`); AoE kinds pick at resolution. A monster's next action is pushed out by `max(interval, castMs)`. A player's is too at `AUTHORED_PACE`, but with `castsAddTime` it waits `interval + castMs`, and `nextActionMs` carries that wait in real ms for the client's ring. A player with an Attack skill always gets `nextActionMs`, measured as under [Charge and recovery](#charge-and-recovery).
2. **Progress** — `remainingMs` counts down on every non-stunned step; a unit never starts an action while casting.
3. **Resolve** — `cast` is cleared and `cast_end` emitted **before** the effects run, so a stun landing during resolution (Shield Bash on an Assassinate) is an ordinary stun, not an interrupt. Single-enemy kinds re-pick only if the locked target died; ally kinds always re-pick; nothing valid → `fizzle` (cooldown stays spent, no fallback auto-attack). A unit whose action is due in the same step acts after its cast resolves. A player cast's resolving `attack` event carries `skill` but no `skillId` (the client restarts cooldown sweeps from `skillId`).
4. **Stun** — interrupts a monster cast, pauses a player cast (see Stuns).
5. **Death** clears the cast silently. Cooldowns are never refunded.

A skill with [charge and recovery](#charge-and-recovery) waits cast + its recovery instead of the class interval (`cast_start.nextActionMs`), and `cast_end` carries `recoveryMs`, because recovery starts there.

### Reactions (instants)

A skill with a trigger never uses its owner's action timer and keeps kit 1. It may fire while its owner is casting, never while stunned or dead. One reaction per trigger event: the first eligible player in player order, first eligible skill in slot order, and only if `wouldHaveEffect` passes against the trigger context. The cooldown starts before effects resolve, so reactions raised while another reaction resolves run synchronously depth-first and always terminate.

| Trigger | Kind | Fires when |
|---|---|---|
| `ally_targeted` | event | a monster single-target attack (auto-attack or single-target damage skill, at resolution) targets a player other than the reactor — after targeting, before dodge/damage |
| `self_hit` | event | step 5 of the hit pipeline (the reactor took damage and survived) |
| `enemy_cast` | event | a monster starts a cast (see Interrupts, below) |
| `ally_afflicted` | level | end of every step: a living player is stunned or has a DoT/debuff (stunned first, then lowest HP%) |
| `ally_low_hp` | level | end of every step: a living player is below 50 % HP (lowest HP%) |

An instant ignores its owner's recovery and causes none: firing never touches `recoveryRemainingMs`, `recoveryTotalMs`, `actionRemainingMs` or `actionTotalMs`, its `reaction` event carries no `recoveryMs`, and only its own charge limits it. `timedCycleMs` keeps that timer at one engine step at least, so content with a charge of 0 can't fire without limit. A stun or death still blocks it.

Reactions target from the trigger context: ally kinds take the trigger's ally, single-enemy kinds its enemy, falling back to the kind's normal rule when that slot is missing or dead.

- **Intercept (`redirect_hit`)** fires only for `ally_targeted`, only when the original target's max HP is lower than the reactor's, and never re-redirects. While a monster has a telegraphed damage cast locked on a *different* player, Intercept holds itself for that cast's resolution. The reactor becomes the target (`reaction` + `redirect {src: reactor, dst: original}` events); if an `ally_targeted` reaction killed or stunned the attacker, the attack is cancelled (a telegraphed cast that already resolved still lands).
- **Shield Slam (`brace_reflect`)** fires only for `self_hit` on a physical hit, dealing `max(1, floor(hit × reflectPercent))` direct damage to every living monster (doubled on Arcane Surge's even count; Intensify does not apply). Its `reaction` event uses the reactor itself as `dst`.
- **Cure** (`ally_afflicted`) and **Mending** (`ally_low_hp`) are the seed level-trigger instants.

### Interrupts (`enemy_cast`)

When a monster starts a cast, the first off-cooldown `enemy_cast` skill (player order, slot order; no needed check) **commits**: a `reaction` is emitted and its cooldown starts. `INTERRUPT_DELAY_MS` (300 ms) later — or immediately if the cast would finish sooner — its effects hit the caster (stun options roll their normal chance, e.g. Drumroll's 25 % per enemy; a stun landing on the caster does not raise its own interrupt). Then, if the caster is alive and still casting that spell, the cast is **countered**: cancelled, exactly one `interrupt {src: reactor, dst: caster, countered: true}` event (a stun's interrupt carries no `countered`), and "X's Dispel counters Y's Fireball!" logged. The monster's skill stays on cooldown and its action timer is not refunded. A counter still applies its effects if another stun cancelled the cast first. A reactor that is dead or stunned when the delay elapses loses the counter: its cooldown stays spent and a `fizzle` is emitted. Casts started in the same step are handled in monster order, each committing its own interrupt.

An `enemy_cast` skill only ever fires on a cast. With no enemy that can cast, it stays idle, reads `armed`, and never appears in the action walk. Both legacy and timed skills behave this way.

### Seed skills

Seed skills (fresh worlds only; live content may differ), as charge / recovery in real seconds, or charge alone on an instant, which is its old charge plus recovery, so its rhythm is unchanged. Attack skills, one per class, ids `<class>_attack`, whose totals match the class's action gap, so a plain Attack keeps its damage per second: Knight 3.6 / 0, Archer 0.4 / 1.6, Priest 1.4 / 0.4, Mage 2 / 0.5, Bard 1.8 / 0.7. Actives: Knight Bash 6.3 / 0.9 (prefers a casting target), Intercept 1.8 (instant, `ally_targeted`), Shield Slam 1.8 (instant, `self_hit`, reflects 10 %), Sunder 9 / 0.9 (initial charge 1.8), Dispel 9.9 (instant, `enemy_cast`); Archer Cut Down 4.4 / 1.6, Triple Shot 6.4 / 1.6, Snipe 8 / 2 (cast 1 s), Bleed 4.4 / 1.6, Crippling Shot 4.4 / 1.6; Priest Minor Heal 0.9 / 0.9, Smite 2.7 / 0.9, Cure 5.4 (instant, `ally_afflicted`), Mending 7.2 (instant, `ally_low_hp`), Sanctuary 0.9 / 0.9; Mage Magic Missile 7 / 0.5, Zap 2 / 0.5, Blizzard 14 / 1 (cast 1.5 s), Chain Lightning 2 / 0.5, Arcane Blast 11.5 / 1 (cast 1 s); Bard Dissonance 6.8 / 0.7, Drumroll 7.2 (instant, `enemy_cast`), War Song 9.3 / 0.7 (initial charge 0), Lullaby 11.8 / 0.7, Chaos 14.3 / 0.7. Cast times are authored and scale by kit. Starting passives: Guard (physical rating, self), Rally (+20 % all damage/member), Bless (magical/holy rating, party), Pierce (20 % crit), Burn (+2 dmg/lvl). Tempo / Encore give −1 authored second of cooldown, or −1.8 s real of charge (self / party).

Advanced mechanics include: DoTs (Bleed, Ignite), HoTs (Mending), damage shields (Sanctuary), stacking marks (Sunder +25 % incoming/stack), conditional damage (Marksman, Brave, Exploit Weakness, War Cry), cooldown reduction, party XP bonus (Inspiration), and many more.

## Monsters in combat

- `MonsterDefinition.attackInterval` (seconds, default 1, clamped ≥ 0.3). `createMonsterInstance` copies it and clones `skills`/`resistances` per instance.
- Monster skills come from the hardcoded `MONSTER_SKILL_CATALOG` (`MonsterSkills.ts`). Each entry's `cooldown` is seconds (0 = every action); cast time is `MonsterSkillEntry.castTime` if set, else the catalog default — fireball 1.5 s, fear 1 s, heal 1 s, assassinate 1 s (target locked and telegraphed), rot 0 (`getMonsterSkillCastTimeMs`). Unknown skill ids are skipped.
- Cast-time monster skills follow the cast lifecycle above and raise `enemy_cast`.
- Walls (`passive: true`) never act or cast, still take DoT pulses, are never flagged by Chaos, never healed by monster Heal, and don't count toward victory.
- Seed casters: `goblin_shaman` (Fireball + Heal) in the Darkwood and Crystal Caves goblin pools, `bandit_cutthroat` (elite, Assassinate) in the Darkwood bandit pool, `goblin_chieftain` (boss, Fireball + Fear) on the Crystal Caves Trial's last floor. Seed wolves attack every 0.8 s, bandits every 1.25 s. See `content.md` → Monster system.
- `createMonsterInstance` also fills `level`, `levelSource`, `tier` and `enrage` (see below).

## Damage types

`DamageType = 'physical' | 'magical' | 'holy'`. Monsters and player classes each have a damage type. Against players: physical is mitigated by gear DR (`damageReductionMin/Max`) + Knight Guard (self only); magical by gear MR (`magicReductionMin/Max`) + Priest Bless (party-wide); holy by Bless alone. All of it is a **rating**, not a flat subtraction — see below.

## Level-relative scaling

Every flat subtraction is gone. Constants and helpers live in `shared/src/systems/CombatScaling.ts`; the engine applies them in `mitigateHitOnPlayer` / `mitigateHitOnMonster` (`CombatEngine.ts`) and `monsterResistFactor` (`combat/CombatPassives.ts`).

| Constant | Value | Meaning |
|---|---|---|
| `ARMOR_K` | 4 | rating per attacker level that gives 50 % mitigation |
| `MAX_MITIGATION` | 0.8 | rating mitigation cap |
| `SKILL_RATING_SCALE` | 2 | Guard/Bless rating = 2 × `valuePerLevel` × owner level |
| `MAX_PERCENT_RESIST` | 0.75 | cap on set resist % (players) and `percentReduction` (monsters) |
| `LEVEL_GAP_SLOPE` / `GAP_LEVEL_OFFSET` | 0.05 / 40 | level-gap slope and its level scaling |
| `LEVEL_GAP_MIN` / `LEVEL_GAP_MAX` | 0.5 / 1.5 | gap multiplier clamp |
| `MAX_ENEMY_DAMAGE_REDUCTION` | 0.6 | combined Unnerve × Lullaby × Crippling Shot cap |
| `MAX_DODGE` | 0.5 | Nimble dodge cap (crit chance is capped at 1) |
| `FOCUS_MAX_STACKS` / `SUNDER_MAX_STACKS` / `WAR_SONG_MAX_STACKS` / `IGNITE_MAX_STACKS` | 5 / 3 / 5 / 8 | ramp caps |

**Formulas.**

- `ratingMitigation(R, L) = min(MAX_MITIGATION, R / (R + ARMOR_K × max(1, L)))` — L is the attacker's level; a rating equal to 4 × attacker level halves damage. Negative or non-finite ratings count as 0.
- `levelGapMultiplier(a, d) = clamp(1 + 0.05 × (min(a, d) + 40) / 50 × (a − d), 0.5, 1.5)` — the slope grows with level (0.041 per level at L1, 0.05 at L10, 0.09 at L50), so a 3-level gap bites harder late than early.
- `scaleDamage(raw, factor) = max(1, floor(raw × factor))` for raw ≥ 1; raw 0 (or NaN) stays 0. A `1 + 1e-12` tolerance keeps float noise (100 × 0.2 = 19.999…) from flooring a whole number down.
- **Hit on a player** (direct and each DoT pulse group — one group per (name, source), so same-named DoTs from different sources never share a gap or mastery): `raw × gap × mastery × (1 − ratingMitigation(rating, L)) × (1 − clamp(setDamageResistancePercent/100, 0, 0.75))`, one floor, min 1. Rating = gear average (`(min + max) / 2` summed, the per-hit DR/MR roll is gone) + Guard (physical) / + Bless (magical) / Bless only (holy). Bless takes the **strongest living owner** — owners do not stack. Shields absorb afterwards; the hit-pipeline order is unchanged.
- **Hit on a monster**: `raw × gap × mastery × (1 − ratingMitigation(flatReduction, L_player)) × (1 − clamp(percentReduction/100, −1, 0.75))`, min 1. A negative flat counts as 0 (a weakness needs a negative percent; −100 % doubles damage). Bypasses stay bypasses: Snipe, Shield Slam reflect, Overflow, Chaos and Dissonance's flat damage.
- **Enemy damage debuffs** (Unnerve, Lullaby, Crippling Shot) multiply as floats, combined reduction ≤ 60 %, one floor at the end; enrage multiplies on top (`getMonsterDamage`).
- **Ramp caps**: Focus ≤ 5 consecutive-hit stacks; Sunder ≤ 3 marks (still logs at the cap); War Song ≤ 5 (held at the cap); Ignite ≤ `round(8 / kit)` stacks per (source, target), by its owner's kit — at the cap a new hit replaces the weakest stack.

**Level sources.** A combatant's level is *authored* or *derived* (`CombatLevel { level, derived }`, `pairScaling`). Players are authored. **Henchmen count as derived** (their level still drives their own per-level passives and heals). A monster is authored only when its definition sets `level` (see [Monster tiers and enrage](#monster-tiers-and-enrage)); otherwise `deriveMonsterLevel` estimates one, and that level is also flagged `estimated`. Two separate rules: if **either** side is derived the gap is 1; mitigation is judged at the **attacker's own level** unless the attacker's level is `estimated` (an unauthored monster), in which case the defender's level is used. So a henchman is judged at its own level exactly like a player — against authored and unauthored monsters alike — and an estimated level never feeds mitigation. Unauthored content therefore plays exactly as if levels did not exist — estimated levels never change a fight. Derived levels are internal only: no player-facing surface or authoring tool shows a derived number (the bestiary and mastery entries omit it; forecast `enemyLevels` span authored enemies only, and `someUnrated` flags the rest — the client shows "Enemies L1–5 (some unrated)").

**Guard/Bless.** A same-level attacker faces `rating / (rating + 4L)`; with rating = 2 × vpl × L that is `2·vpl / (2·vpl + 4)`, independent of level — the skill card's computed line (`skillRatingMitigation`, "≈50 % vs same-level enemies" for vpl 2) is exact on-level and drifts with the gap.

**XP by level difference.** For monsters with an **authored** level, each member's XP (not gold) from that monster is multiplied by `XP_CON_FACTOR[levelCon(monsterLevel, memberLevel)]` — trivial 0.25, easy 0.75, even and above 1 — so the per-kill split is computed per member (`PartyBattleManager.memberXp`). Derived levels get factor 1, so unauthored content pays exactly as before. Con bands (`levelCon`, `MonsterLevels.ts`): Δ = target − viewer; viewer ≥ 10: deadly ≥ +5, hard +3..+4, even −2..+2, easy down to −(5 + ⌊viewer/10⌋), trivial below; viewer < 10: deadly ≥ +3, hard +2. `LEVEL_CON_INFO` gives label + glyph (trivial ·, easy ▾, even ●, hard ▴, deadly ☠).

## Monster tiers and enrage

`MonsterDefinition` gains optional `level` (1–200), `tier` (`'trash' | 'elite' | 'boss' | 'raid'`, absent = trash) and `enrage` (`{ afterSeconds, stepSeconds?, stepPercent?, maxStacks? }`). Tiers drive the stalemate window, enrage defaults, the forecast budget, mastery thresholds, template sizing and the client's tier frames.

- **Enrage** (`resolveEnrage`): an explicit, valid `enrage` wins; otherwise boss `{afterSeconds: 480}`, raid `{afterSeconds: 3600}`, trash/elite never. Defaults: `ENRAGE_STEP_SECONDS` 30, `ENRAGE_STEP_PERCENT` 0.10, `ENRAGE_MAX_STACKS` 30. The first stack lands at `afterSeconds`, then one per step; the monster's autos, skill damage and the DoTs it applies are multiplied by `1 + stacks × stepPercent`. Each new stack emits `enrage {src, amount: stacks}`, logs "X is enraged! (×1.3)" and shows as a status of kind `'enrage'` (never cleansed).
- **Stalemate**: 180 s while a living non-passive boss/raid monster is present — a passive boss-tier wall doesn't count (long fights with heavy healing must not be cut at 30 s).
- **Level derivation** (`deriveMonsterLevel`, `MonsterLevels.ts`): from **damage output only** — autos plus skill damage per `(cooldown + cast + interval)`, DoT totals, AoE weighted ×3 (`AOE_DPS_WEIGHT`) — inverted against the template DPS curve of the monster's own tier (trash when untiered). HP is ignored; passive/harmless monsters derive 1. Cached in a `WeakMap` keyed by a stats signature, so edits in place are picked up. Damage-only derivation is coarse (one trash damage point spans ~8 levels) and reads very high on classic hand-tuned content — acceptable only because derived levels never scale anything and are never shown.
- `suggestTierFromHp` (admin/MCP hint only, never applied): HP ÷ trash-template HP at the monster's level ≥ `TIER_HP_RATIOS` (elite 6, boss 180, raid 3000) → that tier.

## Dungeon runs

A run is floors in order and nothing else. `DungeonRunState` is `{ dungeonId, currentFloorIndex, entrance }`, shared by the entry, the save and `toSaveData`, and nothing about a run outlives it.

- **Entry.** Every entry starts at floor 1. Entry validation and item consumption run each time.
- **Floors.** A win moves to the next floor. Clearing the last one completes the run: first-clear rewards, back to the entrance room.
- **Wipe.** A wipe on any floor, boss floors included, ends the run (`handleDungeonDefeat`): "Wiped in X — driven back to the entrance.", the `eject` away moment, the `ejected` outcome, back to the entrance room. There is no second attempt.
- **Bosses.** A boss pays on the kill and nowhere else, and damage done in a lost fight pays nothing. Boss and raid tier still drive the stalemate window, default enrage and the live forecast, and the client draws the boss bar from `tier` and `passive` in full snapshots (see `client.md` → Boss fights). `DungeonFloor.isBoss` is the HUD badge only.
- **Leave** (`leaveDungeon`) ends the run and journals "Left X.", with a `run_ended` away moment when the party has other members, who may be away. The client always confirms first (`LEAVE_DUNGEON_WARNING` in `CombatFormat.ts`).
- **A member leaving, being kicked, accepting another party's invite or being banned** (`removeMember`) ends the run for the whole party. A result still in its kill beat is settled first, so the roster that fought is paid; that can itself end the run (the last floor cleared, a wipe), and then no further line is added. Otherwise every member, the one going included, gets "Your run in X has ended because the party changed." and the `run_ended` away moment "Left X when the party changed". The wording stays neutral because the cause can be any of the four. The member is then taken off the entry, and those left return to the entrance room and restart overworld combat at once, so the leaver's character is in no fight of that party. A lone player gets the ordinary "Left X." instead, and their entry is destroyed.
- **A forced relocation** (`relocateParty`, on a deploy) ends the run the same way, with "… because the world changed."
- **A content change that removes the run's dungeon or floor** ends it the same way. `endOrphanedRuns` does it at once after a deploy, a room edit or a live dungeon save or delete, so a later rollback can't bring the run back. `currentDungeonFloor` catches anything else at the next fight, and on a restart.
- **Nobody joins a standing run.** `acceptPartyInvite` refuses on `isInDungeonRun`, not on the client-facing `getDungeonRunInfo`, which reads null while the run's dungeon is missing.
- **A server restart** keeps a live run, floor index only: `PlayerSaveData.dungeonRun`, `restoreDungeonRun`, which drops a bad dungeon or floor index. The fight on that floor starts over at full boss HP. `banPlayer` saves again once the run has ended, so a crash just after a ban doesn't restore it for those left.

**Old data.** Stored and drafted floors may still carry `checkpoints`, `maxWipes` and `checkpointRewardFraction`: nothing reads them, any value validates, and they ride along through publish, deploy and admin saves without effect. Save files may still carry `dungeonCheckpoints` (never read or written back), a `dungeonRun` with `checkpointPhase`, `wipes` or `rewardedPhases` (dropped by `copyRun`), away ledgers with `checkpoint` moments or dungeon records with `checkpoint` or `wipes` (dropped by `sanitizeLedger`), and log lines typed `checkpoint` (loaded as `battle`).

## Kill mastery

`shared/src/systems/Mastery.ts`. Per-player `monsterKills: Record<monsterDefId, number>` is credited on **victory** for monsters actually dead and not passive (one `killed` list in `PartyBattleManager`; XP, gold, drops and quest credit still loop over every monster — the pre-existing "standing walls still pay rewards" bug is unchanged). Ranks by tier (`MASTERY_THRESHOLDS`, kills needed for ranks 1–5):

| Tier | R1 | R2 | R3 | R4 | R5 | Pace to R5 |
|---|---|---|---|---|---|---|
| trash | 10 | 50 | 250 | 1 500 | 10 000 | ~16 h if every kill were this monster (template pace ≈ 5.9 s per kill); spread over a zone's mix, weeks |
| elite | 5 | 20 | 75 | 300 | 1 000 | ~13 h at ≈ 47 s per elite kill |
| boss | 1 | 3 | 10 | 25 | 60 | 60 dungeon runs |
| raid | 1 | 2 | 4 | 8 | 15 | 15 raid runs (~50 min each for the dev raid) |

The Pace to R5 column is authored time: a real kill takes about `clock` times as long, and the thresholds don't scale. Each rank adds `MASTERY_BONUS_PER_RANK` (2 %) to damage dealt to that monster and removes 2 % from damage taken from it (max 10 % at rank 5), applied after the gap clamp to direct hits and DoT pulses by their source (`PartyCombatantInit.mastery`, built by `masteryRanks` with the monster's current tier; ranks ≥ 1 only). Rank-ups always write a `mastery` journal line ("Mastery rank N: Goblin (+2% against them)."); they become a recap moment only when `isMasteryMoment` allows it (trash from rank 2, every other tier from rank 1). The server sends no toast. `ClientCharacterState.mastery` is a `MasterySummary { discovered, mastered, version, recent }` (`version` = total kills); the full list comes from `request_bestiary` → `bestiary { version, entries }`. Entries carry `level` only for authored levels.

## Forecasting

Pure and synchronous in `shared/src/systems/Forecast.ts` (types in `ForecastTypes.ts`); deterministic per key (seeds come from the key via `seedFromKey`).

- **`createForecastJob(input, opts)`** → `{ done, sims, maxSims, runSims(n), advance(maxSteps), result() }`. `advance` works in single combat steps, so one long raid sim can span many slices; results are identical however the job is sliced. `runForecast` runs a job to completion. Inputs: `{kind:'room', players, table, monsters, encounters, pace?}`, `{kind:'dungeon', players, dungeon, monsters, encounters, fallbackTable?, start?, pace?}`, `{kind:'battle', state, henchmenAllowed?}` (cloned up front, never mutated, keeps the fight's own pace; `atMs` = clone point; the server passes `henchmenAllowed: false` inside a dungeon). Sims step 100 ms of engine time whatever the pace. Without `pace` a forecast plays at `AUTHORED_PACE`.
- **`simulateToEnd(state, rng, horizonMs)`** → victory / defeat / stalemate (no-progress rule, players alive) / timeout, plus boss HP share dealt, with `elapsedMs` in engine time. Horizon (`defaultHorizonMs`, absolute engine time) = earliest living enrage + 10 min, else 20 min, and at least clone point + 10 min.
- **Stats** (`summarize`): `winPct` with a Wilson 95 % `ci`; `losses` = wipes only; `stalemates` = no-progress endings plus timeouts; `medianMs`/`p90Ms` over victories only, from battle start, null below 3 wins; `killEtaMs` = median of `clone point + sim time ÷ boss share dealt` (a sim that dealt nothing counts as never). The samplers work in engine time; `result()` reports `medianMs`, `p90Ms`, `atMs` and `killEtaMs` in real ms.
- **Budgets**: `FORECAST_SIM_BUDGET` trash/elite 200, boss 40, raid 20 (by the strongest tier among possible enemies); early stop at ≥ 30 sims when the Wilson half-width ≤ 5 points or every sim agrees.
- **Rooms** are stratified by encounter-table entry: every entry first gets `FORECAST_MIN_SIMS_PER_STRATUM` (3) sims, then sims are allocated by weight, and the room never stops early before every entry has its minimum; if the budget runs out first, `ci` is widened by the unsampled share as if it could be 0–100 % (`lo × (1 − u)`, `hi × (1 − u) + u`); `winPct` is the weighted estimate; each entry gets its own rate in `strata`; `worst` is the lowest stratum with ≥ 10 % share (set only when at least 2 entries were sampled). Duplicate entries merge; empty tables fall back like `createEncounter`.
- **Dungeons**: every sim plays one fight per floor from the start floor. `winPct` = product of per-floor clear rates; `floors[].floor` = 1-based position in the floor list (as the server's "floor N of M"), never the authored `floorNumber`; `medianMs` = whole run, but the fight-length reason (`no_healer`) uses the slowest floor's median winning fight. `startFloorIndex` is the floor a party inside the run stands on, else the first.
- **Reasons** (`forecastReasons`, ≤ 3, most important first): `needs_group` (boss/raid, < 3 human players, winPct < 40; "Invite friends or hire a henchman.", but only "Invite friends." for dungeon forecasts and live fights inside a dungeon, which henchmen can't enter — `henchmenAllowed: false`), `enrage` ("They enrage at 8:00 — your party needs about 9:30"; real time, through `ForecastReasonInput.clock`), `stalemate` (≥ 20 % stalemates), `worst_encounter` (< 70 % and > 10 points under the room; its share is worded as the nearest simple fraction by `fightsShareText`, e.g. "2 in 5 fights here are Bandits: wins 41%", which the client's `worstStratumLine` reuses), `level_gap` (strongest common enemy ≥ 3 levels above the party average), `no_healer` (median fight > 60 s of engine time; per floor for dungeons), `no_interrupt`, `no_cleanse`, `outlevel` (good; winPct ≥ 90 and ≥ 5 below). Level, interrupt and cleanse hints are silent when winPct ≥ 90; no reasons with 0 sims. **Only authored levels drive level reasons** — derived levels never produce a number. Server text writes percentages without a space ("41%").
- **`partyKey(players)`**: `pk` + 14-hex digest of class, level, maxHp, damage, type, equip/set bonuses, grid, henchman flag and skill fingerprints — no usernames, order-independent. **Kill mastery is left out**: rank-ups are frequent and would otherwise invalidate every cached room, dungeon and raid forecast (and mark them stale on clients). Mastery still applies inside the sims, so a cached result can be up to the 10-min cache TTL behind a rank-up. For live battles the server passes the key of the `PartyCombatantInit` list (in-fight units already include passive bonuses).

**`ForecastService`** (`server/src/game/ForecastService.ts`, created by `GameLoop`, injected with `PartyBattleManager.setForecaster`; without it forecasts answer `unavailable` and auto-retreat/live forecasts are no-ops):

- Main-thread slicing: ≤ `FORECAST_SLICE_MS` (5 ms, `performance.now()`), then rests 3× the slice (≤ 25 % duty) and yields via `setTimeout`. Each job advances in chunks between clock checks; the chunk starts at `FORECAST_STEPS_PER_CHECK` (64) and is re-sized per job after every chunk to about an eighth of a slice at that job's measured cost per step (1–512 steps), so a slice rarely overruns whether the job is a cheap room or a raid. Logs a timing summary every 60 s while busy; `stop()` on shutdown.
- Priority lanes live > explicit > pre-check, round-robin within a lane. Queued jobs dedupe by key (a higher-priority request promotes). ≤ 512 queued (the oldest lowest-priority job is dropped, its listeners get `null`). Supersede groups: one live job per party and one explicit job per player; a newer request drops the older one — its requester gets `unavailable` for that target — unless another requester or a pre-check still wants the job, which then keeps running (at pre-check priority when no group is left). Live jobs are also withdrawn when their fight ends (victory, defeat, escape, retreat), a new battle starts, or the party is destroyed.
- LRU cache of 5 000 results, 10-min TTL; live results are never cached. `allowRequest`: 20 requests/min/player (sliding; counts denied and cached requests too).
- Keys: `roomForecastKey` = `GAME_VERSION|contentEpoch|partyKey|room:<tileId>`, `dungeonForecastKey` = `…|dungeon:<id>:<floorIdx>`, `liveForecastKey` = `battle:<id>:<elapsedMs>`. `ContentStore.contentEpoch` bumps at the top of `save()`, in `load()` and `replaceAll()`; the 30 s periodic `GameLoop.saveAll` calls `persist()` (write without bump) so caches don't go stale every 30 s.
- **Protocol**: `request_forecast { target }` (room or dungeon) → `forecast { target, key, result, status }` to the requesting socket, always echoing the target. Checks, in order: rate limit → `unavailable`; a room must be on the party's current map, exist, and be unlocked for the requester, a dungeon must exist with an unlocked entrance, else `denied`; cache hit → `ok`; else `pending` then `ok` (or `unavailable` if dropped). Dungeon forecasts start from the party's own run when inside it, else floor 0; the fallback table is the entrance zone's. Malformed targets get an `error`.
- **Live battle forecasts** (display only): queued at the start of fights with an elite/boss/raid monster, only while a member has a combat-view socket, and sent only to combat-view sockets (`CombatDelivery.isWatching`/`sendRaw`); `pending` is pushed first, then `ok` as `{kind:'battle', battleId}`. Re-forecast on a player `death`, debounced by `LIVE_FORECAST_DEBOUNCE_MS` (3 s, cleared in `destroyEntry`). Results are discarded unless the battle id still matches, the timer is live and the fight is unfinished. The party keeps the latest result and any running job per battle (`liveForecastResync`): a socket that starts showing the fight mid-way — `combat_view` turning on, login, `request_state` — gets them right after its combat resync, or a newly queued job when there is neither (a fight entered from the map, e.g. a dungeon entry, starts with nobody watching).
- `GamePartyInfo.forecastKey` (the party key) lets clients mark results stale. Side-effect-free inputs: `buildPartyCombatants(partyId)` (skips members without a character) and `resolveEncounterTable(tileId, zoneId?)` (room table, else zone, else `[]`); `createCombatForParty` records which table entry it rolled by replaying `createEncounter`'s first draw (no extra random call).
- Cost: seed rooms 2–70 ms per forecast; a boss room with 30 sims ~100 ms; the dev raid dungeon ~3.2 s CPU (13–22 s wall at 25 % duty). Measured with 100 dev bots: < 1 % CPU, no measurable event-loop stall.

## Auto-retreat

Overworld only — dungeons never auto-retreat. Per-player `combatPrefs.autoRetreatBelowPct` ∈ `AUTO_RETREAT_OPTIONS` (0 = off, 25, 40, 60), **default 25** for new and existing characters (`DEFAULT_COMBAT_PREFS`, `sanitizeCombatPrefs`), set with `set_combat_prefs` (invalid values → error). The **party owner's** setting applies, read at use time; `GamePartyInfo.autoRetreat = { belowPct, setBy }`. Pure rules in `server/src/game/AutoRetreat.ts`; wiring in `PartyBattleManager`.

- **Input**: the party's cached **room** forecast, or a pre-check queued at battle start. A result that lands while the same fight (same room, same party key) is still undecided is applied to it; one landing on a finished/settled fight, or after the party is gone, does nothing. No result → nothing happens this fight.
- **Every trigger needs the Wilson upper bound below the threshold** (`decideAutoRetreat`). **Skip**: the rolled entry's upper bound (`stratumUpperPct`, n = share × sims) is below → the fight ends as a retreat in place once real elapsed time ≥ `RUN_AVAILABLE_MS`, and the room re-rolls. Journal "Avoided X (win chance N%)". **Relocate**: the whole room's upper bound is below, or this would be the 3rd skip in the last 10 overworld battles (`AUTO_RETREAT_SKIPS_TO_RELOCATE` / `AUTO_RETREAT_SKIP_WINDOW`). **Unknown**: the forecast has no rate for the rolled entry (it ran out of budget before sampling it, see Rooms above) or no sims — the fight is neither skipped nor counted as a safe one: it gives up its slot in the skip window, so it can't push earlier skips out.
- **Target** (`pickRetreatTarget`): only a room whose cached forecast is **known** to clear the threshold — `ServerParty.previousTile` if it does, else the candidate with the best cached `winPct`. Candidates = same grid, adjacent, traversable, unlocked for some member, passing `checkRoomEntry`. `previousTile` is set only by a non-retreat `moveToNextTile` and cleared by `relocateTo` (so `exitDungeon`), `switchMap`, and after a retreat step. `retreatTo(tile)` replaces the route (a queued route becomes a recap `routeStopped`). Journal "Auto-retreat moved your party from A to B — A was too dangerous (win chance N%)", or "… from A to B (lost-cause fights kept coming up)" when the 3-skips rule triggered it.
- **Unknown neighbours**: when no candidate is known safe but some have no cached forecast, pre-check forecasts are queued for them and the relocation waits — this fight is skipped in place instead, and the next fight decides again — so the party never walks into an equally deadly room it knows nothing about.
- **No target** (every candidate known to be below the threshold, or none can be forecast): "Nowhere safer to retreat from A — fighting on", and a hold. The line is not written again while it is still the member's latest retreat journal line, so a hold lost to a restart (or re-decided after a roster or setting change) doesn't repeat it.
- **Hold** (`retreatHold`, in memory): set after a relocation (on the target room) or "nowhere safer"; blocks skips too. Cleared by a player move (`handleMove`), `addMember`/`removeMember`/`restartBattle` (henchman hire/dismiss, class change), or the owner changing `combatPrefs`; lapses once the party leaves that room. The skip history resets with it. This is what stops retreat loops.
- **Timer contract** (`ServerBattleTimer`): `isFighting(battleId)`; `retreat(battleId, reason)` is a no-op unless the battle is current, live, undecided (no pending result) and real elapsed time ≥ 5 s; it then sets `finished`, `result = 'retreat'`, emits `battle_end {result:'retreat'}` + the log line, calls `onRetreat(battleId)` (where PBM sets the route and writes the journal), flushes `dynamic`, sets visual `'retreat'` and continues through the result-screen tail (walks on after `RESULT_PAUSE`, or re-fights in place after `RESULT_PAUSE + MOVE_DURATION`). `scheduleRetreat(battleId, delayMs, reason)` uses a `retreatTimeout` cleared by `clearTimers()` and re-arms if it fires a step early. `onBattleEnd`/`handleBattleEnd` never see a retreat.
- **Recap and notification**: `recordRetreat` for every member (a relocation is also a recap moment). On each member's first-ever trigger, an in-app `auto_retreat` notification ("Auto-retreat kept your party out of a losing fight. Change it in Options."), tracked by the persisted `autoRetreatNotified` (see `notifications.md`).
- Dev bots use the default 25 % like everyone else.

## While you were away (recap)

Types and pure helpers in `shared/src/systems/AwayTypes.ts`; lifecycle in `PlayerSession` and `PlayerManager`.

- **Presence**: the client sends `presence { visible }` on every socket open and every `visibilitychange` (separate from `combat_view`). `PlayerManager.setPresence` tracks hidden sockets; a socket that never sent one counts as visible. Away **begins** the moment no socket shows the game (all hidden or the last one closed) → `beginAway` opens an `AwayLedger` (characterless players get none); it **ends** when any socket is visible → `endAway`. The ledger becomes (or folds into) `pendingRecap` only if `isAwayLedgerWorthRecap` (away ≥ `AWAY_MIN_MS` 5 min and battles + retreats > 0); otherwise it is dropped. A later absence merged into an unacknowledged recap takes the newer ledger's id, so a stale `ack_recap` can't clear content the player hasn't seen. Presence is refreshed on login, socket close, each `presence`, and after a master reset.
- **Ledger** (`AwayLedger`): battles/wins/losses/retreats/skips, xp, gold, level and XP-fraction from/to, item counts by rarity, `notableItems` (rare and above, rarest first, ≤ 6), `itemsLost`, total `kills`, `masteryUps` (merged per monster), `dungeons` (≤ 10; an in-progress run is updated, not duplicated), `retreatLog` (≤ 10), `routeStopped`, `closestCall` (lowest party HP of a victory; a new low ≤ 20 % is also a moment), `moments` (≤ 12). It is filled only from combat paths — victories (using `addGold`'s return; failed inventory adds count as lost), defeats, dungeon rewards/first clears/ejects/runs ended, retreats, mastery rank-ups, level-ups, rare finds, close calls — never from generic grant helpers.
- **Moments** priority (`AWAY_MOMENT_PRIORITY`): level_up 7 > first_clear 6 > rare_item 5 > eject = run_ended 4 > relocate 3 > mastery 2 > closest_call 1. At the cap the lowest priority (oldest among equals) is evicted; `topAwayMoments` picks the headline.
- **Delivery**: `ServerStateMessage.awayRecap` + `awayRecapItemDefinitions` ride on every state until `ack_recap { id }` with the matching id clears it and pushes state to all sockets. `awayRecapStyle`: away < 30 min (`AWAY_TOAST_MAX_MS`) with no moment of eject priority or higher → toast, else modal (see `client.md`).

## Templates and calibration

`shared/src/systems/MonsterTemplates.ts` — `suggestMonsterStats(level, tier, role?)` → `{ hp, damage, attackInterval, xp, goldMin, goldMax }` for an on-level monster. Used by the admin "Suggest stats" button, MCP `get_content_schema` and the dev world. Templates are in authored time and authored rewards: the pace stretches them afterwards, so an 80 s boss fight takes about 144 s real and pays `rewardMultiplier` times its `xp`.

- Frozen class averages (a class rebalance must not re-level monsters): HP `19.2 + 2(L−1)`, damage `7 + 1.4(L−1)`.
- Trash: HP = 5.8 × class-average damage, DPS = 0.04 × class-average HP, attack interval 1.5 s — fight length stays level-independent. The template is bound by the glass-cannon classes (Archer/Mage must survive two monsters while needing ≥ 2 hits each). Elite: HP × 8, DPS × 3, interval 2 s.
- Boss/raid HP = `referencePartyDps(L)` × 80 s / 2 700 s, where `REFERENCE_PARTY_STEADY_DPS` is the measured steady DPS of `REFERENCE_PARTY` (one of each class, default loadouts, starter gear): 148 at L1, 583 at L25, 1 428 at L40, 3 609 at L100. Boss/raid DPS = trash DPS × (29 + 1.1L) / (25 + 1.1L). Templates size **autos only** — adding AoE skills on top moves a boss toward its cliff.
- Roles: bruiser {HP ×1.2, DPS ×0.8, 2.2 s}, caster {×0.9, ×1.1, 1.8 s}, skirmisher {×0.9, ×1.05, 1 s}.
- XP per kill = `XP_INCOME_MODEL(L)` (57 600/day at L1 solo → 557 000/day at L10 in a party, doubling every 10 levels) ÷ 86 400 × member-seconds per kill (trash (10 + 1.8)/2, elite × 8, boss 80 × 5, raid 2 700 × 5) × tier bonus (1 / 1.25 / 1.5 / 1.5). Gold ≈ 0.4 × XP ± 30 %. The fight part of those seconds stretches by `clock` in play and `rewardMultiplier` pays for it; the pause between fights doesn't stretch, so short fights earn a little over the model.

**Calibration** (real engine at `AUTHORED_PACE`, starter gear ATK 3–10 / DR 1–8, default loadouts; N = 200 per cell). These were not re-measured at `COMBAT_PACE`: times below are authored, and added cast time and bigger, rarer hits can move the results. They also predate seed charge and recovery, which let a skill and Attack share an action gap, so seed fights now run shorter (at `COMBAT_PACE`, K+P+M against the Goblin Chieftain went from a median 8.9 to 6.3 min, the 5-class party from 2.6 to 2 min):

| Scenario | Result |
|---|---|
| Solo on-level vs 2 trash, L10–60 | Knight/Priest/Archer/Mage 100 % (Knight 15–16 s, Priest 10–15 s; Archer/Mage need 2.3–3.5 hits per kill); Bard 100 % vs a single monster |
| Party of 3 (K+P+M) vs 6 trash | 100 %, 5–9 s |
| +5 levels, party of 3 | 100 % |
| 10 levels below | 100 %, 38–67 % of on-level duration, damage taken > 0 |
| Knight L30 vs on-level trash | 60 % mitigation, minimum hit 2 |
| XP/h 10 levels below (authored) | 22–57 % of on-level |
| Best vs worst default party, steady boss DPS at L40 | 3.42× |
| Goblin Chieftain, K+P+M at L6 | median 4.9 min, 100 % (also at HP/damage ±10 %); 5-class party 1.5 min |
| Goblin Chieftain, any class solo at L6 | 0 % single attempt and whole run |
| Dev raid, party of 5 at L25 | median 50 min; win rate not re-measured since retries were removed |
| Priest solo | 0 stalemates in 3 400 fights |

**Known class disparity — accepted.** Level scaling does not equalise the classes: the shared trash template sits at ~26–31 % of a Knight's own win-rate cliff, 15–20 % of a Priest's, ~58 % of a Mage's and 70–88 % of an Archer's. Fights are near-deterministic, so each class drops from 100 % to 0 % over a narrow strength band: at +3 levels solo Knights and Priests still win 100 % while Archers win 13–42 % and Bards 0 %; at +5 Archers/Mages mostly lose. No single gap setting fixes this; it needs class-dependent content or class-curve changes. The 10-levels-below duration floor is a timing limit (with 1 s actions a 6 s fight can only drop to 4 s).

**Known quirks.**

- **Win rate is not monotonic in monster strength.** Party of 3 at L60 vs 6 trash: damage 67 → defeat in 8.5 s, damage 69 → victory in 150 s (the Mage dying early re-targets monsters onto the Knight and frees the Priest's heals). Nothing may bisect on strength assuming monotonicity.
- **The Goblin Chieftain is a tank-and-healer check**: Knight+Archer+Mage and Priest+Archer+Mage clear 0 % at L6–8. At `COMBAT_PACE` on today's seed skills a Knight+Priest duo wins the Chieftain's floor in one attempt at L6 with starter gear (forecast, N = 200: 100 %, median 17.5 min).
- **Standing walls still pay rewards** (pre-existing): XP, gold, drops and quest credit loop over every monster in the fight, including passive walls left standing; only mastery and recap kill counts use the killed list.
- Templates assume starter gear: a naked L10 Knight/Priest takes 23–24 s vs the typical pack; naked L1 Priests and Bards struggle in the seed zones (unchanged from before).

## Combat invariants

These are subtle rules that drive defensive interactions. Read carefully before touching the combat engine.

### Held, not wasted

An action skill that would do nothing is **held** (no cooldown, next skill or auto-attack instead) — Minor Heal at full party HP, Cure with nothing to cure, Sanctuary with everyone shielded. Only a skill that passed the needed check but no-op'd at execution (RNG, e.g. Drumroll landing no stuns) fizzles, which rewinds Arcane Surge's `activeSkillCount`. A no-cast skill with neither charge nor recovery then falls through to an auto-attack in the same action. Any other fizzle has no fallback.

### DoT resistance rule

All DoTs apply resistance at **pulse time**, not at application time. The `damagePerTick` value stored on a `DotEffect` is the raw pre-resistance damage; the status pulse (`pulseMonster` / `pulsePlayer`) applies the full [scaling](#level-relative-scaling) — monster resistance rating/percent, or the player's rating and set resist %, plus the level gap and mastery of the DoT's source — every pulse (player DoTs per pulse group). This honors mid-fight changes and keeps every DoT consistent — no DoT bakes resistance into its stored damage. A monster's enrage multiplies the DoTs it applies.

### Mage Ignite (permanent stacking DoT)

Unlike other DoTs, Ignite stacks last for the rest of combat. Each single-target hit adds a stack worth `25% of pre-MR damage` per pulse (captured at the top of `applyDamageToMonster`). Implemented via `DotEffect.permanent` (never decremented). Resistance is still applied at pulse time per the rule above — so against high-MR enemies individual stacks tick for very little, but they accumulate over long fights, up to `round(IGNITE_MAX_STACKS / kit)` per (Mage, target), which is 8 at kit 1; at the cap a new stack replaces the weakest one (its `status` event fires only when a stack is actually added).

### Monster hit pipeline

Every direct monster hit on a player goes through `applyMonsterDirectDamage` in this exact order: (1) mitigation (`mitigateHitOnPlayer`: gap × mastery × rating mitigation × set resist %, min 1), shield absorb (`absorb`), HP loss (`damage`); (2) Shield Bash — physical hit, attacker alive, even at 0 damage → stun the attacker; (3) Martyr — Knight victim, damage > 0; (4) HP 0 → Resurrection check (`revive`) else `death`; (5) victim alive and damage > 0 → raise `self_hit`. A reactor that died at (4) never reacts. For single-target attacks `ally_targeted` (Intercept) is raised after targeting and before dodge, so Intercept runs before any of the above.

### Monster skill direct damage

All direct-damage monster skills (Fireball AoE, Assassinate single-target) use the same pipeline as a normal monster attack: damage-type reductions, damage shields, Shield Bash retaliation, Martyr, resurrection and `self_hit` (Shield Slam). **Nimble dodge** applies to any direct-damage skill — for AoE, each player rolls dodge independently. **Intercept** redirects single-target skills the same way it redirects normal attacks. Stuns and DoT applications are not "direct damage" and bypass dodge.

### Shield Slam / Shield Bash physical-only rule

Knight Shield Slam (`brace_reflect`) only reflects *physical* hits, per hit, as they land; magical and holy hits never reflect. Knight Shield Bash (`stun_on_phys_hit`) only triggers from physical hits. This keeps Knight's reactive defenses paired with physical attackers and avoids reflecting magical fireballs as physical damage.

### Martyr trigger rule

Any damage to a Knight (direct attack, AoE skill, single-target skill, or DoT pulse) queues a Priest Martyr heal-bonus stack via `triggerMartyr`. The bonus is **capped at a single stack between heals** — multiple damage events do not stack the bonus. Each Priest with Martyr equipped gets their own stack independently; the next heal that Priest casts consumes their stack.

### Stun rules

A stun never stacks (refreshes to the longer of current and new), freezes the victim's action timer, cooldowns and cast, interrupts a casting monster, pauses a casting player, and is resisted at application by Iron Will. Stunned units still take DoT/HoT pulses.

## Events and snapshots

Each step emits timestamped `CombatEvent`s (`id` monotonic per battle via `state.nextEventId`, `t` = `elapsedMs` in real ms, `durationMs` real too): `battle_start`, `battle_end`, `attack` (animation trigger; `skill`/`skillId` when a skill, `skillId` alone on a use of an Attack skill), `damage` (`dmgType`, `crit`, `overTime`), `heal`, `dodge`, `absorb`, `shield`, `stun`, `resist`, `cast_start` (`nextActionMs`, see [Casts](#casts)), `cast_end`, `interrupt` (`countered` when an instant countered the cast, absent when a stun cancelled it), `reaction` (`cardType`, always `instant`), `redirect`, `status` (a named status gained — Bleed, Ignite, Sunder, Crippling Shot, Lullaby, Scorch, Chaos, Rot, War Song), `cleanse`, `death`, `revive`, `buff`, `fizzle`, `enrage` (`amount` = stacks).

A turn-taking use of a skill with charge and recovery also carries `recoveryMs`: on `attack`, or on `cast_end` for a cast. A `reaction` never does.

`buildClientCombatSnapshot(state, battleId, full)` produces a `ClientCombatSnapshot` of every unit, with every time converted to real ms: `hp`, `maxHp` (always), `shield`, stun remaining/total, `actionMs`/`actionTotalMs`, `recoveryMs`/`recoveryTotalMs` (while recovering; for a player with an Attack skill `actionMs` is `nextActionWaitMs`, and `actionTotalMs` the wait measured at their last action, raised and kept if the next action has since moved further away, so the ring runs down from it), `cast` (`paused` when a stunned player is casting), `statuses`, and for real players (not henchmen) `skills` in slot order, then the Attack skill, with `remainingMs`, `cooldownMs` and a derived `state` — `casting` if casting it, `cooldown` if time remains, `armed` for a trigger skill, `held` if the needed check fails, else `ready`. Static fields (names, monster `id`, `className`, `henchman`, `passive`, `description`, `actionIntervalMs` — the normal action interval, players and non-passive monsters only — equipped `passives`, skill `name`/`cardType`/`trigger`/`castTimeMs`/`baseCooldownMs`/`useCooldownMs` (the last two: the cooldown a use starts, before and after cooldown reduction), `chargeMs`/`recoveryMs` on a skill with them (`recoveryMs` is 0 on an instant), player `level`, monster `level`/`levelSource`/`tier`) are included only when `full`. Every snapshot carries `enrage { atMs, stacks, stepMs, stepPercent, maxStacks }` on monsters that have a clock.

## Server battle loop

### Battle state machine

`ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). The loop runs in real time; only the engine inside it is in authored time. Each party's loop runs continuously: `battle` → finish → `KILL_BEAT_MS` (800 ms, the killing blow stays on screen) → `result` (`RESULT_PAUSE` = 600 ms) → move (`MOVE_DURATION` = 400 ms) or stay → next `battle`. Rewards are granted when the kill beat ends, before the move check, so rooms unlocked by a victory are walkable that cycle. Movement happens instantly at the start of the move window; the client animates the tween.

- The timer steps the engine every `combatRealStepMs` of real time with a fixed dt of `COMBAT_STEP_MS`, so it is deterministic under fake timers. Battle duration, Run and retreat gating and the flush and snapshot cadence all use real time (`combatRealElapsedMs`).
- `battleId` comes from one process-wide counter (seeded from `Date.now()`) and changes on every `triggerBattle`, including restarts and escapes.
- The constructor never starts a battle. `start()` is idempotent; `restartBattle()` on a never-started timer acts as `start()`; `destroy()` is valid at any time. `PartyBattleManager.createEntry` starts the timer, `createEntryFromSave` does not — `PlayerManager` calls `startEntry` only after members, the dungeon run and henchmen are restored.
- `settlePendingResult()` grants a finished-but-unshown result immediately (no move) and marks it settled; the kill beat then skips the grant. `PartyBattleManager` calls it before `restartBattle`, `enterDungeon`, `leaveDungeon`, `enterTransition`, `relocateParty`, `endOrphanedRuns`, `destroyEntry`, `addMember` (so a joiner takes no share of a win they did not fight), `removeMember` (before the member is deleted, so a leaver who fought is paid) and, through `PlayerManager`, any henchman hire or dismissal, so a fight won during its kill beat is always paid exactly once.
- **Failure guard**: every timer callback and `triggerBattle` run inside one guard. On a throw it logs once per battleId, clears timers, sets combat to null / state `result` / visual `none`, broadcasts, and retries after `min(30 s, 1 s × 2^n)` (n = consecutive failures, reset after a normal finish). A throw inside the reward grant is never retried, so rewards are never granted twice. A destroyed timer's callbacks return immediately.
- **Run** is available `RUN_AVAILABLE_MS` (5 s real, whatever the pace) into a fight: `canEscape()` gates `escapeBattle()`, and the `run` handler answers "Run becomes available 5 seconds into a fight" before that. Run is not available inside a dungeon.

### Combat message protocol

State pushes (`type: 'state'`) no longer happen per tick — only on battle start, result, move and non-combat triggers, and each leaves out what the socket already holds (see `client.md` → WebSocket data use). Live combat streams separately:

- `ServerCombatMessage { type: 'combat', battleId, snapshot?, events, log }`. Every time in it is real ms. The timer batches events and log lines and flushes on the step nearest `COMBAT_SEND_MS` (200 ms) of real time since the last flush, immediately on start (full snapshot) and on finish (dynamic snapshot + `battle_end`). It takes the nearest step because rounding up would hold events past the client's playback delay. A dynamic snapshot is attached when ≥ `COMBAT_SNAPSHOT_MS` (500 ms) has passed since the last one. At the current pace that means every 180 ms step that has something to send, with a dynamic snapshot every 540 ms; at `AUTHORED_PACE` it's still 200 ms and about 600 ms. A boundary with nothing to say sends nothing.
- `PartyBattleManager.deliverCombat` serialises each flush once per party and skips building/stringifying entirely when no member has a socket showing combat (`setCombatDelivery({ isOnline, sendRaw })`, wired by `PlayerManager`), so offline parties and dev bots cost almost nothing.
- **Visibility gating**: each socket has a combat-view flag (visible by default). The client sends `combat_view {visible}` from `CombatScreen` activation and tab visibility; `PlayerManager.sendCombatRaw` sends only to open, visible sockets, and skips non-full messages on sockets with more than 256 KB buffered.
- **Resync**: after the initial state on login, after every `request_state`, and when a socket flips back to visible, that socket gets one combat message with a **full** snapshot, `events: []`, and `log` = the timer's ring of the last 30 live lines (cleared each battle). The ring holds only lines already streamed: `buildCombatResync` first calls `ServerBattleTimer.flushPending()`, which streams any queued events and lines to the party, so the snapshot, the ring and the stream agree. Nothing is sent between battles.
- `ServerBattleState.combat` (in state pushes) is always a full snapshot.

## Journal vs live log

`PlayerSession` keeps a **journal** of the last 1000 entries (victory/defeat, rewards, level-ups, moves, unlocks, departures, server notices) with a running `battleCount`; saves keep 1000 and each state message carries only the last `STATE_LOG_TAIL` (100). Per-hit engine lines are **not** journaled — they exist only as the `log` field of combat messages (plus the timer's 30-line resync ring). "Battle begins!" is no longer logged; the battle count still increments. The client merges both streams into one buffer (see `client.md` → Combat screen).

## Dungeon combat mode

A party inside a dungeon reuses this exact loop — the only differences are driven by `PartyBattleManager` reading the entry's `dungeonRun`: encounters come from the current floor's `encounterTable` (not the tile), victory advances the floor / completes the run rather than unlocking neighbours, and a wipe ends the run and returns the party to the entrance instead of fighting on in place (see [Dungeon runs](#dungeon-runs)). Auto-retreat never acts in a dungeon. Because the party has no destination inside a dungeon, the loop just re-triggers combat on the same floor until it's cleared. See `docs/architecture/content.md` → Dungeon system for the full lifecycle.

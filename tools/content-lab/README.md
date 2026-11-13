# Content lab

Measures a content snapshot against the combat engine of this tree, at `COMBAT_PACE`, and against the engine of an older commit, using each version's real functions. It is content-agnostic: it reads the snapshot given on the command line and holds no content of its own.

**The repository is public.** Snapshots and everything derived from them stay in `data/` (gitignored). Never commit live monster, zone or item names or ids, or numbers measured from live content, under `tools/` or in docs.

## Running

```bash
# Bundle the old engine once
git archive origin/main shared | tar -x -C <scratch>/old-engine
node_modules/.bin/esbuild <scratch>/old-engine/shared/src/index.ts --bundle --format=esm --platform=node --outfile=<scratch>/old-engine/old-engine.mjs

npm run content:lab -- run --snapshot data/live-export/content.json --old-bundle <scratch>/old-engine/old-engine.mjs --old-ref <commit> --out data/content-lab --n 60 --variant-n 30
npm run content:lab -- sanity --old-bundle <path>   # sanity checks only
npm run content:lab -- report --out data/content-lab # re-render compare.md from the baselines
npm run content:lab -- rework    # snapshot + data/content-lab/rework-config.json > reworked.json, changelog.md
npm run content:lab -- measure --snapshot data/content-lab/reworked.json --n 200 --variant-n 60   # > measured.json
npm run content:lab -- scorecard # measured.json against baseline-old.json > scorecard.md
npm run content:lab -- fit --modes hp,xp,gold,drop,enrage,damage [--monster-outliers true --damp 0.7 --outlier-threshold 0.12 --hp-lost-target 15 --enrage-factor 1.25]
npm run content:lab -- sweep --mode subsets,seats,dungeons,builds,effects --engine old|new --snapshot <file> [--old-bundle <path>] [--scenarios <file>]   # > sweep-<mode>-<engine>.json
npm run content:lab -- install [--snapshot <file>] [--data server/data]   # load reworked.json into a dev server's data folder for a local playtest
npx vitest run --root tools/content-lab
```

Other flags: `--seed`, `--jobs` (shards; results don't depend on it), `--engine old|new`, `--limit-zones N` (per region, for a smoke test).

Output: `baseline-old.json`, `baseline-new.json` (`meta` holds the policies, the gear table and the loadouts), `sanity.json`, `compare.md`.

## What a cell is

One party in one place at one level with one gear policy. Places: every zone's table, every distinct room-level table (rooms in the same zone sharing one count once), every dungeon floor. Whole-dungeon runs are composed from the floors' fights, since HP resets between fights.

Compositions: solo for each class, K+P, K+P+M, K+A+P+M+B, and solo plus hires. Dungeon rules go through the real `validateDungeonEntry` (the required item is assumed owned); a party that may not enter is reported as ineligible. Hires wait at dungeon entrances, so solo-plus-hires is ineligible on every floor.

Zones also get low-level, high-level and ungeared variants for the core compositions at `--variant-n`.

## Policies

- **Region**: a world map. Regions are ordered by the median midpoint of their zones' level ranges; a zone belongs to the map holding most of its rooms.
- **Level**: zone range midpoint (rounded); dungeons use the entrance zone's midpoint, clamped to their min and max level.
- **Gear** (`CLASS_GEAR_WEIGHTS`): for each class and slot, the highest weighted average of attack, DR and MR among items sold on the same map; a slot no shop there sells keeps the previous region's pick. A two-hander wins when it scores at least mainhand + offhand. Prices are ignored. Set bonuses flow through the real set code but the picks don't chase sets. Ungeared means empty equipment, the state a new character starts in.
- **Skills** (`LOADOUT_PRIORITY`): slots come from the class's slot schedule at that level; each slot takes the next unlocked skill by effect-kind priority, newer unlock first within a kind. Grant-only skills (`unlockLevel: null`) never qualify. A slot with nothing left stays empty, as does any slot whose only candidates are on the `avoid` list.
- **Grid** (`CLASS_SEATS`): solo stands front-centre; parties take class seat preferences, tanks in the front column, Knight/Mage/Priest along the middle row.
- **Hires** (`HIRE_ROLES`): up to two hires offered on the same map, completing a tank, healer and damage trio. A tank is a Knight, or a Priest hire carrying a physical-reduction skill. The highest level at or below the party, else the lowest above. Each hire counts as a body for the XP share, and takes a coin share that is lost.
- **Sims**: stratified by table entry, `max(3, round(N × share))` per entry, statistics weighted by share. Seed = FNV-1a of base seed, cell id, entry id and sim index, fed to mulberry32. The old engine reads `Math.random`, which the adapter swaps for the seeded stream during a fight.
- **Pace**: new-engine fights play at `COMBAT_PACE`, so fight times are real time and XP and gold include `rewardMultiplier`, as in the game. `SPEED_TARGET` (old fight length over new, `fit.ts`) is the agreed authored ratio divided by the clock. Forecasts run at it too. Fitted enrage clocks are divided by the clock, and fitted drop chances by `rewardMultiplier`, since the game applies those itself.
- **Rates**: XP/h = E[XP per fight, 0 on anything but a win] ÷ E[fight time + pause] × 3600, per human member. Pause comes from each version's timer: old = 1 s kill delay + `RESULT_PAUSE` + `MOVE_DURATION`; new = `KILL_BEAT_MS` + `RESULT_PAUSE` + `MOVE_DURATION`.
- **Stalemate**: new = the engine's no-progress rule, or still running after 2 h of engine time. The old engine has no such rule, so 600 ticks without a new low in monster HP, or still running after 2 h, counts as one (in the live game such a party would fight on forever).
- **Not modelled**: auto-retreat, kill mastery (zero kills), first-clear rewards, item drops (so `paceDropChance` too).

Combatants are built like `PlayerSession.getCombatInfo` and `buildHenchmanCombatant` on the matching version, and rewards pay like `PartyBattleManager`: XP through the game's `fightXp`, coin split per body.

## Rework

`rework.ts` is a pure function, snapshot + config > snapshot + changelog, written to run again on a newer export. The config holds every number and every override; it lives in `data/content-lab/rework-config.json` because it names live content. What the function does:

- **Monsters** referenced by any encounter table get `level` (their earliest usage), `tier` (boss on boss floors and for capstones placed only by rooms or floors, elite above the band's HP ratio) and `attackInterval` by role. `damage` factors are per second, so a slower monster hits harder for the same DPS. HP, XP and gold scale by global x region x monster factors. Passive walls gain HP and scale their drops; they get no level, tier or interval.
- **Monster skills** follow `monsterSkills`: a factor per skill id, or the global x region damage factor, never the per-monster damage factor (a cast is not DPS, and a telegraph that costs nothing is pointless). Monster heals keep their value unless a monster has its own factor or `healFollowsHp` is on.
- **Gold** can't scale smoothly at low levels: rolls are whole numbers and each member's share rounds up. `fit --modes gold` searches each monster's roll against the old rate and stores `goldRanges`. A roll never pays more than authored, and only an ordinary monster paying under 3 may drop to nothing.
- **Drops** scale by the kill-rate ratio, except chances of 0.5 and up. Quest-collect drops scale too, so collecting keeps its time cost, down to `questDropFloor`.
- **Items** and set bonuses scale DR and MR into rating. `weaponAtkByClass` scales weapons only those classes can equip; shared items and percent bonuses stay.
- **Skills** adopt the seed's `castTime`, `warmup` and `trigger`; rating passives adopt `ratingValuePerLevel`; grant-only variants follow the leveled skill with the same class, type and effect kind. `skills` patches the rest.
- **Boss floors**: `fit --modes enrage` sets `enrage`: for a trial boss, the slowest eligible full-size party with a tank and a healer (a duo counts as under-built only where more than two may enter); for an open-world capstone, the slowest winner of any party size, plus what hires took on the old engine over the speed target. `enrageSteps` steepens only bosses on boss floors.
- **Text**: `text` replaces descriptions by id, recipes included. `staleDescriptions` lists any in any section that still say round, turn or tick; expect false positives ("turns up"). It can't catch a claim that is merely false, such as text saying a skill stops a hit it now only halves: check those against a measured fight.

Nothing is added or removed, and no id changes. Zones, encounters, world, shops, NPCs and tile types pass through; quests and recipes only for a replaced description.

A pass: `fit` (from the last `measured.json`), `rework`, `measure`, `scorecard`. Fit HP and XP first, then gold, drops and enrage against the settled fight times. Win rate isn't monotonic in monster strength, so measure rather than assume.


## Sweeps

The core compositions don't cover what parties in the game actually do. `sweep` fills that in, and `scorecard` adds what it finds:

- `subsets`: all 31 class combinations in every zone, which shows who a party without the textbook roles leaves behind.
- `seats`: an unadjusted K+P+M on the seats the game hands out (leader in the centre, the rest in the first free seats), once per leader.
- `dungeons`: every class combination each door admits, at the entry level and the zone's level. Composed clears on both engines, the real `runForecast` on the new one. `fit --modes enrage` reads this file.
- `builds`: hand-written parties from a scenarios file (`data/content-lab/scenarios.json`, default `--scenarios`): grant items, swapped skills, chosen seats. Use it for what a trial's own text tells players to bring, which default loadouts never try.
- `effects`, new engine only: every boss fight as authored, with enrage off and with monster skills off, so you can tell whether either changes anything.

Old-engine sweeps of an unchanged export don't change between passes. Reuse them.

## Keeping it repeatable

Factors multiply, so `rework` refuses a snapshot that already carries the rework (most referenced monsters have `tier` and `attackInterval`): run it on a pre-rework export. `--force true` compounds on purpose.

The tool's tests and types aren't part of `npm test` or `npm run typecheck`: run `npx vitest run --root tools/content-lab` by hand. `tsx` and `vitest` come from the workspaces, `esbuild` is needed only to bundle the old engine.

## XP lab (`xp/`)

Measures XP rules against simulated fights. Combat is expensive and an XP rule is a pure function of what happened, so `xp/` simulates each party once into a **fight atlas** and evaluates any number of **plans** offline against the same rows. A plan that changes combat itself needs its own atlas from its own snapshot.

```bash
# Merge skills from a server data folder into an export (skip for an export as is)
npx tsx tools/content-lab/xp/cli.ts snapshot --base <export.json> --skills <skills.json> --slots <skill-slots.json> --out <snapshot.json>
# Compare the export with a monster audit and a data folder
npx tsx tools/content-lab/xp/cli.ts check-content --base <export.json> --audit <audit.md> --data <data folder> --out <report.md>
# Change anything in a snapshot with a module exporting rework(snapshot); writes the new snapshot and <out>.changes.md, counts per section and field. The module can live anywhere, and must live outside tools/ if it names live content
npx tsx tools/content-lab/xp/cli.ts rework --snapshot <in.json> --rework <module.ts> --out <snapshot.json>
# Simulate, then sample the near-line cells again. --plan-only just counts the cells; --limit-tables, --fights and --refine-fights make a smoke run; --refine-fights 0 skips the second pass
npx tsx tools/content-lab/xp/cli.ts atlas --snapshot <snapshot.json> --out <atlas dir> --jobs <threads> [--families core,extended,carry,stall,seating,hired] [--fights 24] [--refine-fights 400] [--limit-tables N] [--seed N] [--engine-ref <commit>] [--plan-only]
# Evaluate a plan and write its scorecard, summary, per-cell rates and curve to <out dir>. --topup-fights 0 skips re-sampling the verdicts' picks, for a quick sweep
npx tsx tools/content-lab/xp/cli.ts run-plan --atlas <atlas dir> --plan tools/content-lab/xp/plans/baseline.ts --out <out dir> --jobs <threads> [--param key=value]... [--baseline-curve <baseline out dir>/curve.json] [--active-hours 2] [--reentry-seconds 15] [--topup-fights 400] [--sample-dir <dir>]
# Plans by metric, verdict and a short magnitude, from each run's scorecard.json. --values adds every metric's numbers per plan
npx tsx tools/content-lab/xp/cli.ts leaderboard <out dir> <out dir>... [--values] [--md <file>]
# Cell-by-cell comparison of two runs, e.g. two atlases of different content
npx tsx tools/content-lab/xp/cli.ts compare --atlas-a <dir> --out-a <dir> --atlas-b <dir> --out-b <dir> --label-a <name> --label-b <name> --md <report.md>
npx vitest run --root tools/content-lab xp/xp.test.ts   # needs shared built: (cd shared && npx tsc)
```

Run from the repository root: worker threads load `tsx` from there. Everything these write names live content, so it belongs in `data/`.

### Atlas

- **Tables**: every distinct encounter table on a traversable room within a zone (a room's own table, else its zone's), plus every dungeon floor. `atlas.json` holds each table's zone, region, room level (weighted median authored level of non-passive monsters, else zone midpoint), room counts, zero-XP, boss and override flags.
- **Cells**: one party at one level at one table. Levels come from `XP_GRID_LEVELS`; each composition has a band relative to the room level.
- **Room gates** (`gates.ts`): the lowest member level that can stand in each room, from the start tile through tile and transition entry requirements and quest level rules. A cell whose lowest member is below it is ineligible. It is a lower bound: fights along the way are assumed won and collect objectives doable. It also counts the paying rooms that border a zero-XP room.
- **Compositions** (`comps.ts`), party level minus room level -30 to +60 unless noted; the room gates stop anyone reaching further below: `core`: the solos, `K+P`, `K+A`, `K+P+M`, `K+A+P+M+B`, each solo plus the usual hires, and `A+hK`. `extended`: the other class subsets, five of a class, `Px3`, `Kx3`, `K+P+Bx3`, and the stacked Mage and Bard parties (`MAGE_BARD_PARTIES`), which an older atlas lacks and the card says so. `carry`, mixed levels, -5 to +20: a carrier with friends 10, 20 or 40 levels below. `stall`, within 10 levels: ungeared (`U:`), Attack only (`N:`), worse seat (`S:`), P-only and P+B parties, each naming the party it is compared with; and at the full band `I:`, Bard parties with the `xp_bonus` passive swapped in. `seating`: `D:`, the core parties in the seats the game hands out when nobody moves anyone. `hired`: each solo + 4 and each pair of classes + 3 of the strongest hires on the map within the hire level limit, which are free.
- **Party** (`party.ts`): the seats, loadouts and hires of `policy.ts`, gear by each member's own level. A hire more than `HIRE_LEVEL_LIMIT` levels above the party's highest human is never taken (`isHireWithinLevelLimit`): `PlayerManager` refuses to hire one and `buildPartyCombatants` sits it out, and `xp.test.ts` checks the builder against that roster. Dungeon entry goes through the real `validateDungeonEntry`, and hires wait at the entrance.
- **Fights** (`fight.ts`): real engine at `COMBAT_PACE`, seeded per cell, entry and index, fought to the end as the game does. 4 real hours bounds the simulation; a fight still going there is a timeout and pays nothing. A row flags a fight still going at `defaultHorizonMs`: the real forecast scores those as not won, so auto-retreat keeps reading them that way even when the fight goes on to win. A dungeon floor is one fight like a room's, and a loss on it ends the run: the game keeps no progress and has no retries.
- **Rows** (`rows.ts`): fixed part plus one small record per monster type, so a fight costs about 30 bytes. `forEachRow` streams a file with a reused row object. Each worker writes its own `rows-NNN.bin`, one cell's fights contiguous.
- **Near-line pass** (`refine.ts`): win rates don't depend on the XP rule, so after the main pass every cell reading 70 to 100 % won gets a fresh sample of `--refine-fights` fights, once per atlas. Every plan uses these figures in place of the first read. Fresh samples live in `refine/f<fights>/c<cell>.bin`, one finished file per cell, and any plan can add to them.

### Pacing

`ServerBattleTimer` waits `KILL_BEAT_MS` after the last blow, then `RESULT_PAUSE + MOVE_DURATION`, whether the fight was won, lost or stalled and whether or not the party is walking; there is no wait after a loss, a defeat has no other cost, and the next fight starts at full HP. `xp.test.ts` checks this against the real timer. Auto-retreat is on by default and ends a fight differently: at `RUN_AVAILABLE_MS`, then `RESULT_PAUSE + MOVE_DURATION`, with no kill beat and no reward. The evaluator models this per table entry, reading the win rate the forecast would see (`fwin`), which doesn't count a win past the horizon: `xp` in `rates.jsonl` includes it while under 10 % of fights are skipped, `raw` fights everything out, and at 10 % and over `xp` falls back to `raw`. Neither is what a party is sure to earn. With any pack under the line, three skips in ten fights make it leave the room (at once if the whole room is under), for its previous room if safe, else the neighbour it wins most, and it holds there until a player moves it; that target can pay nothing. So a cell with `skip` above 0 is a range from 0 to `xp`, and the scorecard prints it that way.

### Plans

A plan is a file with a default export; nothing else needs changing. Keep it under `plans/`, or outside the repository if it names live content: any path works, and its bare imports resolve from this repository (`repo-resolve.mjs`). Start from `definePlan` in `plans/lib.ts`, as `plans/baseline.ts` does:

```ts
export default definePlan({
  id: 'my-plan',
  describe: 'What it does, in a line',
  params: { someFactor: 1.5 },
  victory(fight, member, ctx) { return Math.ceil(fightPot(fight, member, ctx) * growingPotShare(ctx.party.shareCount, ctx.params.someFactor)); },
  retuneContent(snapshot, atlasSummary) { return snapshot; }, // optional; XP, gold and reward values only, anything else is refused
  prepare(snapshot, atlasSummary) { return { ... }; },        // optional; its JSON result reaches payout as ctx.state
  bossPolicy: { respawnMs: 600_000 },                         // optional
});
```

`definePlan` pays `victory` on a won fight and nothing on a loss, as the game does. `plans/baseline.ts` is the game's rule as shipped: `shippedXp` hands the shared `fightXp` what `PartyBattleManager.payVictory` does (`fightXpInput`: every monster present, the member's level, the highest human's, bodies as humans plus fighting hires, the starter-zone flag of a room, never of a floor, the floor's `xpFactor`, the party's `xp_bonus` and `rewardMultiplier`). `lib.ts` also has `memberXp` and `fightPot` (the game's pot before the party share: floor factor and level gap, then `xp_bonus` and `rewardMultiplier`), `topHumanLevel`, `presentMonsters`, `growingPotShare`, `powerShare`, `weightedBodies`, `partyLevelSpread` and `weeklyRuleForSoloDungeons`.

`--param key=value`, repeatable, sets the plan's own `params` for a run, so a sweep needs no new file per value. A key the plan doesn't declare stops the run. The values go in `plan.json` and in the title of `scorecard.md`, `summary.md` and `scorecard.json`. `payout` and `retuneContent` read `ctx.params` or the same object at run time, so they see the value. A `bossPolicy` written as a plain object is built when the module loads, before `--param` runs, so one reading a param must be a function: `bossPolicy: params => ({ dungeonWeekly: weeklyRuleForSoloDungeons(params.repeat) })`. A plain policy still holding a param's old value stops the run.

Plans that change HP, damage, abilities, skills, item stats or rooms need their own snapshot and atlas: `rework` makes the snapshot, then run `atlas` on it. `retuneContent` can only change what fights never read, so other plans can reuse an atlas: monster `xp`, `goldMin` and `goldMax`, quest XP rewards, dungeon `firstClearXp`, a floor reward's `chance`, `minQty` and `maxQty`, and item `value`. `assertRewardsOnlyChange` stops the run on anything else, monster drops and first-clear rewards included. It also stops an item `value` raised over that item's lowest shop price, which would make gold from nothing, and a monster's `goldMin` or `goldMax` removed, which the game would pay as NaN.

A `bossPolicy` reaches every metric, not just I10. Metrics that compare rooms read what the room itself pays: paid kills, plus its other entries for the rest of the time. I10 and the boss farmer read a day built around the boss, as a bonus on top of idle: while an all-boss table has no fight, the party earns its best non-boss room. `rates.jsonl` keeps the boss and non-boss entries of a boss room apart (`bs`) for this. `dungeonClearsPerDay`, above 0, pays that many clears, then the idle rate, and dungeon-sourced materials read it too. `dungeonWeekly: { fullClearsPerWeek, repeatFactor }`, or a function of the dungeon id and whether one player can enter it (`weeklyRuleForSoloDungeons` is that function for the dungeons one player can enter), is a weekly lump plus a repeat rate: loops, the active premium and dungeon-sourced materials read the repeat rate, and I10 reports the lump apart, like a weekly quest. A rule must keep `repeatFactor` above 0 and at most 1, and `fullClearsPerWeek` at most `MAX_WEEKLY_FULL_CLEARS`, or the run stops; clears past the first each week count in the premium. `repeatCoinFactor` and `repeatRewardFactor`, each 0 to 1, cut a repeat run's coin and the chance of its floor rewards, a run stopping early included, so an engine rule touching only full clears would pay more than the card reads. Left out, they stay at 1 whatever `repeatFactor` says: XP's factor is set against XP, gold sits far higher over its rooms, and a reward factor also slows dungeon materials, so neither should happen by accident. The card warns when a rule cuts only XP.

`payout` runs once per fight per human member, on worker threads. `fight` has the result, real ms, party damage, lowest party HP fraction, deaths, whether the fight outlasted the forecast horizon, and the monsters present, each as `createMonsterInstance` makes it from its definition after `retuneContent` (XP, level and its source, HP, damage, passive, skills, tier), with counts killed and standing. `member` has the class, level and role. `ctx` has the party (members, hires with their classes and levels in `hireDetails`, share count, XP multiplier), the table and its metadata (`starterZone`, and on a floor `floorXpFactor` and `floorCoinFactor`), `rewardMultiplier`, `pauseMs`, the plan's `params`, `state`, and `rules`: the shared `fightXp`, `levelGapXpFactor`, `isHarmlessMonster`, `partyXpShare`, `floorPayFactor` and `floorMonsterXp`. `FightView` is reused between calls, so don't keep a reference to it. `xp.test.ts` holds `plans/baseline.ts` to `PartyBattleManager.payVictory` on random fights and on named cases: level gaps both ways, harmless monsters, hires, starter zones and floor factors.

A broken plan stops the run instead of producing a plausible card:

- **`payout` must be pure.** The workers get a fresh copy of the plan's module, so a variable set in `retuneContent` or `prepare` is empty there. Return anything `payout` needs from `prepare` and read `ctx.state`. The evaluator runs a sample of fights on the main thread too, and refuses a plan whose pay differs between the two, which also catches randomness.
- **A payout that isn't a finite number, zero or more, stops the run**, naming the party, room and result. So does a plan that pays nothing in any cell, and a `retuneContent` that sets an XP value to anything but a finite number, zero or more, a gold, quantity or item value to anything but a whole number, zero or more, a `goldMin` above its `goldMax`, or a reward chance outside 0 to 1.
- `payout` also runs on synthetic fights for I1c, on a table called `synthetic`, so it must cope with a table it has no state for.
- The card prints a warning when a plan pays nothing in over half the cells won in paying rooms, when a scored metric measured nothing and reads n/a, when a member holding an XP multiplier isn't paid that much more (`xp_bonus` is a perk no plan may cap), when a lost fight pays, when kill rate hardly orders XP/hr within a room, level and party size, when `retuneContent` cuts first-clear, weekly or one-off quest XP, when a dungeon rule cuts repeat XP but leaves coin and floor rewards in full, when a clear cap pays more clears a week in full than a weekly rule may, when a plan raises a monster's coin over 1.25x or an item's sale value over the atlas's, when the median on-level room's coin leaves 0.5x to 2x of the atlas's, and when gear a floor gave has no source left. The leaderboard shows the warnings, whether picks were re-sampled, and any scored metric reading n/a beside the fail count.

### Scorecard

The same for every plan: I1 party's best room beats solo's best room, I1c the literal case, I1b every member helps, I2 no backwards, I3 starter never outpaces, I4 monotone progress, I5 no zero rooms, I6 no stalling, I7 efficiency pays, I8 challenge pays, I8b losing doesn't pay, I9 power-levelling, I10 boss and dungeon farming, I16 no solo dungeon for gold, I11 target fit, I12 weak solo, strong together, I13 what five Bards are for (reported), I14 layouts have different purposes, I15 material rooms, Gold (reported), Progression (days to level per persona, without quests, with one-off quests, and with weeklies), auto-retreat exposure, and what the atlas can't express, which reads as not simulated rather than passing. Plans assume no item grants another class's skill; the coverage note reads the snapshot and names any grant still in it, which default loadouts don't slot. Coverage notes at the top of the card, and beside I1, I12, I13 and I14, say what the atlas lacks. Each reports a verdict, the magnitude and the worst offenders. `scorecard.md` also lists the modelling assumptions and verdict thresholds (`MODEL_ASSUMPTIONS`). `summary.md` is the card's own facts and verdict table, stamped with the card's hash: relay that, not figures from a log. `scorecard.json` holds each metric's verdict, magnitude, a short magnitude and its numbers, which `leaderboard` reads. `curve.json` is the on-level curve: pass the baseline's as `--baseline-curve` so later plans report against it.

**Noise.** A cell's first read is 24 fights, and verdicts pick the best of many cells, so picks flatter themselves and a cell near the win line reads either side of it. Three things keep a verdict from depending on the seed:

- **Near-line cells** use their fresh sample in every plan (see Atlas).
- **Picks are re-sampled before they count.** `run-plan` takes the rooms each verdict picked for any pair within 1.25x of its line (I1, I1b, I2, I3, I4's inversions, I6's flagged variants, I10, I12), plus any room a low first read could be hiding (within 1.25x of the pick, and for a failing pair, enough to rescue it), gives them a fresh sample of `--topup-fights` fights, redoes the picks, and repeats until nothing new turns up, up to 4 rounds and 12000 cells. Samples are shared between plans through the atlas's `refine` folder, so a later plan mostly reads what an earlier one simulated; `--sample-dir <dir>` writes new ones there instead and only reads the atlas, which a shared or read-only atlas needs. `rates.jsonl` ends up holding these figures, with the first read in `first`. `--topup-fights 0` skips this and the card says so; use it to sweep, then run the finalists in full.
- **The 90 % line is a band on a fresh sample.** A party's room counts as won if the sample's 95 % interval reaches 90 %; the room it is compared against counts only if the whole interval clears 90 %. So a plan that passes at the true win rates doesn't fail because a room sits on the line. The price is a looser line, about 3 points each way at 400 fights.

The picks of I13, I14, I15, I12's share tables, I1b's `xp_bonus` additions, I10's parties beyond the reference ones and the Gold section aren't re-sampled: their bands are wide against a cell's noise, and they add nothing to what other metrics read.

**A second look** reads a few cells again without touching `rates.jsonl`, so it can't move another metric: I6's flagged variants at 6000 fights a side unless 400 fights already read them over 1.25x, I6's faster parties at 400, and I8b's flagged picks at 400. I16 takes its own read at 400 for cases within 1.25x of its line, their floors and any room that could really be the yardstick, and only I16 and the Gold section use it. Its samples live in `<out dir>/second-look`, and an atlas sample of the same size is reused, so the atlas is only read. `--topup-fights 0` skips it and the card says the cells aren't confirmed.

 I1, I1b, I2, I3 and I12 fail only on a pair off by over 5 %. I4 fails on a re-sampled room under 80 % of one below it. I8's rise allows a fall of up to 5 %.

- **I1** compares best room with best room per class, level and party, and reports reach: how many levels harder a room the party wins. The same-room table is information only. `A+hK` is shown under both seatings. Hire-carried cells, a hire 5+ levels over the lowest human, are out of the verdict and shown apart.
- **I1c** runs the plan's `payout` on a literal case, on synthetic fights: an Archer's one mob in 5 s against two with a Knight in 10 s, which must pay more per hour. It has its own verdict so a plan's other results stay readable while it fails. It also prints the plan's share curve and the kill-speed multiple each size needs in the same room. **Flat pay per body can't pass below a share of 0.868 for two bodies** (b over 0.735 in `(1 + b(n-1))/n`, beta under 0.205 in `n^-beta`): the kill rate is the same, so the only margin is the shared pause, and with no pause no split is exactly 1.00x. A split near `b = 0.2` passes only if the plan also pays the bigger pack extra, by about 1.4x at `b = 0.25`. I1c prints the arithmetic.
- **I1b** scores a Bard addition with the default loadout and, where the atlas holds that party, wearing `xp_bonus`. It counts against the verdict only if it lowers XP/hr on both.
- **I3** compares a sitter with the same party journeying. The best sitter of any party against other parties' journeyers is printed and judges nothing.
- **I5** fails on a room outside the starter region paying nothing, for everyone or for a member who wins it at or above their level, after any `bossPolicy`, and on a room the reference party wins paying under 10 % of its zone's median. What a room far below the party pays is reported.
- **I6** scores same-party variants only, and a cell counts only if it earns over 5 % more with longer fights, with fewer kills an hour, or by giving up wins for shorter fights (losing fast, its own line), and it holds at 6000 fights a side. `xp_bonus`, stacked or not, is a designed perk: reported, never counted.
- **I7** includes P-only parties and shows them against a mixed party of their size. Pairs where the slower party holds `xp_bonus` are reported apart and leave the verdict; a pair where only the faster party holds it stays in.
- **I8** also reports rooms 6 to 20 levels over the party, the soft rooms a rule paying by room level would pay under-levelled parties for. **I8b** fails a party earning over 5 % more in a room it wins under 50 % than in the best room it wins at least 90 %.
- **I9** needs a carried friend faster than an on-level solo and an on-level party, and flags a carrier under 0.25x of an on-level party's rate.
- **I10** reads every core and extended party, prints the reference parties' figures too, floors the active premium at idle and leaves every weekly out of the verdict. It also fails a lone loop paying over 5 % more than the class's best solo room, for any dungeon one player can enter, and a floor whose content pays cut to nothing. A floor written at 0 XP is reported, with what a gear run leaves per dungeon and how many entrances are in rooms paying nothing. First clears and weeklies are reported as days of idle XP, per party, and the premium with them is reported.
- **I11** uses reference parties as examples for measuring income, not as the party the game should push players towards.
- **I12** is a hard rule: a class's best room alone against its best room in every party of humans it could join, per level. Solo must stay playable, so it also fails a level where a class wins no paying room alone, or earns under 10 % of the median layout it could join. It reports solo's on-level share of a party member per layout and party size, the levels a class alone has no on-level room it wins, and a lone player with free hires against the best human party.
- **I13** reports per level, with and without `xp_bonus`: five Bards' best room, ordinary on-level rooms won, rooms led against whichever layout leads each room, boss rooms in their own columns, and reach. Reach walks up from the world's lowest room and stops at the first room level where under 60 % of the ordinary rooms within 2 levels are won, so one soft room far above doesn't count. A room the party can't stand in, behind a gate or past the atlas's band, leaves the test, and a `+` marks a reach where that happened. It judges nothing.
- **I14** treats a layout as a party shape, a Bard party with and without `xp_bonus` being one layout at the better of the two. It reports effective layouts, lead shares, layouts close to best, each class's journey and the spread explained by layouts meeting rooms, by stage, region and level. The first third of the regions is early and only reported; `EARLY_REGION_SHARE` sets it, and the card prints the verdict with the boundary moved a region each way. From the mid game on it fails if one layout leads over 75 % of rooms, one layout is close to a class's best at over 80 % of its stops, a party is best or close among its size in under 3 rooms, or a party is dominated by one of its head count. Solos and hired parties aren't tested. A layout that wins or earns nothing counts, as having no purpose. It also prints the leaders by what they hold, an ordinary-rooms reading, and the no-purpose count with early rooms in.
- **I15** reads drops from the plan's own snapshot. For each material a gear recipe needs, directly or through a part no shop sells, at about the recipe's level, for 11 reference parties: the source giving up the least best-room XP per craft, its XP hit and hours per craft. A material reaching gear only through parts a shop also sells just saves gold, so it is reported and doesn't count. The working band is a hit of 10 to 30 %, no hit is fine; a median hit over 50 % fails if the visit also gives up at least 0.25 hours of best-room XP per craft. Boss tokens, dungeon-only materials and parties whose cheapest source is a dungeon also fail on over 2 hours given up per craft. Dungeon sources read the loop at its repeat rate, including any `repeatRewardFactor` and clear cap, plus a rule's weekly full clears, and the full clears alone as a source of their own, so a detune moves them, and a rooms-only band line reads the rooms apart. Hours per craft is how long a craft takes to come; XP given up counts only the time in the dungeon. A material only floor rewards give, cut to nothing by the plan, fails, and a week's full clear counts as giving it. So does any material whose median takes over 672 hours per craft, four weeks, set so one full clear a week can supply a craft. Going back for an old material is reported only.
- **I16** applies the no-solo-dungeon rule to gold. For each dungeon one player can enter, by the real door rule, each class and grid level winning its first floor at all alone: coin plus the sale value of floor rewards from repeat runs, at the richest place to walk out, the full run included, against the class's richest ordinary room won at least 90 % alone at that level. That room is held at or under what the atlas's own content pays, so a plan can lower the line and can't lift it. It fails on a case over by more than 5 %, or on a plan raising a lone loop's monster drops over 1.25x the atlas's, and prints the count, the worst and each dungeon. With nothing paid against no paying room in most cases it reads n/a, and the card warns. Beside it, judging nothing: full clears alone clearing at least 90 %, the count at 5 s and 30 s to re-enter, drops counted, boss rooms let in, harder lines, the room they'd stand in for XP, the best party's gold room and loop, and parties in these same dungeons, whom the rule's words may or may not reach. The richest room is a lenient yardstick wherever a starter room out-pays everything near the player, and the card prints where.
- **Gold** judges nothing. It reports party-only dungeon loops, parties in dungeons one player can enter, each layout's richest room against its best XP room by level, what a plan's dungeon rule leaves, a boss room's coin against the richest ordinary room, gear the plan leaves with no source, how long a craft's worth of each dungeon-only material takes before and after the plan, and first-clear gold. Crafted income, trading and gear prices aren't modelled.

`rates.jsonl` has one line per cell: win, loss, stalemate and timeout rates, the share of fights past the forecast horizon and the win rate the forecast sees, fight time, kills per hour, party damage, lowest HP, and per human member XP/hr with and without auto-retreat and XP per fight, in the member order of the composition. `gold.jsonl` sits beside it, kept apart so a gold change can't move `rates.jsonl`, which runs compare byte for byte. One line per cell: mean coin per fight, coin/hr read as `xp` and `raw` are, the sale value of monster drops per member per fight and per hour, and a boss room's coin split as `bs` splits its XP. A plan that retuned content also gets `atlas` on each line: the same fights as the atlas's own content pays them, which I16's yardstick and drops line read. Coin is `payVictory`'s, floor rewards are `grantDungeonRewards`' and sell at item `value`, all read off the fight rows and the plan's own snapshot (`gold.ts`), so plans evaluate gold without simulating. `xp.test.ts` holds each to the real game code. `cells.jsonl` and `atlas.json` say what each cell is.

# Content lab

Measures a content snapshot against the combat engine of this tree and against the engine of an older commit, using each version's real functions. It is content-agnostic: it reads the snapshot given on the command line and holds no content of its own.

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
- **Hires** (`HIRE_ROLES`): up to two hires offered on the same map, completing a tank, healer and damage trio. A tank is a Knight, or a Priest hire carrying a physical-reduction skill. The highest level at or below the party, else the lowest above. Each hire takes a reward share that is lost.
- **Sims**: stratified by table entry, `max(3, round(N × share))` per entry, statistics weighted by share. Seed = FNV-1a of base seed, cell id, entry id and sim index, fed to mulberry32. The old engine reads `Math.random`, which the adapter swaps for the seeded stream during a fight.
- **Rates**: XP/h = E[XP per fight, 0 on anything but a win] ÷ E[fight time + pause] × 3600, per human member. Pause comes from each version's timer: old = 1 s kill delay + `RESULT_PAUSE` + `MOVE_DURATION`; new = `KILL_BEAT_MS` + `RESULT_PAUSE` + `MOVE_DURATION`.
- **Stalemate**: new = the engine's no-progress rule, or still running after 2 h of battle time. The old engine has no such rule, so 600 ticks without a new low in monster HP, or still running after 2 h, counts as one (in the live game such a party would fight on forever).
- **Not modelled**: auto-retreat, kill mastery (zero kills), floor checkpoint regrouping inside whole-dungeon runs, first-clear rewards, item drops.

Combatants are built like `PlayerSession.getCombatInfo` and `buildHenchmanCombatant` on the matching version, and rewards split like `PartyBattleManager`.

## Rework

`rework.ts` is a pure function, snapshot + config > snapshot + changelog, written to run again on a newer export. The config holds every number and every override; it lives in `data/content-lab/rework-config.json` because it names live content. What the function does:

- **Monsters** referenced by any encounter table get `level` (their earliest usage), `tier` (boss on boss floors and for capstones placed only by rooms or floors, elite above the band's HP ratio) and `attackInterval` by role. `damage` factors are per second, so a slower monster hits harder for the same DPS. HP, XP and gold scale by global x region x monster factors. Passive walls gain HP and scale their drops; they get no level, tier or interval.
- **Monster skills** follow `monsterSkills`: a factor per skill id, or the global x region damage factor, never the per-monster damage factor (a cast is not DPS, and a telegraph that costs nothing is pointless). Monster heals keep their value unless a monster has its own factor or `healFollowsHp` is on.
- **Gold** can't scale smoothly at low levels: rolls are whole numbers and each member's share rounds up. `fit --modes gold` searches each monster's roll against the old rate and stores `goldRanges`. A roll never pays more than authored, and only an ordinary monster paying under 3 may drop to nothing.
- **Drops** scale by the kill-rate ratio, except chances of 0.5 and up. Quest-collect drops scale too, so collecting keeps its time cost, down to `questDropFloor`.
- **Items** and set bonuses scale DR and MR into rating. `weaponAtkByClass` scales weapons only those classes can equip; shared items and percent bonuses stay.
- **Skills** adopt the seed's `castTime`, `warmup` and `trigger`; rating passives adopt `ratingValuePerLevel`; grant-only variants follow the leveled skill with the same class, type and effect kind. `skills` patches the rest.
- **Boss floors** that can field a boss get `checkpoints`. `fit --modes enrage` sets `enrage`: for a trial boss, the slowest eligible full-size party with a tank and a healer (a duo counts as under-built only where more than two may enter); for an open-world capstone, the slowest winner of any party size, plus what hires took on the old engine over the speed target. `enrageSteps` steepens only bosses on checkpointed floors, since a wipe there costs a regroup rather than the run.
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

# Codex

The Codex is each player's own record of the monsters, items, rooms and shops they have discovered, with the links between them. The server decides what a player has discovered and sends nothing else: there is no per-entry request, so nothing can be probed one id at a time.

## What counts as discovered

| Entry | Discovered when | Data |
|---|---|---|
| Monster | Met in a fight as a human fighter, whatever the outcome, or killed before the Codex existed | `codex.monsters`, backfilled from `monsterKills` |
| Item | Has been in the player's bags by any route (drop, dungeon reward, shop, quest reward, gift, trade, craft), or is in the stock of a shop they have visited | `codex.items`, visited shops' current stock |
| Room | Found: in the player's unlocked set (fog of war), still in content and walkable | `unlockedKeys` (no new data) |
| Shop | The player fought in its room, in the overworld | `codex.shops` |
| Dungeon | The player fought one of its floors | `codex.dungeons`, backfilled from `clearedDungeons` and a saved run |
| Drop | An item from a monster reached this player's bags, with a tally | `codex.drops` |
| Encounter | Fought anywhere in the overworld; never shown by name, only as its monsters | `codex.encounters` |

Links follow from these:

- A met monster **lives in** every found room whose table can spawn it, and **appears in** every dungeon the player has fought in whose floors can spawn it.
- A room's **fights you know** are the fought encounters its table can roll, each shown as the monsters in it the player has met (encounters are remembered once, wherever they were fought, not per room). Lines without a met monster are dropped and identical lines merged.
- A monster's **drops** are only the ones the player has received; the count of distinct items it can drop (`dropKinds`) is shown, never their names.
- A shop's stock and hires show once it is visited.

Never shown: encounter ids, names, weights and counts; drop chances (the authored chance is not the real one, `paceDropChance`); counts of unmet monsters or unfought encounters; how much content a server has in all.

Ids that leave content are kept in the knowledge and skipped when a reply is built, so they come back if the content does.

## Saved knowledge

`PlayerSaveData.codex` (`CodexSaveData`, `shared/src/systems/CodexTypes.ts`), held in memory by `CodexKnowledge` (`server/src/game/codex/CodexKnowledge.ts`): sets in discovery order, a map of drop tallies (a `Map`, so ids like `__proto__` are safe), and the last 20 new monsters, items and shops (`recent`). It is pure: no content access and no clock. Every list is capped (`CODEX_CAPS`; an add past a cap is skipped), tallies stop at `CODEX_DROP_TALLY_MAX`, and ids are 1..`CODEX_ID_MAX_LENGTH` (200) characters. Saving, the restore sanitiser, the backfill, master reset and rollback are in `persistence.md`.

## Recording

Fight start is the only place a fight is credited (`PartyBattleManager.createCombatForParty`), drops are credited at the victory payout, and every way into the bags marks the item: `storeRewardItem` (combat drops and dungeon rewards), `addOneToInventory` (shop buys, quest rewards), `addToInventory` (gifts, trades) and craft completion. The details, including why hires are never credited and why a dungeon floor never credits the entrance room's shop, are in `combat.md` → Codex recording. All of it costs a few set lookups per event and no content scan.

The first meeting with a monster writes one `codex` journal line, "New in your Codex: {names}.", whose `codex` field is a ref to the first new monster. The backfill writes nothing.

## Protocol

- `request_codex` (no payload) → one `codex` message (`ServerCodexMessage`) to the asking socket: `monsters` (met, in discovery order, with kills, received drops by tally and `dropKinds`), `items` (held first, `found: true`, then visited shops' stock not held, `found: false`), `shops` (stock and hires), `tables` (one per distinct table key of the found rooms, kept when it lists a met monster or a known fight), `fights` (indexed by `tables`), `dungeons` and `recent`. Built by `buildCodexMessage` (`server/src/game/codex/CodexBuild.ts`) through `PlayerSession.buildCodex`.
- Marker: `ClientCharacterState.codexVersion` = `contentEpoch.serial.revision.unlockedCount`, a few bytes in every state push. It moves on any new fact or raised tally (`revision`), any content change (`contentEpoch`), a rebuilt knowledge object after a master reset or an unban login (`serial`, a module counter), and newly found rooms. A reply's `version` is the marker it was built at, so a client refetches only while the marker differs from its copy.
- Refused before a character exists, like every message but `set_class`.

## Content index

`codexContentIndex` maps found rooms to the table they roll and tables and dungeons to what they can spawn; it is rebuilt once per content epoch. See `content.md` → World map & room names → Codex index for the rule and the spawn model.

## Secrecy

Every reply holds only discovered facts. `server/tests/CodexBuild.test.ts` walks replies over several knowledge states (empty, partial, everything, dangling ids) and fails if any monster is unmet, any held-item id is not in the player's items, any unheld item is outside a visited shop's stock, any shop or dungeon is unvisited, any table key belongs to no found walkable room, or any encounter id or name appears in the JSON.

Room facts are not secret: `/api/world` already sends every room of every map with its name, id, own encounter table ids and doors, `/api/npcs` every NPC and `/api/dungeons` every dungeon with its floor tables and reward ids. The Codex adds no room facts and shows only found rooms; it never sends a monster definition, drop, shop stock, encounter's monsters, zone table result or item definition for anything undiscovered.

## Limits

- A token bucket per session in `PlayerManager` (`takeToken`, shared with lock inspections): `CODEX_REQUEST_BURST` (2) at once, then one per `CODEX_REQUEST_GAP_MS` (15 s). A dropped request gets no reply and spends nothing.
- A socket buffering more than `COMBAT_BACKPRESSURE_BYTES` gets no reply, and spends no token.
- A reply is bounded by content size and the knowledge caps whatever the player does. Building one is a pass over the found rooms and the knowledge; there is no per-session reply cache. For the large invented world in `CodexBuild.test.ts`, where the player has found everything, it takes about 10 ms plus a few ms to stringify, stays under 512 KB of JSON and deflates to well under a quarter of that.
- Socket messages are compressed (`perMessageDeflate` in `server/src/wsServerOptions.ts`) for clients that offer it, which browsers do.

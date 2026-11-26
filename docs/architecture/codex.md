# Codex

The Codex is each player's own record of the monsters, items, rooms and shops they have discovered, with the links between them. The server decides what a player has discovered and sends nothing else: there is no per-entry request, so nothing can be probed one id at a time.

## What counts as discovered

| Entry | Discovered when | Data |
|---|---|---|
| Monster | Met in a fight as a human fighter, whatever the outcome, or killed before the Codex existed | `codex.monsters`, backfilled from `monsterKills` |
| Item | Has been in the player's bags by any route (drop, dungeon reward, shop, quest reward, gift, trade, craft), or is in the stock of a shop they have visited | `codex.items` (recorded from release on, backfilled only from the bag and gear), visited shops' current stock |
| Room | Found: in the player's unlocked set (fog of war), still in content and walkable | `unlockedKeys` (no new data) |
| Shop | The player fought in its room, in the overworld, or bought or hired there (`PlayerSession.handleShopBuy`, the `hire_henchman` handler; also during a dungeon run at its entrance room) | `codex.shops` |
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

Fight start is the only place a fight is credited (`PartyBattleManager.createCombatForParty`), drops are credited at the victory payout, and every way into the bags marks the item: `storeRewardItem` (combat drops and dungeon rewards), `addOneToInventory` (shop buys, quest rewards), `addToInventory` (gifts, trades) and craft completion. An item received in a trade that is then rolled back stays recorded; its definition was already shown in the trade offer. The details, including why hires are never credited and why a dungeon floor never credits the entrance room's shop, are in `combat.md` → Codex recording. All of it costs a few set lookups per event and no content scan.

Each first meeting with a monster writes its own `codex` journal line, "New in your Codex: {name}.", whose `codex` field is a ref to that monster; a fight with several new monsters writes one line each, in fight order. The backfill writes nothing.

## Protocol

- `request_codex` (no payload) → one `codex` message (`ServerCodexMessage`) to the asking socket: `monsters` (met, in discovery order, with kills, received drops by tally and `dropKinds`), `items` (held first, `found: true`, then visited shops' stock not held, `found: false`), `shops` (stock and hires), `tables` (one per distinct table key of the found rooms, kept when it lists a met monster or a known fight), `fights` (indexed by `tables`), `dungeons` and `recent`. Built by `buildCodexMessage` (`server/src/game/codex/CodexBuild.ts`) through `PlayerSession.buildCodex`.
- Marker: `ClientCharacterState.codexVersion` = `contentEpoch.serial.revision.unlockedCount`, a few bytes in every state push. It moves on any new fact or raised tally (`revision`), any content change (`contentEpoch`), a rebuilt knowledge object after a master reset or an unban login (`serial`, eight random hex characters per object, so it counts nothing), and newly found rooms. A reply's `version` is the marker it was built at, so a client refetches only while the marker differs from its copy.
- Refused before a character exists, like every message but `set_class`.

## Content index

`codexContentIndex` maps found rooms to the table they roll and tables and dungeons to what they can spawn; it is rebuilt once per content epoch. See `content.md` → World map & room names → Codex index for the rule and the spawn model.

## Secrecy

Every reply holds only discovered facts. `server/tests/CodexBuild.test.ts` walks replies over several knowledge states (empty, partial, everything, dangling ids) and fails if any monster is unmet, any held-item id is not in the player's items, any unheld item is outside a visited shop's stock, any shop or dungeon is unvisited, any table key belongs to no found walkable room, any table or dungeon lists a monster it cannot spawn, any fight line is not a fought encounter of that table as its met monsters, any drop tally or kill count differs from the player's own, or any encounter id or name appears in the JSON.

Room facts are not secret: `/api/world` already sends every room of every map with its name, id, own encounter table ids and doors, `/api/npcs` every NPC and `/api/dungeons` every dungeon with its floor tables and reward ids. The Codex adds no room facts and shows only found rooms; it never sends a monster definition, drop, shop stock, encounter's monsters, zone table result or item definition for anything undiscovered.

## Limits

- A token bucket per session in `PlayerManager` (`takeToken`, shared with lock inspections): `CODEX_REQUEST_BURST` (2) at once, then one per `CODEX_REQUEST_GAP_MS` (15 s). A dropped request gets no reply and spends nothing.
- A socket buffering more than `COMBAT_BACKPRESSURE_BYTES` gets no reply, and spends no token.
- A reply is bounded by content size and the knowledge caps whatever the player does. Building one is a pass over the found rooms and the knowledge; there is no per-session reply cache. For the large invented world in `CodexBuild.test.ts`, where the player has found everything, it takes about 10 ms plus a few ms to stringify, stays under 512 KB of JSON and deflates to well under a quarter of that.
- Socket messages are compressed (`perMessageDeflate` in `server/src/wsServerOptions.ts`) for clients that offer it, which browsers do.

## Client

- **Files.** `client/src/ui/codexLinks.ts` is in the main chunk: `CodexTarget` (a ref, `home` or `list:<kind>`), the `data-codex` value helpers, `codexLinkHtml`, `createCodexOpener` and `installCodexDelegate`. The window is a lazy chunk, loaded on first use like Patch Notes: `client/src/ui/codex/CodexModal.ts` (the window), `codexViews.ts` (string renderers, every content name escaped) and `codexModel.ts` (DOM-free: `buildCodexIndex`, search, sorts, `closestRooms`, `travelBlock`, quest lines). The main graph imports them by type only. `client/src/styles/codex.css` loads with the main stylesheet, after `social.css`, so the cascade doesn't change when the chunk loads.
- **Opening.** `App.enterGame` adds `installCodexDelegate` to the shell listeners: a capture-phase document click on any `[data-codex]` opens that target, so panels that stop clicks (the room sheet) still pass it on. Without `character.codexVersion` in the state (a server without the Codex) the tap says "The Codex isn't available right now."; a chunk that fails to load says so and the next tap tries again. Settings › Game shows the Codex row (`data-codex="home"`) only while the state carries the marker.
- **Links in.** The item popup's `codexLink` option (Hero, Craft and both Shop detail views; not another player's profile), a `›` on every Bestiary row, "Codex ›" on a battle monster card, a 📖 button on the room sheet for a found room ("Codex" spelled out in the side sheet), Quest Log objectives (`QuestText.objectiveHtml`: monsters and items always, a room once found), and each "New in your Codex" line in the full battle log (`CombatLogLine.codex`; the ticker stays plain, since a tap there opens the log). A link to something without an entry opens "You haven't discovered this yet." with a hint for its kind.
- **Window.** A `.player-options-*` sheet, 560px wide from 768px. It keeps a stack of views (at most 30); a link pushes, ‹, Back and Escape pop one and close at the first (`bringToFront`'s `back` option), × and `dismissModals` close at once. Opened from a link the stack is just that entry, so Back returns to the popup underneath; from Settings it starts at home. Each view keeps its scroll position. Each opening starts with empty searches and the first page of every list; the chosen sorts and the opened or closed zones are kept for the tab's life. Home lists the 8 newest discoveries, with "New" on those not in this device's seen list as it stood when the window opened (read once per opening and checked against each home paint, so a fresher reply or a discovery made while home is open is tagged too), and the four section counts; search is local, debounced 120 ms, five per kind with "See all". Lists show 100 rows and "Show more"; rooms group by map and zone, with only the party's zone open.
- **Data.** `GameClient.requestCodex()` returns `lastCodex` and asks for a fresh one (at most once per 15 s while outstanding, re-sent on reconnect) when its `version` differs from the marker; `lastCodex` is dropped on `world_update`. The open window asks on open and then at most once per `CODEX_REFRESH_MS` (30 s) while the marker moves, with a timer for the last change; nothing is fetched while it is closed. When it has nothing true to show it asks sooner: with no snapshot at all (as after a `world_update`) at once and then every `CODEX_RETRY_MS` (15 s), and on an entry missing from a stale snapshot every 15 s, showing "Opening your Codex…" rather than "You haven't discovered this yet." until the snapshot is current. Once a current snapshot has shown that view as missing, it keeps "You haven't discovered this yet." and the 30 s cadence while the marker moves on, until the entry appears. `requestCodex`'s own 15 s rule keeps this from sending faster. The client joins the reply with the state: recipe items for the class (`craftingCatalog`, marked "Not found yet" until held) and owned items join the items, kills come from `mastery.recent` when fresher, quest lines from the quests the player has taken or finished, and dungeon rewards from `/api/dungeons`. The item page's card takes its item definitions from `state.itemDefinitions` under the index's own, so set pieces the Codex has no entry for show their names, as in the Hero popup. With no known source the item page adds the home footnote ("Drops, fights and shop visits are added as you play."). A found room's table is `codexTableKey` of its `/api/world` tile looked up in `tables`.
- **Repaints.** Pushes and replies repaint through `deferWhilePressed` and `setHtml`; the header and the search box are static nodes, so typing is never rebuilt under the player. Lists sort and group once per index, query and sort (memoised in `codexViews.ts`) and build row HTML only for the rows shown. A monster row carries the snapshot's kill count in a `data-codex-kills` element, so its HTML holds still between victories; after each paint `patchMonsterKills` sets the live count (`mastery.recent`) in place, with the same `monsterKillsText` wording. Taps on links, Back, sort and Show more repaint at once.
- **Travel.** Go there, Go to the nearest and a shop's Go call `dismissModals()` and then `MapScreen.goToRoomById`, the map's own Go: it opens the room's sheet and sends Go from it (so "Setting off…", the lock card and "Set off?" all work), shows RoomView for the party's own room, says "That room is gone." for a removed one, and on the first Map visit waits for the map to be built (`pendingGoRoomId` beside the pending focus; leaving the Map screen drops the waiting Go and keeps only the focus). Show on map uses `focusRoom`. Go is disabled, with the reason, in a dungeon or for a member who is not owner or leader; the server checks again. Nearest is a cheap order (the party's area by hex distance, then its map, then other maps); the server plans the real route.
- **Device memory.** `localStorage['codexSeen:{username}']` holds the last 20 discovery keys shown on home, written after home renders.

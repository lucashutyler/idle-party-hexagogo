# Persistence

## State persistence

Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. The journal kept in memory and in saves is 1000 entries; each `state` message carries only the last `STATE_LOG_TAIL` (100). Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation) — each restored party's timer starts only after its members, dungeon run and henchmen are restored (`PartyBattleManager.startEntry`); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added.

**The save pass.** `GameLoop.saveAll` runs one pass at a time through a private chain, so the periodic save, a deploy's save and the shutdown save never overlap, and shutdown waits for a pass already in flight before `process.exit`. A pass writes the mailbox and players (`PlayerManager.saveAll`: one synchronous capture of every session, mailbox entries before and after), then guilds, trades, content if it has unwritten changes (`ContentStore.persistIfDirty`) and the version manifest, and logs `Saved N session(s) in X ms`. `JsonFileStore.saveAll` writes the player files in chunks of `SAVE_CHUNK_SIZE` (25) and yields to the event loop (`setImmediate`) between chunks, so serializing hundreds of saves can't hold up fight timers for the whole pass. A save that fails doesn't stop the rest of the pass; `saveAll` rejects with the first failure once every chunk is written. Player saves are one-line JSON (no indentation, smaller and faster to write); older pretty-printed saves load the same way.

Saved state per player (`PlayerSaveData`):
- `username`, `battleCount`, `combatLog` (the journal — last 1000 entries: victory/defeat, rewards, level-ups, moves, unlocks and server notices; per-hit combat lines are live-only and never journaled, see `combat.md` → Journal vs live log), `unlockedKeys`, `position`, `mapId` (which map the party is on; absent on legacy saves → defaults to the world's default map on restore), `target`, `movementQueue`
- `character` (className, level, xp, inventory, equipment, skillLoadout, including the priority list `actionOrder`) — optional; old saves or saves with invalid/legacy classes get `character = null` on load, forcing class re-selection. Within `skillLoadout`, only `equippedSkills` is authoritative — `unlockedSkills` is derived and recomputed from level + skill content on every restore (`reconcileSkillLoadout` also clears slots whose skill no longer exists or lost availability). Legacy `skillPoints` is ignored on load.
- `friends`, `outgoingFriendRequests`, `blockedUsers` — optional; default to empty
- `guildId`, `partyId`, `partyRole`, `partyGridPosition` — party state survives server restarts for multi-player parties; a lone player gets a new party with their saved seat, set before their hires are restored
- `chatHistory` (last 1000 messages), `chatSendChannel`, `chatDmTarget`
- `mailbox` (only in saves from before `MailboxStore`: read on load and never written)
- `activeQuests`, `completedQuests`, `weeklyCompletions` — quest state (see `docs/architecture/content.md` Quest system)
- `partyAutoRun` (boolean) — the party's auto run switch, mirrored onto every member's save like `partyHenchmen`; the owner's save is read on restore.
- Not saved: which hires are sitting out over the level limit, which is worked out at each fight. A saved `partyHenchmen` over the limit restores on the roster and sits out. XP stays a whole number in saves, however fractional monster XP is: see `combat.md` → XP pay.
- `dungeonRun` (`DungeonRunState`: `{ dungeonId, currentFloorIndex, entrance }`) — active dungeon run, so an in-progress dive continues offline and across restarts, on the same floor, and nothing outlives the run once it ends; `clearedDungeons` (string[]) — dungeons this player has cleared at least once, gating one-time first-clear rewards (see `docs/architecture/content.md` Dungeon system). `dungeonRun` is sourced from the `PartyBattleManager` entry at save time (copied) and re-applied via `restoreDungeonRun` (floor index validated) after the party's battle entry is rebuilt on restore.
- Older saves may hold `dungeonCheckpoints`, a `dungeonRun` with `checkpointPhase`, `wipes` or `rewardedPhases`, away ledgers with `checkpoint` moments or dungeon records with `checkpoint` or `wipes`, and log lines typed `checkpoint`. All load cleanly and none is written back; see `combat.md` → Dungeon runs.
- `monsterKills` (`Record<monsterDefId, number>`) — lifetime kills for kill mastery; held in a null-prototype object so monster ids such as `constructor` or `__proto__` count like any other
- `combatPrefs` (`{ autoRetreatBelowPct: 0 | 25 | 40 | 60 }`) — sanitised on load; absent → `DEFAULT_COMBAT_PREFS` (25)
- `autoRetreatNotified` — the one-time auto-retreat notification was sent
- `awayLedger` (the "while you were away" ledger still recording) and `pendingRecap` (a finished recap not yet acknowledged) — `AwayLedger | null`, rebuilt field by field on load (counters finite and ≥ 0, levels default to the character's, lists filtered to valid entries and capped, unknown rarities and moment kinds dropped; no `id`/`since` → `null`). Every restored character with no saved ledger gets one opened at boot, since nobody is connected yet (see `combat.md` → While you were away)
- `notifications` (capped notification inbox, last 50 entries), `notificationPreferences` (per-category/channel opt-ins), `pushSubscriptions` (registered Web Push endpoints) — see `docs/architecture/notifications.md`

The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment.

All of the fields above are optional. `PlayerSession.fromSaveData` bypasses the constructor, so every new field is assigned explicitly there (and cleaned — malformed values fall back to their defaults). **Master reset** (`resetForMasterReset`) clears `monsterKills`, `awayLedger` and `pendingRecap` along with the character, but keeps `combatPrefs` and `autoRetreatNotified`; presence is then re-evaluated for every session, so offline players get a fresh ledger.

Guild data is saved separately in `data/guilds.json`. Active async trades are saved separately in `data/trades.json` via `TradeStore`. Game content is saved separately via `ContentStore`.

The store interface is swappable for SQLite/Postgres.

## Writing files

Every store write goes through `server/src/game/JsonFiles.ts`: `writeFileAtomic` / `writeJsonFileAtomic` write `<file>.<pid>.<n>.tmp` beside the target, optionally `fsync` it, then rename it over the target, and delete the temp file if anything fails. A kill or crash mid-write leaves the old file whole; a stray `.tmp` from a crash is never read and can be deleted. Content files, the version manifest and version snapshots are flushed to disk before the rename; player saves, guilds and trades are not. `ContentStore` and `VersionStore` serialize each write when it is asked for and queue it, so overlapping writes land in the order of the changes they hold. `ContentStore` is written only when content changes: every mutator calls `save()`, and the periodic pass calls `persistIfDirty()`, which writes again only after a write that failed.

## Damaged data files

`readJsonFile` returns `undefined` for a file that doesn't exist and throws `UnreadableDataFileError` (naming the file) for a read error, an empty or blank file, or JSON that doesn't parse. Each store then decides:

| File | When it can't be read | Also counted as unreadable |
|---|---|---|
| Content files (`ContentStore`) | **The server refuses to start**: `[ContentStore] data/<file> is unreadable. Refusing to start so content isn't replaced. Restore it from a backup or from data/versions/<id>.json, then restart.` and `start()` exits with code 1 | a list file that holds something other than a list, a `world.json` without a list of tiles, or a core file (`monsters`, `items`, `zones`, `world`) missing while any other content file exists |
| `data/versions/manifest.json` (`VersionStore`) | **The server refuses to start** instead of minting a fresh version "1" | a manifest without a list of versions |
| `data/accounts.json` (`AccountStore`) | **The server refuses to start**, so new sign-ins can't claim existing names and their saves | nothing else: any JSON value loads as before |
| `data/guilds.json`, `data/trades.json`, `data/mailboxes/entries.json` | Empty or not JSON: moved aside to `<file>.unreadable-<ms>` with an error log; the store starts empty and the next save writes a fresh file beside the copy. A read that fails (permissions, too many open files) throws instead, since the bytes may be fine | a value other than a list of guilds / trades / mailboxes |
| `data/<player>.json` (`JsonFileStore`) | Empty or not JSON: moved aside to `<file>.unreadable-<ms>`; the player starts fresh. A read that fails throws: at boot that stops the boot, at login the connection closes and the client retries | nothing else |

Content that parses and has the right top-level shape always loads: entries in a content list that aren't objects are skipped with a warning, legacy shapes migrate as before, and no other validation runs at boot. A missing optional content file keeps its old fallback (tile types, recipes, skills and slot schedules seed from defaults, henchmen seed outside production, everything else starts empty). Defaults are seeded only when none of the 16 content files exist, so the seed never writes over authored content. Loaders only read `<name>.json`, never `.tmp` or `.unreadable-*` files.

**Boot backups.** Before `ContentStore.load` reads anything, `backUpDataFiles` (`server/src/game/BootBackup.ts`) copies every one of the 16 content files, `data/versions/manifest.json` and `data/accounts.json` that exists, byte for byte and damaged or not, into `data/boot-backups/<time>/` (an ISO time with `:` and `.` as `-`, e.g. `2026-01-02T03-04-05-678Z`), keeping each file's path inside `data/` (`versions/manifest.json`, `accounts.json`, `world.json`, …). It keeps the newest `BOOT_BACKUPS_KEPT` (10) and leaves other folders there alone. A boot whose files are byte-identical to the newest backup makes none, so a service restarting in a loop on a damaged file can't push older backups out. A backup that fails is logged and the boot goes on; if any file failed to copy, the incomplete folder is removed and no older backup is pruned, so a disk that keeps failing can't push good backups out either. A fresh install has nothing to copy.

**Restoring a file.** Stop the service first, so nothing writes while you copy. Then pick the backup from just before the problem (`ls data/boot-backups/`) and copy back only the files that need it, for example:

```bash
cp data/boot-backups/<time>/world.json data/world.json
cp data/boot-backups/<time>/versions/manifest.json data/versions/manifest.json
```

Copying `accounts.json` back loses sign-ins and renames made since that backup. To rebuild a content file from a version snapshot instead (the active version is `activeVersionId` in the manifest), write the matching key of `data/versions/<id>.json` back out; this loses live edits made since that version was deployed:

```bash
node -e "const s=require('./data/versions/<id>.json'); require('fs').writeFileSync('data/quests.json', JSON.stringify(s.quests ?? [], null, 2))"
```

Snapshot keys: `monsters`, `items`, `zones`, `world`, `encounters`, `sets`, `shops`, `henchmen`, `tileTypes` (`tile-types.json`), `recipes`, `npcs`, `quests`, `dungeons`, `skills`, `skillSlotSchedules` (`skill-slots.json`), `designNotes` (`design-notes.json`). A player save or guild/trade file set aside as `.unreadable-<ms>` can be repaired by hand and renamed back while the service is stopped.

## Data folder convention

Everything in `data/` is persisted behind a **swappable interface** so the storage backend can be changed from JSON files to a database without modifying consumers:

- **Game state**: `GameStateStore` interface (`server/src/game/GameStateStore.ts`) → currently `JsonFileStore`
- **Sessions**: express-session `Store` class → currently `JsonSessionStore` (`server/src/auth/JsonSessionStore.ts`)
- **Accounts**: `AccountStore` reads/writes `data/accounts.json` directly (should be interfaced when migrating to a DB). Each account stores: `email`, `username`, `verified`, `createdAt`, `lastActiveAt`, `deactivated?`, `reactivationRequest?`, `sessionHistory?` (last 10 `SessionRecord` entries with `deviceToken`, `ip`, `userAgent`, `timestamp`). `findByUsername` reads an in-memory index of lowercased usernames instead of walking the accounts, because `PlayerManager.getSocialState` calls it once per account on every state push. The index is not persisted; `load` and `setUsername` rebuild it, so a username must only ever change through `setUsername`. If the file repeats a name, the earliest account keeps it
- **Invite list**: `InviteListStore` reads/writes `data/invite-list.json` (a JSON array of lowercase emails) — the admin-managed allow list used alongside `ADMIN_EMAILS` when `INVITE_ONLY=true` (see `docs/architecture/auth.md`)
- **API tokens**: `ApiTokenStore` (`server/src/auth/ApiTokenStore.ts`) reads/writes `data/api-tokens.json` (a JSON array of records) — per-admin bearer credentials for the MCP server and the REST admin API. Secrets are stored as sha256 hashes, never in the clear; `lastUsedAt` is buffered in memory and flushed on a 60-second timer rather than written per request (see `docs/architecture/auth.md` → "API tokens")
- **Guilds**: `GuildStore` reads/writes `data/guilds.json`
- **Game content**: `ContentStore` reads/writes `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json`, `data/encounters.json`, `data/sets.json`, `data/shops.json`, `data/henchmen.json`, `data/tile-types.json`, `data/recipes.json`, `data/npcs.json`, `data/quests.json`, `data/dungeons.json`, `data/skills.json`, `data/skill-slots.json`, `data/design-notes.json`. Auto-seeds from `SEED_*` constants only when none of these files exist (NPCs and henchmen only seed when `NODE_ENV !== 'production'`; quests and design notes are never seeded); a damaged file stops the boot (see Damaged data files).
- **Boot backups**: `data/boot-backups/<time>/`, written by `backUpDataFiles` at the start of `ContentStore.load` (see Damaged data files)
- **Chat**: Stored per-player in `PlayerSaveData.chatHistory` (saved with each player's JSON file)
- **Mailbox**: `MailboxStore` interface (`server/src/game/social/MailboxStore.ts`) → currently `JsonMailboxStore`, which reads/writes `data/mailboxes/entries.json`. It has its own folder because a file directly in `data/` would share a path with the player of that name. Live state lives in `MailboxSystem`, written in each periodic save along with the players (see `docs/architecture/social.md` → Gift mailbox). Entries in an older save's `PlayerSaveData.mailbox` are merged in by id through `PlayerSession.consumeInitialMailbox()`.
- **Notifications**: Stored per-player in `PlayerSaveData.notifications` (live state in `NotificationSystem`, restored via `consumeInitialNotifications`/`setInbox`, snapshotted back via a `getNotifications` callback). `notificationPreferences` and `pushSubscriptions` are plain fields on `PlayerSession` (like `blockedUsers`) since only the owning player ever mutates them. See `docs/architecture/notifications.md`.
- **Trades**: `TradeStore` reads/writes `data/trades.json` (only active `pending`/`countered` trades). Restored at startup via `TradeSystem.restoreFromSaveData`.
- **Versions**: `VersionStore` reads/writes `data/versions/manifest.json` + `data/versions/{id}.json`; a missing manifest starts fresh, a damaged one stops the boot
- **Artwork**: `AssetStore` (`server/src/game/AssetStore.ts`) reads/writes the PNG folders for all 17 registered asset kinds (`data/item-artwork/`, `data/monster-artwork/`, `data/class-icons/`, …), each folder's path taken from `ASSET_KIND_INFO` in `shared/src/assets/AssetKinds.ts`. Artwork is live and global — deliberately **not** part of `ContentSnapshot`, so publish/rollback never moves a PNG. See `docs/architecture/content.md` → "Artwork & imagery".

**When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.**

**A new file directly in `data/` also goes in `STORE_FILE_NAMES`** (`server/src/auth/reservedUsernames.ts`), because `JsonFileStore` keeps player saves in the same folder. `server/tests/ReservedUsernames.test.ts` checks this.

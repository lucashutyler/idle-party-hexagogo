# Persistence

## State persistence

Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. The journal kept in memory and in saves is 1000 entries; each `state` message carries only the last `STATE_LOG_TAIL` (100). Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation) — each restored party's timer starts only after its members, dungeon run and henchmen are restored (`PartyBattleManager.startEntry`); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added.

Saved state per player (`PlayerSaveData`):
- `username`, `battleCount`, `combatLog` (the journal — last 1000 entries: victory/defeat, rewards, level-ups, moves, unlocks and server notices; per-hit combat lines are live-only and never journaled, see `combat.md` → Journal vs live log), `unlockedKeys`, `position`, `mapId` (which map the party is on; absent on legacy saves → defaults to the world's default map on restore), `target`, `movementQueue`
- `character` (className, level, xp, inventory, equipment, skillLoadout) — optional; old saves or saves with invalid/legacy classes get `character = null` on load, forcing class re-selection. Within `skillLoadout`, only `equippedSkills` is authoritative — `unlockedSkills` is derived and recomputed from level + skill content on every restore (`reconcileSkillLoadout` also clears slots whose skill no longer exists or lost availability). Legacy `skillPoints` is ignored on load.
- `friends`, `outgoingFriendRequests`, `blockedUsers` — optional; default to empty
- `guildId`, `partyId`, `partyRole`, `partyGridPosition` — party state survives server restarts for multi-player parties
- `chatHistory` (last 1000 messages), `chatSendChannel`, `chatDmTarget`
- `mailbox` (only in saves from before `MailboxStore`: read on load and never written)
- `activeQuests`, `completedQuests`, `weeklyCompletions` — quest state (see `docs/architecture/content.md` Quest system)
- `dungeonRun` (`DungeonRunState`: `{ dungeonId, currentFloorIndex, entrance, checkpointPhase?, wipes?, rewardedPhases? }`) — active dungeon run, so an in-progress dive (and its boss checkpoint and wipe budget) continues offline and across restarts; `clearedDungeons` (string[]) — dungeons this player has cleared at least once, gating one-time first-clear rewards (see `docs/architecture/content.md` Dungeon system). `dungeonRun` is sourced from the `PartyBattleManager` entry at save time (spread copy) and re-applied via `restoreDungeonRun` (floor index validated, phase clamped) after the party's battle entry is rebuilt on restore.
- `dungeonCheckpoints` (`Record<dungeonId, DungeonCheckpoint { floorIndex, phase, wipes, rewardedPhases, at }>`) — resume points; kept equal to the live run while the party is on a checkpoint floor and stored when a party or member leaves one; expire after 7 days (see `combat.md` → Boss checkpoints and `content.md` → Dungeon system)
- `monsterKills` (`Record<monsterDefId, number>`) — lifetime kills for kill mastery; held in a null-prototype object so monster ids such as `constructor` or `__proto__` count like any other
- `combatPrefs` (`{ autoRetreatBelowPct: 0 | 25 | 40 | 60 }`) — sanitised on load; absent → `DEFAULT_COMBAT_PREFS` (25)
- `autoRetreatNotified` — the one-time auto-retreat notification was sent
- `awayLedger` (the "while you were away" ledger still recording) and `pendingRecap` (a finished recap not yet acknowledged) — `AwayLedger | null`, rebuilt field by field on load (counters finite and ≥ 0, levels default to the character's, lists filtered to valid entries and capped, unknown rarities and moment kinds dropped; no `id`/`since` → `null`). Every restored character with no saved ledger gets one opened at boot, since nobody is connected yet (see `combat.md` → While you were away)
- `notifications` (capped notification inbox, last 50 entries), `notificationPreferences` (per-category/channel opt-ins), `pushSubscriptions` (registered Web Push endpoints) — see `docs/architecture/notifications.md`

The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment.

All of the fields above are optional. `PlayerSession.fromSaveData` bypasses the constructor, so every new field is assigned explicitly there (and cleaned — malformed values fall back to their defaults). **Master reset** (`resetForMasterReset`) clears `monsterKills`, `dungeonCheckpoints`, `awayLedger` and `pendingRecap` along with the character, but keeps `combatPrefs` and `autoRetreatNotified`; presence is then re-evaluated for every session, so offline players get a fresh ledger.

Guild data is saved separately in `data/guilds.json`. Active async trades are saved separately in `data/trades.json` via `TradeStore`. Game content is saved separately via `ContentStore`.

The store interface is swappable for SQLite/Postgres.

## Data folder convention

Everything in `data/` is persisted behind a **swappable interface** so the storage backend can be changed from JSON files to a database without modifying consumers:

- **Game state**: `GameStateStore` interface (`server/src/game/GameStateStore.ts`) → currently `JsonFileStore`
- **Sessions**: express-session `Store` class → currently `JsonSessionStore` (`server/src/auth/JsonSessionStore.ts`)
- **Accounts**: `AccountStore` reads/writes `data/accounts.json` directly (should be interfaced when migrating to a DB). Each account stores: `email`, `username`, `verified`, `createdAt`, `lastActiveAt`, `deactivated?`, `reactivationRequest?`, `sessionHistory?` (last 10 `SessionRecord` entries with `deviceToken`, `ip`, `userAgent`, `timestamp`)
- **Invite list**: `InviteListStore` reads/writes `data/invite-list.json` (a JSON array of lowercase emails) — the admin-managed allow list used alongside `ADMIN_EMAILS` when `INVITE_ONLY=true` (see `docs/architecture/auth.md`)
- **API tokens**: `ApiTokenStore` (`server/src/auth/ApiTokenStore.ts`) reads/writes `data/api-tokens.json` (a JSON array of records) — per-admin bearer credentials for the MCP server and the REST admin API. Secrets are stored as sha256 hashes, never in the clear; `lastUsedAt` is buffered in memory and flushed on a 60-second timer rather than written per request (see `docs/architecture/auth.md` → "API tokens")
- **Guilds**: `GuildStore` reads/writes `data/guilds.json`
- **Game content**: `ContentStore` reads/writes `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json`, `data/sets.json`, `data/shops.json`, `data/henchmen.json`, `data/tile-types.json`, `data/npcs.json`, `data/quests.json`, `data/dungeons.json`, `data/skills.json`, `data/skill-slots.json`, `data/design-notes.json`. Auto-seeds from `SEED_*` constants if files missing (NPCs and henchmen only seed when `NODE_ENV !== 'production'`; quests and design notes are never seeded).
- **Chat**: Stored per-player in `PlayerSaveData.chatHistory` (saved with each player's JSON file)
- **Mailbox**: `MailboxStore` interface (`server/src/game/social/MailboxStore.ts`) → currently `JsonMailboxStore`, which reads/writes `data/mailboxes/entries.json`. It has its own folder because a file directly in `data/` would share a path with the player of that name. Live state lives in `MailboxSystem`, written in each periodic save along with the players (see `docs/architecture/social.md` → Gift mailbox). Entries in an older save's `PlayerSaveData.mailbox` are merged in by id through `PlayerSession.consumeInitialMailbox()`.
- **Notifications**: Stored per-player in `PlayerSaveData.notifications` (live state in `NotificationSystem`, restored via `consumeInitialNotifications`/`setInbox`, snapshotted back via a `getNotifications` callback). `notificationPreferences` and `pushSubscriptions` are plain fields on `PlayerSession` (like `blockedUsers`) since only the owning player ever mutates them. See `docs/architecture/notifications.md`.
- **Trades**: `TradeStore` reads/writes `data/trades.json` (only active `pending`/`countered` trades). Restored at startup via `TradeSystem.restoreFromSaveData`.
- **Versions**: `VersionStore` reads/writes `data/versions/manifest.json` + `data/versions/{id}.json`
- **Artwork**: `AssetStore` (`server/src/game/AssetStore.ts`) reads/writes the PNG folders for all 17 registered asset kinds (`data/item-artwork/`, `data/monster-artwork/`, `data/class-icons/`, …), each folder's path taken from `ASSET_KIND_INFO` in `shared/src/assets/AssetKinds.ts`. Artwork is live and global — deliberately **not** part of `ContentSnapshot`, so publish/rollback never moves a PNG. See `docs/architecture/content.md` → "Artwork & imagery".

**When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.**

**A new file directly in `data/` also goes in `STORE_FILE_NAMES`** (`server/src/auth/reservedUsernames.ts`), because `JsonFileStore` keeps player saves in the same folder. `server/tests/ReservedUsernames.test.ts` checks this.

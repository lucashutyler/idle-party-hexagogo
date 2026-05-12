# Persistence

## State persistence

Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added.

Saved state per player (`PlayerSaveData`):
- `username`, `battleCount`, `combatLog` (last 1000 entries), `unlockedKeys`, `position`, `target`, `movementQueue`
- `character` (className, level, xp, inventory, equipment, skillLoadout, skillPoints) — optional; old saves or saves with invalid/legacy classes get `character = null` on load, forcing class re-selection
- `friends`, `outgoingFriendRequests`, `blockedUsers` — optional; default to empty
- `guildId`, `partyId`, `partyRole`, `partyGridPosition` — party state survives server restarts for multi-player parties
- `chatHistory` (last 1000 messages), `chatSendChannel`, `chatDmTarget`
- `mailbox` (pending gift entries)

The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment.

Guild data is saved separately in `data/guilds.json`. Active async trades are saved separately in `data/trades.json` via `TradeStore`. Game content is saved separately via `ContentStore`.

The store interface is swappable for SQLite/Postgres.

## Data folder convention

Everything in `data/` is persisted behind a **swappable interface** so the storage backend can be changed from JSON files to a database without modifying consumers:

- **Game state**: `GameStateStore` interface (`server/src/game/GameStateStore.ts`) → currently `JsonFileStore`
- **Sessions**: express-session `Store` class → currently `JsonSessionStore` (`server/src/auth/JsonSessionStore.ts`)
- **Accounts**: `AccountStore` reads/writes `data/accounts.json` directly (should be interfaced when migrating to a DB). Each account stores: `email`, `username`, `verified`, `createdAt`, `lastActiveAt`, `deactivated?`, `reactivationRequest?`, `sessionHistory?` (last 10 `SessionRecord` entries with `deviceToken`, `ip`, `userAgent`, `timestamp`)
- **Guilds**: `GuildStore` reads/writes `data/guilds.json`
- **Game content**: `ContentStore` reads/writes `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json`, `data/sets.json`, `data/shops.json`, `data/tile-types.json`, `data/dungeons.json`. Auto-seeds from `SEED_*` constants if files missing.
- **Chat**: Stored per-player in `PlayerSaveData.chatHistory` (saved with each player's JSON file)
- **Mailbox**: Stored per-player in `PlayerSaveData.mailbox` (gift entries persist with each player's JSON file). Live state lives in `MailboxSystem` at runtime; `PlayerSession.consumeInitialMailbox()` ferries the saved entries into `MailboxSystem` on load, and `PlayerSession.toSaveData` snapshots the live mailbox back via the `getMailbox` callback.
- **Trades**: `TradeStore` reads/writes `data/trades.json` (only active `pending`/`countered` trades). Restored at startup via `TradeSystem.restoreFromSaveData`.
- **Versions**: `VersionStore` reads/writes `data/versions/manifest.json` + `data/versions/{id}.json`

**When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.**

# CLAUDE.md

## Project Overview

Idle Party RPG — a multiplayer idle RPG on a hexagonal world map. Characters fight, move, and progress 24/7 whether the player is connected or not. Built as a monorepo with a web client, game server, and world manager (admin dashboard).

## Branch Policy

**`main` is a locked branch.** All changes must go through pull requests — never commit directly to `main`.

## Game Design Philosophy

- **One character per player** — all mechanics incentivize this
- **Weak solo, strong together** — every class benefits greatly from partying with any other class
- **Henchmen** — hireable NPCs for players without friends online yet
- **Always running** — game state persists and progresses whether connected or not
- **Always in a party** — every player is always in a party, even if solo. A solo party is auto-created on login/restore. Leaving a multi-player party auto-creates a new solo party. Players can always position themselves on the 3x3 grid.
- **Always in combat** — the party is never truly idle; combat triggers continuously on every tile (towns, forests, etc.). Combat is shared per-party — all members fight the same monsters together. Combat is tick-based (1s per tick): each alive player attacks a target monster, then each alive monster attacks a target player, using grid-based targeting (same row first, front-line preference, scan up before down). Battles end when all monsters are dead (victory) or all players reach 0 HP (defeat). The result/movement cadence remains unchanged.
- **Server authoritative** — combat resolved server-side, updates pushed to clients
- **Database-driven content** — tiles, monsters, quests stored in DB, managed via game manager
- **Instanced worlds** — soft-capped at 1000 players; invites allowed beyond cap, no random joins
- **Web-first** — mobile-friendly is the primary use case, desktop fully supported

## Monorepo Structure

npm workspaces monorepo. `npm run dev` runs server + client concurrently.

```
shared/                        @idle-party-rpg/shared — pure logic, types, constants
├── src/
│   ├── hex/
│   │   ├── HexUtils.ts        # Hex math (cube coordinates, conversions)
│   │   ├── HexTile.ts         # Tile types, configs, HexTile class
│   │   ├── HexGrid.ts         # Hex grid data structure & algorithms
│   │   ├── HexPathfinder.ts   # A* pathfinding on hex grid
│   │   └── MapSchema.ts       # World/tile types (WorldTileDefinition, WorldData), seed data constants
│   ├── systems/
│   │   ├── BattleTypes.ts     # Battle/protocol types & constants
│   │   ├── CharacterStats.ts  # Character types, XP/leveling, stat allocation
│   │   ├── CombatEngine.ts    # Pure tick-based combat resolution (solo + party with grid targeting)
│   │   ├── ItemTypes.ts       # Item types, seed data (SEED_ITEMS), inventory/equipment pure logic (parameterized)
│   │   ├── MonsterTypes.ts    # Monster types, seed data (SEED_MONSTERS), encounter factory (parameterized)
│   │   ├── ZoneTypes.ts       # Zone types, seed data (SEED_ZONES), zone lookup (parameterized)
│   │   ├── UnlockSystem.ts    # Tile unlock tracking & progression
│   │   └── SocialTypes.ts     # Social types: friends, guild, party, chat, blocking
│   └── index.ts               # Barrel export
└── tests/                     # Vitest tests for shared logic

client/                        @idle-party-rpg/client — Phaser 3 web client
├── src/
│   ├── main.ts                # Entry point — imports CSS, creates App
│   ├── App.ts                 # App shell — auth flow → username → game screens + nav
│   ├── screens/
│   │   ├── ScreenManager.ts   # Screen show/hide with activate/deactivate lifecycle
│   │   ├── LoginScreen.ts     # Email login screen (shown first)
│   │   ├── UsernameScreen.ts  # Username choice screen (after email verification)
│   │   ├── OfflineScreen.ts   # "Server unavailable" screen with retry button
│   │   ├── ClassSelectScreen.ts # Class selection screen (shown for new/reset players)
│   │   ├── ApproveScreen.ts   # Magic link landing — approves login, no session created
│   │   ├── CombatScreen.ts    # Primary screen — battle stage, floating HP bars above sprites
│   │   ├── MapScreen.ts       # Phaser wrapper — lazy-loads game, zoom controls, tile modal
│   │   ├── CharacterScreen.ts # Character stats, XP bar, class passive info
│   │   ├── ItemsScreen.ts     # Equipment slots + inventory list with equip/unequip
│   │   ├── SocialScreen.ts    # Social tab — sub-tabs: Users, Friends, Guild, Party, Chat
│   │   └── PlaceholderScreen.ts # Reusable "Coming soon" for future tabs
│   ├── admin/
│   │   ├── main.ts            # Admin entry point — imports CSS, creates AdminApp
│   │   └── AdminApp.ts        # World Manager dashboard (fetches from /api/admin/content, map viewer)
│   ├── scenes/
│   │   └── WorldMapScene.ts   # Phaser scene — hex rendering, input, camera, zone filtering
│   ├── entities/
│   │   └── Party.ts           # Client party — sprites, tweens, visuals
│   ├── network/
│   │   ├── AuthClient.ts      # REST client for /auth/* endpoints
│   │   ├── GameClient.ts      # WebSocket client — cookie-based auth, subscriber + chat listeners
│   │   └── WorldCache.ts      # Client world data cache (from GET /api/world), unlock-based fog of war
│   ├── ui/
│   │   ├── BottomNav.ts       # 6-tab pixel-styled bottom navigation bar
│   │   └── TileInfoModal.ts   # Modal for tile click — shows info, players, invite/chat buttons
│   └── styles/
│       └── pixel-theme.css    # Global retro RPG styles, animations, layout
├── index.html                 # App shell DOM (login + username + screen containers + nav)
├── admin.html                 # World Manager entry HTML (separate from game client)
└── vite.config.ts             # Vite config with multi-page build + /auth, /api proxies

server/                        @idle-party-rpg/server — Node.js game server
├── src/
│   ├── index.ts               # Express + WS server, session middleware, auth + admin routes
│   ├── admin/
│   │   ├── adminMiddleware.ts # Admin auth middleware (checks ADMIN_EMAILS env var)
│   │   └── adminRoutes.ts     # Admin API routes: /api/admin/overview, /api/admin/accounts, /api/admin/content
│   ├── auth/
│   │   ├── AccountStore.ts    # Email→account JSON persistence (data/accounts.json)
│   │   ├── TokenStore.ts      # In-memory magic link token store (15m expiry)
│   │   ├── EmailService.ts    # AWS SES email sending (dev: console log)
│   │   ├── JsonSessionStore.ts # File-backed express-session store (data/sessions/)
│   │   ├── authRoutes.ts      # REST endpoints: login, verify, session, username, logout
│   │   └── session.d.ts       # express-session type augmentation
│   └── game/
│       ├── ContentStore.ts     # Loads/saves game content JSON (data/monsters|items|zones|world.json), seeds defaults
│       ├── GameLoop.ts        # Game init (ContentStore + grid + PlayerManager), periodic saves, shutdown
│       ├── PlayerManager.ts   # Maps usernames → sessions, WebSocket routing, social wiring
│       ├── PlayerSession.ts   # Per-player state (character, unlocks, combat log, social)
│       ├── PartyBattleManager.ts # Shared combat & movement per party (owns ServerParty + ServerBattleTimer)
│       ├── ServerBattleTimer.ts # Server battle timer (tick-based party combat loop)
│       ├── ServerParty.ts     # Server party state (no rendering)
│       ├── GameStateStore.ts  # GameStateStore interface + PlayerSaveData type
│       ├── JsonFileStore.ts   # JSON-file-based persistence (data/<username>.json)
│       ├── VersionStore.ts    # Content version snapshots (data/versions/)
│       └── social/
│           ├── FriendsSystem.ts # Friend request system (send/accept/decline/revoke, two-way)
│           ├── GuildSystem.ts   # Guild create/join/leave/invite (level 20+ to create)
│           ├── GuildStore.ts    # Guild persistence (data/guilds.json)
│           ├── PartySystem.ts   # Party create/invite/accept/decline/leave/kick, 3x3 grid, owner/leader/member roles, max 5
│           └── ChatSystem.ts    # Chat message creation, routing, block filtering
└── tests/
    ├── FriendsSystem.test.ts  # Friends system unit tests (vitest)
    └── PartySystem.test.ts    # Party system unit tests (vitest)

data/                          Persistent runtime data (gitignored, created at runtime)
├── <username>.json            # Per-player game state saves (includes chat history)
├── accounts.json              # Email→account mapping
├── guilds.json                # Guild data
├── monsters.json              # Monster definitions (loaded by ContentStore, auto-seeded)
├── items.json                 # Item definitions (loaded by ContentStore, auto-seeded)
├── zones.json                 # Zone definitions (loaded by ContentStore, auto-seeded)
├── world.json                 # World map tile definitions (loaded by ContentStore, auto-seeded)
├── versions/                  # Version snapshots
└── sessions/                  # Express session files (one .json per session)

deploy/                        Deployment config files
├── idle-party-rpg.service     # systemd unit file (Restart=always)
└── ipr-site.conf.template     # nginx site config template ({{DOMAIN}} placeholder)

.github/
└── workflows/
    └── deploy.yml             # GitHub Actions: push to main → SSH deploy + restart

setup-prod.sh                  Production setup (validates deps, prompts for config, installs service)
setup-dev.sh                   Dev setup for macOS/Linux (validates deps, installs, builds)
setup-dev.ps1                  Dev setup for Windows PowerShell
```

## Commands

```bash
npm run dev          # Start server (:3001) + client (:3000) concurrently
npm run dev:client   # Client only
npm run dev:server   # Server only
npm run build        # Build shared → client → server
npm start            # Production: NODE_ENV=production, serves client + WS from one port
npm run test         # Run all tests (vitest)
npm run test:shared  # Shared package tests only
npm run typecheck    # tsc --build (all packages)
```

**Worktree build quirk**: The worktree has no `node_modules` — npm workspace symlinks resolve through the main repo's `node_modules`, which points to the main repo's `shared/dist/`. If the worktree's shared source has diverged from main, `tsc` will see stale types and report false errors. The shared build script auto-detects worktrees and copies `dist/` to the main repo after `tsc`, so `npm run build` handles this automatically.

## Architecture & Patterns

- **Hex coordinates**: Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px
- **Multi-screen app shell**: DOM-based screen switching (not Phaser scenes). `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-loads Phaser on first visit.
- **Email-based magic link auth**: Auth is handled over REST (`/auth/*`), not WebSocket. Sessions use `express-session` with httpOnly cookies (30-day expiry), persisted to disk via `JsonSessionStore` (survives server restarts/deploys). Account data (email, username, verified status) is stored in `data/accounts.json` via `AccountStore`. Magic link tokens are in-memory with 15-minute expiry (`TokenStore`). Username is changeable later. **Dev flow**: Enter email → token returned directly → auto-verified → session created on same browser → game. **Prod flow (approve/poll)**: Enter email → magic link emailed → requesting browser polls `GET /auth/login-status?loginId=...` every 2s. User clicks magic link on any device → `POST /auth/approve` marks login approved (no session on approving device, shows "Sign in approved!"). Requesting browser's next poll detects approval → session created on that response → game. `ApproveScreen` handles the magic link landing; `LoginScreen` manages the polling/waiting UI.
- **WebSocket auth via session cookie**: WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie.
- **Per-player game state**: Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.
- **GameClient subscriber pattern**: `subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).
- **Phaser isolation**: Phaser only runs when the Map tab is active. `game.loop.sleep()`/`wake()` halts/restarts the entire RAF loop. On re-activation, state is snapped (not tweened) so the player sees "where I am now" with no catch-up animation.
- **Browser tab resume**: On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).
- **Event-driven**: Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync
- **State machines**: `ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). Each party's battle loop runs continuously and never stops: `battle` → `result` (1s celebration/move window) → `battle` → … Movement happens instantly at the start of the result window; the client animates the tween during the celebration pause. Battle duration is determined by tick-based HP combat (1s per tick).
- **Class system**: 5 playable classes designed to be weak solo, strong together. `CharacterStats.ts` defines `ClassDefinition` with `baseStats`, `hpMultiplier`, `attackStat: StatName | null`, and passive scaling fields. Classes: **Knight** (null attack, 1.5x HP, physical damage reduction 2+level), **Archer** (DEX attack, 0.2x HP), **Priest** (null attack, 1.0x HP, party-wide magical damage reduction 2+level), **Mage** (INT attack, 0.2x HP), **Bard** (null attack, 0.3x HP, +20% all stats per party member). Legacy `Adventurer` class is invalid — existing saves with Adventurer get reset, forcing class selection. Stats are fixed at class base values — no stat increases on level-up; class passives scale with level instead. Class selection screen (`ClassSelectScreen.ts`) shown after login for new/reset players.
- **Damage types**: Monsters have `damageType: 'physical' | 'magical'` (goblin/bandit = physical, wolf = magical). Knight's physical reduction applies only to physical damage (target only). Priest's magical reduction applies party-wide to magical damage. Equipment damage reduction applies to physical damage only.
- **Character & leveling**: Each player has a `CharacterState` (class, level, XP, stats). XP is earned on victory (`XP_PER_VICTORY = 10`). XP to next level = `100 * currentLevel`. Stats do not increase on level-up. Max HP = `floor((30 + (level-1)*5 + CON) * hpMultiplier)`.
- **Combat engine**: Pure functions in `CombatEngine.ts`. Solo: `createCombatState()`/`processTick()` — player attacks first alive monster (attackStat ± 2, min 1), then all alive monsters attack player. Party: `createPartyCombatState()`/`processPartyTick()` — all alive players attack targets, then all alive monsters attack targets. Player damage uses class `attackStat` (null = baseDamage 0, only variance + equip, min 1). Monster damage is reduced by Knight physical reduction or Priest magical reduction depending on `damageType`. Bard stat buff is applied at combat state creation time. `findTarget()` implements grid-based targeting on the 3x3 grid (positions 0-8): row = floor(pos/3), col = pos%3. Same row first; players prefer low-column monsters (front), monsters prefer high-column players (front); if no same-row target, scan up (lower row) then down (higher row). Equipment bonuses (`bonusAttackMin/Max`, `damageReductionMin/Max`) apply per-combatant.
- **Data-driven content (ContentStore)**: Game content (monsters, items, zones, world map) is stored in `data/*.json` files, loaded at startup by `ContentStore` (`server/src/game/ContentStore.ts`). If files are missing, ContentStore seeds them with defaults from `SEED_MONSTERS`, `SEED_ITEMS`, `SEED_ZONES`, and a hand-crafted world map. ContentStore follows the `GuildStore` pattern (in-memory Maps + atomic JSON persistence). Content is NOT exposed via a public API — instead, the server sends only what each player needs.
- **Parameterized shared functions**: Pure functions in shared that previously referenced module-level constants (`ITEMS`, `MONSTERS`, `ZONES`) now accept explicit data parameters. This allows the server to pass runtime-loaded content from ContentStore. E.g., `createEncounter(zoneId, monsters, zones)`, `equipItem(inv, equip, id, items)`, `computeEquipmentBonuses(equip, items)`, `getZone(zoneId, zones)`. The old constants are renamed to `SEED_*` and serve as seed data / test fixtures.
- **Zone system**: Each `HexTile` has a `zone` string property. `ZoneTypes.ts` defines `ZoneDefinition` with encounter tables (weighted monster selection). Current zones: `hatchetmill` (Lv1 goblins, starting village), `darkwood` (goblins, wolves, bandits), and `crystal_caves` (goblins, wolves, bandits). `createEncounter(zoneId, monsters, zones)` uses the zone's encounter table for weighted random monster/count selection. Zone display name is sent to the client in `ServerStateMessage.zoneName`.
- **Monster system**: `MonsterTypes.ts` defines `MonsterDefinition` type and `SEED_MONSTERS` catalog (goblin, wolf, bandit) with `drops?: ItemDrop[]` and `damageType: DamageType` per monster, and `createEncounter(zoneId, monsters, zones)` factory with zone-aware weighted encounters. Each `MonsterInstance` has a `gridPosition: PartyGridPosition` for combat grid placement and inherits `damageType` from its definition.
- **Item & equipment system**: `ItemTypes.ts` defines items, rarities (`janky` 40%, `common` 25%), and equipment slots (`head`, `chest`, `hand`, `foot`). Items stack up to 99 in inventory. Equipment modifies combat: `bonusAttackMin/Max` adds to player damage, `damageReductionMin/Max` reduces incoming monster damage. Pure functions handle inventory/equipment operations (`addItemToInventory`, `equipItem`, `unequipItem`, `computeEquipmentBonuses`, `rollDrops`) — all accept explicit `items: Record<string, ItemDefinition>` parameter. Drops are rolled per-monster on victory. The `ItemsScreen` uses item definitions from `ServerStateMessage.itemDefinitions` (only items the player owns). Current seed items: Janky Helmet (head, 0-1 reduction), Rusty Dagger (hand, 1-3 attack), Leather Vest (chest, 1-2 reduction), Mangy Pelt (non-equippable material).
- **World map & room names**: The world map is defined in `data/world.json` as an array of `WorldTileDefinition` objects, each with `col`, `row`, `type` (TileType), `zone` (zone ID), and `name` (room name, required). Every tile has an evocative room name (e.g., "Town Square", "Blacksmith", "Thick Trees"). The server loads this via `ContentStore` and builds the `HexGrid` at startup. The client receives ALL tiles via `GET /api/world` (auth'd) on login; fog of war rendering is determined client-side from `state.unlocked`.
- **Fog of war (unlock-based)**: Fog of war is driven entirely by the existing `unlockedKeys` from `UnlockSystem` — no separate discovery tracking. The server sends all tiles to the client; the client determines visibility from `state.unlocked` (sent every tick). Three-tier rendering: **unlocked tiles** (full brightness, real icons, room name visible on click), **zone-unlocked tiles** (zone has at least one unlocked tile — dimmed, real tile type icons shown, room name hidden), **foggy tiles** (zone not yet unlocked — very dim, cloud icons: ☁️ for traversable, 🌑 for non-traversable). Zone names are always visible on all tiles. Players can click and attempt to travel to any visible tile regardless of fog state. Zone unlock is computed client-side by `WorldCache.updateUnlocked()` from the unlock keys.
- **WorldCache (client)**: `WorldCache` (`client/src/network/WorldCache.ts`) is the client-side cache for world data. Loaded once from `GET /api/world` on login (in parallel with WS connect). Stores all tiles, start position, and computes unlock state from `state.unlocked` cube keys each tick. `updateUnlocked(cubeKeys)` converts cube→offset coordinates, tracks which tiles and zones are unlocked, and returns whether the set changed (triggering re-render). The `WorldMapScene` builds its `HexGrid` from WorldCache data.
- **Server-side combat log**: `PlayerSession` maintains the last 100 log entries (battle start/end, damage, level-ups, movement, tile unlocks) with a running `battleCount`. Both are included in every `ServerStateMessage`. The client `CombatScreen` is a pure renderer of the server-provided log — no client-side state-transition tracking.
- **Other players on map**: Each state message includes `otherPlayers: { username, col, row, zone }[]`. WorldMapScene renders same-zone players as individual markers; other-zone players show as count badges on their tile. Positions update on each player's own battle cycle.
- **Room info modal**: Clicking a tile on the map opens a modal showing room name, type, players present, and a "Go to room" button. `TileInfoModal` class handles the DOM overlay. (UI calls tiles "rooms"; code still uses "tile" internally.)
- **Zoom controls**: Mobile-friendly +/- zoom buttons on the map screen, wired to `WorldMapScene.adjustZoom()`.
- **Floating HP bars**: CombatScreen renders HP bars floating above each combat sprite (players and enemies) arranged in grid formation rows (3 rows based on `gridPosition`). Player labels show username (current player highlighted in gold); monster labels show name only. HP shown as percentage bar only. Dead combatants are dimmed.
- **Desktop font scaling**: `@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop.
- **World Manager (admin dashboard)**: Separate client page at `/admin` (dev: `/admin.html`) for viewing server data and game content. Admin auth uses `ADMIN_EMAILS` env var (comma-separated emails). Server-side middleware checks session email against the list (401 if unauthenticated, 403 if not admin). API endpoints at `/api/admin/*` return runtime data (overview stats, accounts with online status) and full unfiltered game content (`GET /api/admin/content` returns all monsters, items, zones, and world data). The map viewer uses HTML5 Canvas with pan/zoom, rendering tiles from the content API. Room names are shown on all tiles (admin sees everything, no fog of war). Built as a separate Vite entry point (`admin.html`) isolated from the game client.
- **Social system**: Full social tab (6th tab) with 5 sub-tabs:
  - **Users**: All registered players (not just online) with search, sort (name/status), filter (all/room/zone/friends/guild/party). Online/offline status dots with group headers when sorted by status. Friend request (Add/Revoke/Accept/Decline based on request state), block/unblock, chat actions per user. Data sourced from `AccountStore.getAllUsernames()`.
  - **Friends**: Request-based two-way friend system. Sections: Incoming requests (Accept/Decline), Online friends, Offline friends, Pending sent (Revoke). Outgoing requests persisted per-player; incoming index rebuilt on player init. Cross-requests auto-accept. Unfriending is symmetric (removes from both players).
  - **Guild**: Create guild (level 20+, 2-20 char name), join, leave, invite members. Guild data persisted in `data/guilds.json`. Leader auto-transfers on leave.
  - **Party**: Every player is always in a party (solo party auto-created, max 5 members). Three-tier role hierarchy: owner > leader > member. Party creator is owner. Owner can promote/demote leaders, transfer ownership, and kick anyone. Leaders can promote members to leader, kick (including other leaders, but not owner), and move the party. Members cannot invite, kick, or move. Pending invite flow: owner/leader invites → target sees pending invite with accept/decline → same-room validated on both invite and accept. Badge indicator on Party tab when invites pending. 3x3 grid positioning for combat formation. Combat is shared — all members fight the same monsters together with grid-based targeting. Movement is party-level (owner/leader moves all members). On victory, each member gets XP/gold/loot independently. Leaving/kicked auto-creates new solo party at current position. If owner leaves, first leader becomes owner; if no leaders, first member becomes owner.
  - **Chat**: WoW-style unified timeline with all channels in one scrollable view, color-coded by channel type. 6 channel types: Room (tile), Zone, Party, Guild, Global, DM. Toggle filter pills to show/hide each channel. Channel selector dropdown for sending (Party/Guild disabled when unavailable). DM autocomplete with validation — message input disabled until valid recipient entered. Chat "buttons" throughout social screens and room modal open DM with that user. Per-user chat history (1000 msgs, saved with player data) — messages persist with the player forever, not with the channel. Blocking (`dm` or `all` levels) filters messages server-side.
- **Social badges**: Badge dot (red) on Social bottom-nav tab when there are pending friend requests, party invites, or unread chat. Red dot badges on sub-tabs: Friends (incoming requests), Party (pending invites), and Chat (unread messages).
- **Social state**: `ClientSocialState` is included in every `ServerStateMessage.social`. Contains friends, incoming/outgoing friend requests, guild info, guild members, party info, pending party invites, outgoing party invites (sent by this player), online players list, all registered players list, blocked users, and chat preferences (send channel + DM target). `PlayerManager` builds this via `getSocialState()` callback on each `PlayerSession`.
- **Separation of concerns**: Phaser Graphics for rendering, HTML/CSS for all non-map UI (camera-independent), pure logic in shared systems
- **A* pathfinding**: Hex distance heuristic with cross-track tie-breaker
- **Visual style**: Pixel/retro RPG — Press Start 2P font, CSS custom properties for theming, CSS keyframe animations for battle states. All UI is vanilla HTML/CSS (no framework).
- **State persistence**: Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added. Saved state per player: `username`, `battleCount`, `combatLog` (last 1000 entries), `unlockedKeys`, `position`, `target`, `movementQueue`, `character` (className, level, xp, stats, priorityStat, inventory, equipment), `friends`, `outgoingFriendRequests`, `blockedUsers`, `guildId`, `partyId`, `partyRole`, `partyGridPosition`, `chatHistory` (last 1000 messages), `chatSendChannel`, `chatDmTarget`. The `character` field is optional in `PlayerSaveData` — old saves get a fresh Level 1 Adventurer on load. The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment. Social fields are optional — old saves default to empty. Party state (`partyId`, `partyRole`, `partyGridPosition`) is saved and restored — multi-player parties survive server restarts. Guild data is saved separately in `data/guilds.json`. Game content is saved separately in `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json` via `ContentStore`. The store interface is swappable for SQLite/Postgres.
- **Client UI state persistence**: Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target) is persisted server-side so it syncs across devices. Incoming chat messages are appended to the DOM without re-rendering the entire chat panel, preserving input focus and typed text.

## Keeping Docs Current

When making changes that affect architecture, patterns, file structure, or game design decisions, **always update this file (CLAUDE.md) and README.md** to reflect the new state. This is especially important for:
- New screens, systems, or major features
- Changes to the file tree or monorepo structure
- New game design decisions or philosophy changes
- Architecture pattern changes (e.g., new subscription models, state management)
- README.md roadmap checkboxes — check items off as they are completed

## State Persistence Maintenance

**When adding or changing any per-player game state** (new systems, new fields on `PlayerSession`, `ServerParty`, etc.), you **must** update the save/restore logic to include the new state:
1. Update `PlayerSaveData` in `GameStateStore.ts` with the new field(s)
2. Update `PlayerSession.toSaveData()` to serialize the new state
3. Update `PlayerSession.fromSaveData()` to restore the new state
4. If the state lives in a sub-system (like `UnlockSystem`), ensure that system supports restoration from saved data

## Data Folder Convention

Everything in `data/` is persisted behind a **swappable interface** so the storage backend can be changed from JSON files to a database without modifying consumers:
- **Game state**: `GameStateStore` interface (`server/src/game/GameStateStore.ts`) → currently `JsonFileStore`
- **Sessions**: express-session `Store` class → currently `JsonSessionStore` (`server/src/auth/JsonSessionStore.ts`)
- **Accounts**: `AccountStore` reads/writes `data/accounts.json` directly (should be interfaced when migrating to a DB)
- **Guilds**: `GuildStore` reads/writes `data/guilds.json`
- **Game content**: `ContentStore` reads/writes `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json`. Auto-seeds from `SEED_*` constants if files missing.
- **Chat**: Stored per-player in `PlayerSaveData.chatHistory` (saved with each player's JSON file)
- **Versions**: `VersionStore` reads/writes `data/versions/manifest.json` + `data/versions/{id}.json`

When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.

## Content Versioning

- **Content versioning**: Admin content edits go through a draft→publish→deploy pipeline. `VersionStore` manages version metadata (`data/versions/manifest.json`) and snapshots (`data/versions/{id}.json`). Each snapshot freezes all game content (monsters, items, zones, world). On deploy, `GameLoop.deployVersion()` replaces live content, rebuilds the hex grid, and relocates parties on unreachable tiles. When adding new content types to the game, they must be included in `ContentSnapshot` (`VersionStore.ts`) and `ContentStore.toSnapshot()`/`replaceAll()`.

## Code Conventions

- **Indentation**: 2 spaces
- **Semicolons**: Always
- **Naming**: PascalCase classes, camelCase methods/properties, UPPER_SNAKE_CASE constants
- **Strict TS**: No implicit any, no unused locals/parameters, no fallthrough in switch
- **Imports**: Client/server import shared via `@idle-party-rpg/shared`; within-package imports use relative paths
- **Class layout**: Properties → constructor → public methods → private methods
- **Error handling**: Defensive checks with early returns
- **README checklists**: The README.md roadmap uses `[x]`/`[ ]` checklists — check items off as they are completed
- **Tests**: Aim for test coverage on all non-rendering logic (systems, utils, pathfinding, server)
- **UI terminology**: In all user-facing text (UI labels, error messages, combat log), refer to hex tiles as **"rooms"**. Code internals (variable names, class names, comments) may still use "tile" — the rename is UI-only.

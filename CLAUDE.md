# CLAUDE.md

## Project Overview

Idle Party RPG — a multiplayer idle RPG on a hexagonal world map. Characters fight, move, and progress 24/7 whether the player is connected or not. Built as a monorepo with a web client, game server, and game manager.

## Branch Policy

**`main` is a locked branch.** All changes must go through pull requests — never commit directly to `main`.

## Game Design Philosophy

- **One character per player** — all mechanics incentivize this
- **Weak solo, strong together** — every class benefits greatly from partying with any other class
- **Henchmen** — hireable NPCs for players without friends online yet
- **Always running** — game state persists and progresses whether connected or not
- **Always in combat** — the party is never truly idle; combat triggers continuously on every tile (towns, forests, etc.). Each player's battle loop starts on login and runs independently. Combat is tick-based (1s per tick): player attacks first alive monster, then all alive monsters attack player. Battles end when all monsters are dead (victory) or player HP reaches 0 (defeat). The result/movement cadence remains unchanged.
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
│   │   ├── MapSchema.ts       # World map definition (will move to DB)
│   │   └── MapData.ts         # Procedural map generation (seeded PRNG, border ring, zones)
│   ├── systems/
│   │   ├── BattleTypes.ts     # Battle/protocol types & constants
│   │   ├── CharacterStats.ts  # Character types, XP/leveling, stat allocation
│   │   ├── CombatEngine.ts    # Pure tick-based combat resolution
│   │   ├── ItemTypes.ts       # Item definitions, inventory/equipment pure logic
│   │   ├── MonsterTypes.ts    # Monster definitions, drops & zone-aware encounters
│   │   ├── ZoneTypes.ts       # Zone definitions, encounter tables, zone lookup
│   │   └── UnlockSystem.ts    # Tile unlock tracking & progression
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
│   │   ├── CombatScreen.ts    # Primary screen — battle stage, HP bars, combat log
│   │   ├── MapScreen.ts       # Phaser wrapper — lazy-loads game, pause/resume
│   │   ├── PartyScreen.ts     # Character stats, XP bar, priority stat selector
│   │   ├── ItemsScreen.ts     # Equipment slots + inventory list with equip/unequip
│   │   └── PlaceholderScreen.ts # Reusable "Coming soon" for future tabs
│   ├── scenes/
│   │   └── WorldMapScene.ts   # Phaser scene — hex rendering, input, camera, other players
│   ├── entities/
│   │   └── Party.ts           # Client party — sprites, tweens, visuals
│   ├── network/
│   │   ├── AuthClient.ts      # REST client for /auth/* endpoints
│   │   └── GameClient.ts      # WebSocket client — cookie-based auth, subscriber pattern
│   ├── ui/
│   │   └── BottomNav.ts       # 5-tab pixel-styled bottom navigation bar
│   └── styles/
│       └── pixel-theme.css    # Global retro RPG styles, animations, layout
├── index.html                 # App shell DOM (login + username + screen containers + nav)
└── vite.config.ts             # Vite config with /auth proxy to server

server/                        @idle-party-rpg/server — Node.js game server
├── src/
│   ├── index.ts               # Express + WS server, session middleware, auth routes
│   ├── auth/
│   │   ├── AccountStore.ts    # Email→account JSON persistence (data/accounts.json)
│   │   ├── TokenStore.ts      # In-memory magic link token store (15m expiry)
│   │   ├── EmailService.ts    # AWS SES email sending (dev: console log)
│   │   ├── JsonSessionStore.ts # File-backed express-session store (data/sessions/)
│   │   ├── authRoutes.ts      # REST endpoints: login, verify, session, username, logout
│   │   └── session.d.ts       # express-session type augmentation
│   └── game/
│       ├── GameLoop.ts        # Game init, periodic saves, shutdown
│       ├── PlayerManager.ts   # Maps usernames → sessions, WebSocket routing
│       ├── PlayerSession.ts   # Per-player state (party, battle timer, unlocks, character)
│       ├── ServerBattleTimer.ts # Server battle timer (tick-based combat loop)
│       ├── ServerParty.ts     # Server party state (no rendering)
│       ├── GameStateStore.ts  # GameStateStore interface + PlayerSaveData type
│       └── JsonFileStore.ts   # JSON-file-based persistence (data/<username>.json)

data/                          Persistent runtime data (gitignored, created at runtime)
├── <username>.json            # Per-player game state saves
├── accounts.json              # Email→account mapping
└── sessions/                  # Express session files (one .json per session)

game-manager/                  @idle-party-rpg/game-manager — placeholder

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

## Architecture & Patterns

- **Hex coordinates**: Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px
- **Multi-screen app shell**: DOM-based screen switching (not Phaser scenes). `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-loads Phaser on first visit.
- **Email-based magic link auth**: Auth is handled over REST (`/auth/*`), not WebSocket. Flow: enter email → receive magic link (dev: auto-verify) → choose username → game. Sessions use `express-session` with httpOnly cookies (30-day expiry), persisted to disk via `JsonSessionStore` (survives server restarts/deploys). In dev (`NODE_ENV !== 'production'`), verification is instant. In production, a magic link is emailed via AWS SES. Account data (email, username, verified status) is stored in `data/accounts.json` via `AccountStore`. Magic link tokens are in-memory with 15-minute expiry (`TokenStore`). Username is changeable later.
- **WebSocket auth via session cookie**: WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie.
- **Per-player game state**: Each player gets their own `PlayerSession` with independent `ServerParty`, `ServerBattleTimer`, and `UnlockSystem`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported (e.g. two browser tabs with the same login both receive state).
- **GameClient subscriber pattern**: `subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).
- **Phaser isolation**: Phaser only runs when the Map tab is active. `game.loop.sleep()`/`wake()` halts/restarts the entire RAF loop. On re-activation, state is snapped (not tweened) so the player sees "where I am now" with no catch-up animation.
- **Browser tab resume**: On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).
- **Event-driven**: Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync
- **State machines**: `ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). Each player's battle loop runs independently and never stops: `battle` → `result` (1s celebration/move window) → `battle` → … Movement happens instantly at the start of the result window; the client animates the tween during the celebration pause. Battle duration is determined by tick-based HP combat (1s per tick).
- **Character & leveling**: Each player has a `CharacterState` (class, level, XP, stats, priority stat). XP is earned on victory (`XP_PER_VICTORY = 10`). XP to next level = `100 * currentLevel`. On level-up, 2 stat points are allocated (to priority stat if set, random otherwise). Max HP = `30 + (level-1)*5 + CON`.
- **Combat engine**: Pure functions in `CombatEngine.ts`. `createCombatState()` initializes combat, `processTick()` resolves one tick: player attacks first alive monster (STR ± 2, min 1 damage), then all alive monsters attack player. Ends on all monsters dead (victory) or player HP ≤ 0 (defeat).
- **Zone system**: Each `HexTile` has a `zone` string property. `ZoneTypes.ts` defines `ZoneDefinition` with encounter tables (weighted monster selection). Current zones: `friendly_forest` (Lv1 goblins) and `darkwood` (goblins, wolves, bandits). `createEncounter(zoneId)` uses the zone's encounter table for weighted random monster/count selection. Zone display name is sent to the client in `ServerStateMessage.zoneName`.
- **Monster system**: `MonsterTypes.ts` defines `MonsterDefinition` catalog (goblin, wolf, bandit) with `drops?: ItemDrop[]` per monster, and `createEncounter(zoneId?)` factory with zone-aware weighted encounters.
- **Item & equipment system**: `ItemTypes.ts` defines items, rarities (`janky` 40%, `common` 25%), and equipment slots (`head`, `chest`, `hand`, `foot`). Items stack up to 99 in inventory. Equipment modifies combat: `bonusAttackMin/Max` adds to player damage, `damageReductionMin/Max` reduces incoming monster damage. Pure functions handle inventory/equipment operations (`addItemToInventory`, `equipItem`, `unequipItem`, `computeEquipmentBonuses`, `rollDrops`). Drops are rolled per-monster on victory. The `ItemsScreen` shows equipment slots (tap to unequip) and inventory (tap equippable items to equip). Current items: Janky Helmet (head, 0-1 reduction), Rusty Dagger (hand, 1-3 attack), Leather Vest (chest, 1-2 reduction), Mangy Pelt (non-equippable material).
- **Procedural map generation**: `MapData.ts` uses a seeded PRNG (mulberry32, seed=42) for deterministic world generation. The schema tiles form the "Friendly Forest" starting zone (~170 tiles). A border ring of mountains/water surrounds it with 4 exit gaps (3 tiles wide each). Beyond the border, ~1300 "Darkwood" wilderness tiles fill a ~45x45 offset-coordinate area (-15 to 28). Both server and client generate identical maps from the same seed — no map data is transmitted over the network.
- **Server-side combat log**: `PlayerSession` maintains the last 100 log entries (battle start/end, damage, level-ups, movement, tile unlocks) with a running `battleCount`. Both are included in every `ServerStateMessage`. The client `CombatScreen` is a pure renderer of the server-provided log — no client-side state-transition tracking.
- **Other players on map**: Each state message includes `otherPlayers: { username, col, row }[]`. WorldMapScene renders them as smaller blue circles with username labels. Other player movement is tweened (400ms). Positions update on each player's own battle cycle.
- **Separation of concerns**: Phaser Graphics for rendering, HTML/CSS for all non-map UI (camera-independent), pure logic in shared systems
- **A* pathfinding**: Hex distance heuristic with cross-track tie-breaker
- **Visual style**: Pixel/retro RPG — Press Start 2P font, CSS custom properties for theming, CSS keyframe animations for battle states. All UI is vanilla HTML/CSS (no framework).
- **State persistence**: Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added. Saved state per player: `username`, `battleCount`, `combatLog` (last 1000 entries), `unlockedKeys`, `position`, `target`, `movementQueue`, `character` (className, level, xp, stats, priorityStat, inventory, equipment). The `character` field is optional in `PlayerSaveData` — old saves get a fresh Level 1 Adventurer on load. The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment. The store interface is swappable for SQLite/Postgres.

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

When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.

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

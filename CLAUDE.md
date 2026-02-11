# CLAUDE.md

## Project Overview

Idle Party RPG — a multiplayer idle RPG on a hexagonal world map. Characters fight, move, and progress 24/7 whether the player is connected or not. Built as a monorepo with a web client, game server, and game manager.

## Game Design Philosophy

- **One character per player** — all mechanics incentivize this
- **Weak solo, strong together** — every class benefits greatly from partying with any other class
- **Henchmen** — hireable NPCs for players without friends online yet
- **Always running** — game state persists and progresses whether connected or not
- **Always in combat** — the party is never truly idle; combat triggers continuously on every tile (towns, forests, etc.). The cycle is: 2s battle → 1s result window → repeat. If moving: 600ms celebration pause, then 400ms movement. If not moving: full 1s pause. The battle loop starts on server init and never stops.
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
│   │   └── MapData.ts         # Map generation from schema
│   ├── systems/
│   │   ├── BattleTypes.ts     # Battle state types & constants
│   │   └── UnlockSystem.ts    # Tile unlock tracking & progression
│   └── index.ts               # Barrel export
└── tests/                     # Vitest tests for shared logic

client/                        @idle-party-rpg/client — Phaser 3 web client
├── src/
│   ├── main.ts                # Entry point — imports CSS, creates App
│   ├── App.ts                 # App shell — wires screens, nav, GameClient
│   ├── screens/
│   │   ├── ScreenManager.ts   # Screen show/hide with activate/deactivate lifecycle
│   │   ├── CombatScreen.ts    # Primary screen — battle stage, timer, combat log
│   │   ├── MapScreen.ts       # Phaser wrapper — lazy-loads game, pause/resume
│   │   └── PlaceholderScreen.ts # Reusable "Coming soon" for future tabs
│   ├── scenes/
│   │   └── WorldMapScene.ts   # Phaser scene — hex rendering, input, camera
│   ├── entities/
│   │   └── Party.ts           # Client party — sprites, tweens, visuals
│   ├── network/
│   │   └── GameClient.ts      # WebSocket client — subscriber pattern, multi-listener
│   ├── ui/
│   │   └── BottomNav.ts       # 5-tab pixel-styled bottom navigation bar
│   └── styles/
│       └── pixel-theme.css    # Global retro RPG styles, animations, layout
├── index.html                 # App shell DOM (screen containers + nav)
└── vite.config.ts

server/                        @idle-party-rpg/server — Node.js game server
├── src/
│   ├── index.ts               # Express + WebSocket server
│   └── game/
│       ├── GameLoop.ts        # Server-side game loop
│       ├── ServerBattleTimer.ts # Server battle timer (setTimeout)
│       └── ServerParty.ts     # Server party state (no rendering)

game-manager/                  @idle-party-rpg/game-manager — placeholder
```

## Commands

```bash
npm run dev          # Start server (:3001) + client (:3000) concurrently
npm run dev:client   # Client only
npm run dev:server   # Server only
npm run build        # Build shared → client → server
npm run test         # Run all tests (vitest)
npm run test:shared  # Shared package tests only
npm run typecheck    # tsc --build (all packages)
```

## Architecture & Patterns

- **Hex coordinates**: Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px
- **Multi-screen app shell**: DOM-based screen switching (not Phaser scenes). `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-loads Phaser on first visit.
- **GameClient subscriber pattern**: `subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately.
- **Phaser isolation**: Phaser only runs when the Map tab is active. `game.loop.sleep()`/`wake()` halts/restarts the entire RAF loop. On re-activation, state is snapped (not tweened) so the player sees "where I am now" with no catch-up animation.
- **Event-driven**: Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync
- **State machines**: `ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). The battle loop runs from server start and never stops: `battle` (2s) → `result` (1s celebration/move window) → `battle` → … Movement happens instantly at the start of the result window; the client animates the tween during the celebration pause.
- **Separation of concerns**: Phaser Graphics for rendering, HTML/CSS for all non-map UI (camera-independent), pure logic in shared systems
- **A* pathfinding**: Hex distance heuristic with cross-track tie-breaker
- **Visual style**: Pixel/retro RPG — Press Start 2P font, CSS custom properties for theming, CSS keyframe animations for battle states. All UI is vanilla HTML/CSS (no framework).

## Keeping Docs Current

When making changes that affect architecture, patterns, file structure, or game design decisions, **always update this file (CLAUDE.md) and README.md** to reflect the new state. This is especially important for:
- New screens, systems, or major features
- Changes to the file tree or monorepo structure
- New game design decisions or philosophy changes
- Architecture pattern changes (e.g., new subscription models, state management)
- README.md roadmap checkboxes — check items off as they are completed

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

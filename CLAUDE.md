# CLAUDE.md

## Project Overview

Idle Party RPG — a multiplayer idle RPG on a hexagonal world map. Characters fight, move, and progress 24/7 whether the player is connected or not. Built as a monorepo with a web client, game server, and game manager.

## Game Design Philosophy

- **One character per player** — all mechanics incentivize this
- **Weak solo, strong together** — every class benefits greatly from partying with any other class
- **Henchmen** — hireable NPCs for players without friends online yet
- **Always running** — game state persists and progresses whether connected or not
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
│   ├── main.ts                # Entry point — Phaser game config
│   ├── scenes/
│   │   └── WorldMapScene.ts   # Main scene — rendering, input, camera
│   ├── entities/
│   │   └── Party.ts           # Client party — sprites, tweens, visuals
│   ├── systems/
│   │   └── BattleTimer.ts     # Client battle timer (Phaser timers)
│   └── ui/
│       └── UIManager.ts       # HTML overlay UI (status bar)
├── index.html
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
- **Event-driven**: Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync
- **State machines**: `BattleTimer` (`moving` | `battle`), `Party` (`idle` | `moving` | `in_battle`)
- **Separation of concerns**: Phaser Graphics for rendering, HTML overlay for UI (camera-independent), pure logic in systems
- **A* pathfinding**: Hex distance heuristic with cross-track tie-breaker

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

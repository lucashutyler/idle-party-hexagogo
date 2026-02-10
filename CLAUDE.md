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

## Monorepo Structure (Target)

```
client/           Phaser 3 web client — tab-based UI (map, character, party, combat, town)
server/           Node.js/TypeScript game server — persistent state, combat resolution
game-manager/     Admin client for game designers — monster, area, quest editors
```

`npm run dev` will run all three subprojects.

## Current Structure (Pre-Monorepo)

All code currently lives in `src/` as a single Phaser client:

```
src/
├── main.ts                    # Entry point — Phaser game config
├── scenes/
│   └── WorldMapScene.ts       # Main scene — rendering, input, camera
├── entities/
│   └── Party.ts               # Party movement, state, visuals
├── map/
│   ├── HexGrid.ts             # Hex grid data structure & algorithms
│   ├── HexTile.ts             # Tile definition & config
│   ├── HexPathfinder.ts       # A* pathfinding on hex grid
│   ├── MapData.ts             # Map generation from schema
│   └── MapSchema.ts           # World map definition (will move to DB)
├── systems/
│   ├── BattleTimer.ts         # Battle state machine & timing
│   └── UnlockSystem.ts        # Tile unlock tracking & progression
├── ui/
│   └── UIManager.ts           # HTML overlay UI (status bar)
└── utils/
    └── HexUtils.ts            # Hex math (cube coordinates, conversions)
```

## Commands

```bash
npm run dev       # Start dev server (currently client only, will run all subprojects)
npm run build     # tsc + vite build → dist/
npm run test      # Run all tests (not yet configured)
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
- **Imports**: Explicit relative paths (no barrel imports)
- **Class layout**: Properties → constructor → public methods → private methods
- **Error handling**: Defensive checks with early returns
- **README checklists**: The README.md roadmap uses `[x]`/`[ ]` checklists — check items off as they are completed
- **Tests**: Aim for test coverage on all non-rendering logic (systems, utils, pathfinding, server)

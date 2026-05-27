# CLAUDE.md

## Project Overview

Idle Party RPG — a multiplayer idle RPG on a hexagonal world map. Characters fight, move, and progress 24/7 whether the player is connected or not. Built as an npm-workspaces monorepo: `shared/` (pure logic + types), `client/` (vanilla TS + three.js world map + DOM UI), `server/` (Node + WebSocket).

## Branch Policy

**`main` is a locked branch.** All changes go through pull requests — never commit directly to `main`.

## Game Design Philosophy

- **One character per player** — all mechanics incentivize this.
- **Weak solo, strong together** — every class benefits greatly from partying with any other class.
- **Henchmen** — hireable NPCs for players without friends online yet.
- **Always running** — game state persists and progresses whether connected or not.
- **Always in a party** — every player is always in a party, even if solo. A solo party is auto-created on login/restore. Leaving a multi-player party auto-creates a new solo party. Players can always position themselves on the 3x3 grid.
- **Always in combat** — the party is never truly idle; combat triggers continuously on every tile (towns, forests, etc.). Combat is shared per-party — all members fight the same monsters together. Combat is tick-based (1s per tick): each alive player attacks a target monster, then each alive monster attacks a target player, using grid-based targeting (same row first, front-line preference, scan up before down). Battles end when all monsters are dead (victory) or all players reach 0 HP (defeat).
- **Server authoritative** — combat resolved server-side, updates pushed to clients.
- **Database-driven content** — tiles, monsters, quests stored in DB, managed via game manager.
- **Instanced worlds** — soft-capped at 1000 players; invites allowed beyond cap, no random joins.
- **Web-first** — mobile-friendly is the primary use case, desktop fully supported.

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

**Dev seed**: when `NODE_ENV !== 'production'`, `GameLoop.init` calls into `server/src/game/DevSeed.ts`, which procedurally injects 20 extra zones / ~1000 rooms (`shared/src/seed/SeedDevWorld.ts`) and 100 bot players grouped into ~30 parties. Both passes are idempotent — the content pass checks for a marker zone (`dev_sunscar_plains`) before merging, and the player pass probes `bot_001`'s save file. To re-seed, delete `data/world.json` + `data/zones.json` (for content) or `data/bot_*.json` (for bots). Bots live in dev zones (col 30+, far from the production starting island) so they don't crowd the real player.

## Architecture

Use `Glob`/`Grep`/`ls` to navigate the source tree — no point duplicating it here. For deeper context on specific subsystems, read the topic docs on demand:

- [`docs/architecture/combat.md`](docs/architecture/combat.md) — combat engine, classes, skill system, damage types, DoT/Ignite/Shield Bash/Martyr invariants, combat log, HP bars, battle state machines.
- [`docs/architecture/content.md`](docs/architecture/content.md) — `ContentStore`, parameterized shared functions, zones, monsters, walls, items, `InventoryView`, sets, dungeons, shops, world map, fog of war, item-gated tiles, tile types, `WorldCache`, content versioning.
- [`docs/architecture/social.md`](docs/architecture/social.md) — Social tab sub-tabs (Party/Guild/Leaderboard, with Chat as a global pop-out from the Chat nav button), user popup, View Player, async trades, gift mailbox, social badges, `ClientSocialState`.
- [`docs/architecture/auth.md`](docs/architecture/auth.md) — magic-link auth flow, WS session-cookie auth, `_dt` device fingerprinting, account deactivation/appeals.
- [`docs/architecture/client.md`](docs/architecture/client.md) — multi-screen DOM shell, `GameClient` subscriber pattern, three.js world map + DOM overlay split, RoomView, ChatPopout, bottom nav structure, CharItems merged tab, persistent XP bar, image-everywhere convention, ModalStack, browser tab resume, hex coordinates, A* pathfinding, visual style, UI state persistence.
- [`docs/architecture/admin-dashboard.md`](docs/architecture/admin-dashboard.md) — World Manager layout, density tokens, modal forms, per-tab notes.
- [`docs/architecture/persistence.md`](docs/architecture/persistence.md) — `PlayerSaveData` schema, `GameStateStore`/`JsonFileStore`, swappable-store data folder convention.

For game design background see `ideas/skill-trees.md`, `ideas/encounters.md`, `ideas/equipment_update_v1.md`, `ideas/backlog-2026-april.md`, `ideas/ui-overhaul-may-2026.md`.

## Maintenance Rules

These rules are load-bearing — follow them every time, not just when convenient.

### Updating docs

When you change architecture, file structure, or game design, update the affected `docs/architecture/*.md` file and `README.md`. If a change makes a top-level rule in this file wrong (e.g. new persistence step), update this file too. README's roadmap uses `[x]`/`[ ]` checklists — check items off as completed.

### State persistence

When adding or changing any per-player game state (new systems, new fields on `PlayerSession`, `ServerParty`, etc.), update the save/restore logic:
1. Update `PlayerSaveData` in `GameStateStore.ts` with the new field(s).
2. Update `PlayerSession.toSaveData()` to serialize the new state.
3. Update `PlayerSession.fromSaveData()` to restore the new state.
4. If the state lives in a sub-system (like `UnlockSystem`), ensure that system supports restoration from saved data.

### Patch notes

Every PR that ships a user-visible change adds (or appends to) **one entry** in the `PATCH_NOTES` array at the top of `client/src/screens/PatchNotes.ts` — don't fragment a single PR's bullets across multiple version entries. Version format: `YYYY.MM.DD.N` where `N` is the release number for that day (starting at 1); if today's `.N` already exists from an earlier PR, bump to `.N+1`. Each entry has a `version` string and a `notes: string[]`.

**Bullets must be player-facing and non-technical** — describe what changed from a player's perspective, not the implementation. Replace jargon like "static-layer bake", "world units", "self-substitution" with phrases like "map performance improvements", or omit entirely if there's nothing useful to say to a player. Technical detail belongs in the PR description and `docs/architecture/`, not in patch notes.

Also bump `GAME_VERSION` in `shared/src/systems/BattleTypes.ts` to match. The server's version-change detector (`GameLoop.init`) then auto-broadcasts the update in server chat on next boot, so no manual broadcast wiring is needed.

### Data folder convention

Everything in `data/` must be persisted behind a swappable store interface — never read/write files directly from game logic. Add new persistent data by extending an existing store or defining a new interface. See `docs/architecture/persistence.md` for the full list of stores.

### Content versioning

When adding a new content type to the game, include it in `ContentSnapshot` (`server/src/game/VersionStore.ts`) and in `ContentStore.toSnapshot()` / `replaceAll()` so it ships in draft/publish/deploy snapshots.

### UI terminology

In all user-facing text (UI labels, error messages, combat log), refer to hex tiles as **"rooms"**. Code internals (variable names, class names, comments) may still use "tile" — the rename is UI-only.

## Code Conventions

- **Indentation**: 2 spaces.
- **Semicolons**: always.
- **Naming**: PascalCase classes, camelCase methods/properties, UPPER_SNAKE_CASE constants.
- **Strict TS**: no implicit any, no unused locals/parameters, no fallthrough in switch.
- **Imports**: client/server import shared via `@idle-party-rpg/shared`; within-package imports use relative paths.
- **Class layout**: properties → constructor → public methods → private methods.
- **Error handling**: defensive checks with early returns.
- **Tests**: aim for coverage on all non-rendering logic (systems, utils, pathfinding, server).

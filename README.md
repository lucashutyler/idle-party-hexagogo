# Idle Party RPG

**Play now at [play.idlepartyrpg.com](https://play.idlepartyrpg.com)**

An idle multiplayer RPG on a hexagonal world map. Characters fight, move, and progress whether you're online or not. Party up with other players — every class is stronger together.

## Quick Start (Development)

**macOS / Linux:**
```bash
bash setup-dev.sh    # validates node 20+, npm, git — then installs + builds
npm run dev          # starts client (:3000) + server (:3001) with hot reload
```

**Windows (PowerShell):**
```powershell
.\setup-dev.ps1      # validates node 20+, npm, git — then installs + builds
npm run dev
```

**Manual alternative:**
```bash
npm install
npm run build        # build shared types first (required before first dev run)
npm run dev
```

In dev mode, email verification is instant — enter any email, click Verify, choose a username, and you're in.

## Production Setup

On an Ubuntu/Debian server with nginx and git already installed.

**Install Node.js 22 LTS** (system-wide via [NodeSource](https://github.com/nodesource/distributions) — do not use nvm on servers):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**Run the setup script:**

```bash
sudo bash setup-prod.sh
```

The script will:
1. Validate that node (22+), npm, nginx, and git are installed
2. Prompt for domain, session secret, AWS SES credentials, and other config
3. Clone the repo to `/opt/idle-party-rpg` and build
4. Install and start a systemd service (`idle-party-rpg`)
5. Configure nginx as a reverse proxy with WebSocket support

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3001) | No |
| `SESSION_SECRET` | Session encryption key | Yes |
| `APP_URL` | Public URL (e.g. `https://play.hexagogo.com`) | Yes |
| `AWS_ACCESS_KEY_ID` | AWS credentials for SES | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for SES | Yes |
| `AWS_REGION` | AWS region (default: us-east-1) | No |
| `SES_FROM_EMAIL` | Email sender address | Yes |

### After Setup

```bash
sudo systemctl status idle-party-rpg   # check service
journalctl -u idle-party-rpg -f        # follow logs
sudo certbot --nginx -d yourdomain.com # add HTTPS
```

## Auto-Deploy

Pushes to `main` automatically deploy via GitHub Actions. The workflow SSHs into the server, pulls the latest code, builds, and restarts the service.

**Required GitHub Secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `SSH_HOST` | Server IP or hostname |
| `SSH_USER` | `idlerpg` (created by setup script) |
| `SSH_KEY` | Private SSH key for `idlerpg` user |

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start client (:3000) + server (:3001) concurrently with hot reload |
| `npm run dev:client` | Client dev server only |
| `npm run dev:server` | Game server only (tsx watch) |
| `npm run build` | Build all packages: shared → client → server |
| `npm start` | Run production server (must `npm run build` first) |
| `npm run test` | Run all tests (vitest) |
| `npm run typecheck` | Type-check all packages (`tsc --build`) |

> **Note:** `npm run build` must be run at least once before `npm run dev` on a fresh clone.
> The shared package compiles to `shared/dist/` which the server needs at startup.
> After the first build, `npm run dev` handles everything with hot reload.

## Architecture

```
shared/           Pure logic, types, seed data — compiled first, used by client + server
client/           Vanilla TS web client — three.js world map, DOM UI, mobile-friendly, admin dashboard
server/           Node.js game server — persistent 24/7 game state, auth, WebSocket, ContentStore
data/             Runtime JSON content files (monsters, items, zones, world map — auto-seeded)
```

TypeScript throughout. Vite for client bundling. Express + ws for the server.

## Content Versioning

Admin content changes (monsters, items, zones, world map tiles) go through a **draft → publish → deploy** pipeline managed from the Versions tab in the World Manager admin panel. Edits are made freely against a draft version — nothing affects the live game until the admin explicitly publishes and deploys.

Publishing a draft creates an **immutable snapshot** of all content at that point in time. Published versions cannot be edited; to make further changes the admin creates a new draft. This gives a clear history of every content release and makes rollbacks straightforward.

**Deploying** a published version swaps it into the live game. The server hot-reloads the new content so players see updated zones, monsters, and map tiles without a restart. If a deployed version removes tiles that players are currently standing on, those players are automatically relocated to the nearest valid tile.

## Roadmap

### World Map
- [x] Hex grid with cube coordinates
- [x] A* pathfinding
- [x] Tile unlocking on victory (fog of war)
- [x] Camera zoom/pan
- [x] Data-driven content (ContentStore: monsters, items, zones, world in JSON files)
- [x] Server-driven map state (per-player fog of war, room names, tile discovery)
- [x] Multiple regions/zones with border transitions
- [x] Multi-map / interior maps (rooms link to a room on another map via a transition; one HexGrid per map; admin authoring) — overworld map-select still to come (#168)

### Combat
Real-time auto-battle with tick-based damage (1s per tick), HP tracked for both sides. Party combat is shared — all members fight the same monsters together on a 3x3 grid with position-based targeting. Combat ends when all monsters die (victory) or all players reach 0 HP (defeat). Encounters are zone-aware — each zone defines its own encounter table.
- [x] Auto-battle state machine (server-authoritative, always fighting)
- [x] Victory/defeat outcomes with brief result/celebration pause
- [x] Server-side combat resolution (clients receive updates)
- [x] HP-based combat (damage per tick, party/monster health pools)
- [x] Monster definitions (zone-aware encounter system)
- [x] Class-based combat (5 classes: Knight, Archer, Priest, Mage, Bard — weak solo, strong in party)
- [x] Difficulty scaling (zone-based encounters with per-zone difficulty)
- [x] Loot/rewards system (item drops, inventory, equipment with combat bonuses)

### Characters & Parties
- [x] Party entity with movement
- [x] Individual character creation (one per player, class selection on first login)
- [x] Character stats (HP + base damage scale linearly per class — no STR/INT/etc., no stat allocation on level-up)
- [x] XP and leveling system (`floor(18000 * L^1.2 * 1.06^L)` XP to next level)
- [x] Inventory tab (merged Char + Items — hero card, equipped gear, skill loadout, stat card, inventory grid)
- [x] Class system (5 classes: Knight, Archer, Priest, Mage, Bard — weak solo, strong together)
- [x] Damage types (physical/magical on monsters, Knight reduces physical, Priest reduces magical)
- [ ] Henchmen (hireable NPCs for solo players)
- [x] Party formation and management (always in a party, join, leave, kick, 3x3 grid, max 5 members)
- [x] Party roles (owner > leader > member, promote/demote, transfer ownership)
- [x] Party movement (owner/leader controls unified group movement)
- [x] Shared party combat (all members fight together, grid-based targeting)
- [x] Party combat rewards (XP, gold, loot per member on victory)

### Social
- [x] Social tab with fly-out submenu (Party / Guild / Leaderboard); Chat is a global pop-out from a dedicated Chat nav button
- [x] Online player list with search, sort, filter
- [x] Friends system (request-based two-way: send/accept/decline/revoke, auto-accept cross-requests)
- [x] Guild system (create at level 20+, join, leave, invite)
- [x] Chat system (unified timeline, 7 channels: Room/Zone/Party/Guild/Global/DM/Server, per-user persistent history, timestamps, clickable senders + channel tags, mobile-docked or desktop floating)
- [x] User blocking (DM-only or all messages)
- [x] Unread message indicators
- [x] Social badge notifications (bottom nav dot + sub-tab badges for friend requests, party invites, unread chat)
- [x] User popup menu (click username → Chat, Guild Invite, Friend, Party Invite, Trade, Gift, Block)
- [x] Class icons next to usernames everywhere
- [x] XP rate calculator (trip counter on Character tab)

### Towns & Economy
- [ ] Town interactions (shops, inns, etc.)
- [ ] Currency system
- [x] Item/equipment system (4 items, 4 equip slots, inventory with stacking)
- [x] Trading between players (asynchronous multi-item trades, no same-room requirement, persists across server restarts)
- [x] Item gifting (mailbox-based, accept/deny, declined gifts return to sender)

### Crafting
- [x] Crafting framework (per-player FIFO queue, materials reserved at queue time, offline progression, save/restore)
- [x] Recipe definitions in `data/recipes.json` (one starter recipe per class + one shared recipe + Mage potion)
- [x] Per-class crafting skill (Smithing/Fletching/Inscription/Alchemy/Tinkering) with XP per craft, no level cap
- [x] Admin Recipes tab (full CRUD without editing JSON)
- [x] Mage alchemy starter recipe + consumable item type (potions render as colored emoji, marked "not usable yet")
- [ ] Consumables framework (actually use potions)
- [ ] Class-specific multi-tier recipe trees

### Quests
- [x] Quest system framework (NPC-offered, accept/turn-in flow, server-tracked progress, save/restore)
- [x] Quest types (kill, collect, visit)
- [x] Quest rewards (XP, gold, item)
- [x] Quest scope (solo party only OR party-shared), prerequisites, weekly-repeatable
- [ ] Quest chains / storylines

### Dungeons
- [x] Dungeon data model + admin CRUD (floors, grid shape, encounter tables, entry requirements, rewards)
- [x] Dungeon instance runtime (one private instance per party, floor progression, exit/bail-out, eject-on-wipe, offline-persistent)
- [x] Entry requirements enforcement (level, required/consumable item, classes, party size — clear rejection messages)
- [x] Dungeon-specific loot (per-floor bonus rewards + one-time first-clear rewards per player)
- [ ] Non-3×3 grid shapes (arbitrary combat rectangles)
- [ ] Dungeon boss rooms, time limits, lockouts/cooldowns
- [ ] Dungeon tokens + rotating vendor, leaderboards, roguelike variant

### Server
- [x] Node.js/TypeScript server
- [x] Per-player game state (independent battle timers, movement, unlocks)
- [x] Email-based magic link authentication (dev auto-verify, prod via AWS SES)
- [x] Session cookies (express-session, 30-day expiry, httpOnly)
- [x] Account system (email + username, username changeable)
- [x] WebSocket auth via session cookie (no WS login messages)
- [x] Multiple connections per username (same login in multiple tabs stays in sync)
- [x] Server-side combat log (last 100 entries, streamed to all connections)
- [x] Persistent game state across server restarts
- [ ] Instanced worlds (soft-cap 1000 players)
- [x] Real-time client sync

### UI
- [x] Login screen with email input + username choice screen
- [x] Map tab with hex rendering (three.js WebGL canvas + HTML overlay, lazy-created on first Map visit)
- [x] Other players visible on map (per-tile flags within same zone, +N badge for other-room players on your tile)
- [x] Browser tab resume (instant state request, party snaps, camera pans smoothly)
- [x] Bottom navigation: Combat, Map, Char (merged Char+Items), Craft, Social (submenu), Settings, Chat (overlay)
- [x] Mobile-first responsive design
- [x] Pixel/retro RPG visual style (Silkscreen + Pixelify Sans)
- [x] Combat cards with portrait + name + HP bar; per-zone backgrounds; lunge/hit/dodge animations
- [x] Image-everywhere convention (`/<kind>-artwork/{id}.png` with placeholder fallback) for items, monsters, classes, tiles, sets, shops, zones, rooms
- [x] Nav bar battle status indicators (pulse/flash on combat events)
- [x] Server unavailable / offline screen with retry
- [x] Desktop font scaling (larger fonts on desktop via media query)
- [x] Mobile zoom controls (+/- buttons on map) + 2-finger pinch zoom
- [x] RoomView (replaces TileInfoModal) — three states: current room (full-screen with background art, shop/talk/dungeon affordances), remote discovered (small popup with Go button), undiscovered (minimal)
- [x] Dungeon entry popup + in-combat dungeon banner (floor progress + Leave Dungeon)
- [x] Global chat pop-out (floating/draggable/resizable on desktop, docked bottom-sheet on mobile)
- [x] Persistent XP bar above the bottom nav, visible on every screen
- [x] ModalStack click-order z-index across all overlays

### World Manager
- [x] Separate admin client (World Manager dashboard at /admin)
- [x] Content versioning (draft→publish→deploy pipeline with immutable snapshots)
- [x] Monster editor (with optional flavor description shown in combat popup)
- [x] Area/zone editor
- [x] Quest editor (Quests tab; NPCs tab links quests to NPCs)
- [x] Recipe editor (Recipes tab — author/edit crafting recipes without touching JSON)
- [x] CRM artwork upload pipeline (items / monsters / sets / shops / zones / tile types share one upload endpoint + UI)
- [x] Game designer access only

### Infrastructure
- [x] Monorepo structure (client/, server/)
- [x] Single `npm run dev` runs all subprojects
- [x] Test coverage
- [x] Shared types package between client/server
- [x] Auto-deploy via GitHub Actions (push to main → deploy)
- [x] systemd service with auto-restart
- [x] nginx reverse proxy with WebSocket support
- [x] Setup scripts (dev + prod)

# Idle Party RPG

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

On an Ubuntu server with Node.js 22+, nginx, and git already installed:

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
| `SSH_USER` | User with sudo access |
| `SSH_KEY` | Private SSH key for that user |

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
shared/           Pure logic, types, constants — compiled first, used by client + server
client/           Phaser 3 web client — tab-based UI, mobile-friendly
server/           Node.js game server — persistent 24/7 game state, auth, WebSocket
game-manager/     Admin tool for game designers — monsters, areas, quests (placeholder)
```

TypeScript throughout. Vite for client bundling. Express + ws for the server.

## Roadmap

### World Map
- [x] Hex grid with cube coordinates
- [x] A* pathfinding
- [x] Tile unlocking on victory (fog of war)
- [x] Camera zoom/pan
- [ ] Database-driven tile storage (managed via game manager)
- [ ] Server-driven map state
- [ ] Multiple regions/zones

### Combat
Goal: real-time auto-battle where damage is calculated per tick, HP tracked for both sides, and combat ends when either the party or the monsters reach 0 HP. Currently using a randomized timer (2-10s) with coin-flip outcomes as a temporary stand-in.
- [x] Auto-battle state machine (server-authoritative, always fighting)
- [x] Victory/defeat outcomes with brief result/celebration pause
- [x] Server-side combat resolution (clients receive updates)
- [ ] HP-based combat (damage per tick, party/monster health pools)
- [ ] Class-based combat (classes weak solo, strong in party)
- [ ] Monster definitions and balancing
- [ ] Loot/rewards system

### Characters & Parties
- [x] Party entity with movement
- [ ] Individual character creation (one per player)
- [ ] Class system (weak solo, strong together)
- [ ] Henchmen (hireable NPCs for solo players)
- [ ] Party formation and management
- [ ] Character progression/leveling

### Towns & Economy
- [ ] Town interactions (shops, inns, etc.)
- [ ] Currency system
- [ ] Item/equipment system
- [ ] Trading between players

### Quests
- [ ] Quest system framework
- [ ] Quest types (kill, fetch, explore, escort)
- [ ] Quest rewards
- [ ] Quest chains / storylines

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
- [x] Map tab with hex rendering
- [x] Other players visible on map (blue circles with username labels, tweened movement)
- [x] Browser tab resume (instant state request, party snaps, camera pans smoothly)
- [x] Tab-based bottom navigation (Combat, Map, Party, Items, Settings)
- [x] Mobile-first responsive design
- [x] Pixel/retro RPG visual style (Press Start 2P font)
- [x] Combat screen with battle stage, dynamic timer bar, and combat log
- [x] Lazy-loaded Phaser (Map tab only loads on first visit)
- [x] Nav bar battle status indicators (pulse/flash on combat events)
- [x] Server unavailable / offline screen with retry
- [ ] Desktop and phone feature parity

### Game Manager
- [ ] Separate admin client
- [ ] Monster editor
- [ ] Area/zone editor
- [ ] Quest editor
- [ ] Game designer access only

### Infrastructure
- [x] Monorepo structure (client/, server/, game-manager/)
- [x] Single `npm run dev` runs all subprojects
- [x] Test coverage
- [x] Shared types package between client/server
- [x] Auto-deploy via GitHub Actions (push to main → deploy)
- [x] systemd service with auto-restart
- [x] nginx reverse proxy with WebSocket support
- [x] Setup scripts (dev + prod)

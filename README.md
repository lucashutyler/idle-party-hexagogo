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

In dev mode, email verification is instant — enter any email, choose "Email me a sign-in link", pick a username, and you're in.

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
2. Prompt for instance name, domain, session secret, AWS SES credentials, and other config
3. Clone the repo to `/opt/idle-party-rpg` and build
4. Install and start a systemd service (`idle-party-rpg`)
5. Configure nginx as a reverse proxy with WebSocket support
6. Optionally issue a Let's Encrypt certificate with certbot — skip it if TLS
   terminates upstream (e.g. behind the Cloudflare proxy). Use `--certbot` /
   `--no-certbot` to answer that up front.

### Running Multiple Instances

Several independent games can share one server, each on its own domain. Pass
`--instance NAME` to install a sibling alongside the primary:

```bash
sudo bash setup-prod.sh --instance game2
```

Every instance gets its own install directory, `.env`, `data/` folder, systemd
unit, and nginx site — so players, accounts, and CMS content are fully separate:

| | Primary | `--instance game2` |
|---|---|---|
| Install dir | `/opt/idle-party-rpg` | `/opt/idle-party-rpg-game2` |
| Service | `idle-party-rpg` | `idle-party-rpg-game2` |
| nginx site | `ipr-site.conf` | `ipr-site-game2.conf` |
| Game data | `/opt/idle-party-rpg/data/` | `/opt/idle-party-rpg-game2/data/` |

The install directory name is the source of truth — `deploy/sync-nginx.sh` and the
deploy workflow both derive the service and nginx site names from it, so nothing
else needs configuring.

Each instance needs its own `PORT` (the script scans sibling installs, suggests
the next free one, and refuses a collision) and its own `APP_URL`, which drives
both magic-link redirects and the CORS origin. `SESSION_SECRET` should be distinct
per instance. The SES credentials can be shared. Note that magic-link emails are
branded "Idle Party RPG" regardless of instance — only the link URL differs.

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
| `ADMIN_EMAILS` | Comma-separated emails that are automatically **super admins** — the bootstrap set for the World Manager. Super admins grant `admin`/`superadmin` to everyone else from the dashboard. | Yes |
| `INVITE_ONLY` | `true` restricts sign-in to admins plus the admin-managed invite list | No |

### After Setup

```bash
sudo systemctl status idle-party-rpg   # check service
journalctl -u idle-party-rpg -f        # follow logs
```

For a named instance, append the instance name to the unit
(`systemctl status idle-party-rpg-game2`).

If you skipped certbot, point the domain at the server and terminate TLS upstream.
With Cloudflare: an A record for the domain with the proxy enabled, SSL/TLS mode
**Full**, and **WebSockets** enabled under Network (the game runs over a WS
connection). nginx serves plain HTTP on `:80` behind the proxy.

## Auto-Deploy

Pushes to `main` automatically deploy via GitHub Actions. The workflow SSHs into the server, then for **every** instance it finds under `/opt/idle-party-rpg*` it pulls the latest code, builds, syncs nginx, and restarts that instance's service. A new instance is picked up automatically — no workflow change needed. If one instance fails, the rest still deploy and the job reports the failure at the end.

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

**Deploying** a published version swaps it into the live game. The server hot-reloads the new content so players see updated zones, monsters, and rooms without a restart. If a deployed version removes rooms that players are currently standing in, those players are automatically relocated to the nearest valid room.

## Roadmap

### World Map
- [x] Hex grid with cube coordinates
- [x] A* pathfinding
- [x] Room unlocking on victory (fog of war)
- [x] Camera zoom/pan
- [x] Data-driven content (ContentStore: monsters, items, zones, world in JSON files)
- [x] Server-driven map state (per-player fog of war, room names, room discovery)
- [x] Multiple regions/zones with border transitions
- [x] Multi-map / interior maps (rooms link to a room on another map via a transition; one HexGrid per map; admin authoring) — overworld map-select still to come (#168)
- [x] Room entry requirements (gate a room or a map transition on an equipped item, a minimum level, and/or completed quests — every party member must qualify)
- [x] Room actions on explored rooms (map markers for NPCs, shops, dungeon entrances and travel points; hover tooltip lists them plus a player count; NPCs marked with a green `!` for a new quest or a gold `?` for one ready to hand in)
- [x] Room status panel for the current room (desktop card / mobile chips that talk, shop, enter or travel directly; a travel chip confirms first on phones)
- [x] Room sheet (tap a room for its name, actions, forecast and Go; tap it again to go)
- [x] Terrain, fog and art layers (procedural terrain from room-type colours, separate fog, room art loaded near the view)
- [x] Follow camera, route line and route chip with Stop, zone labels, zoom-based detail levels
- [x] Stop here — tap your own room mid-route to stop (or walk back if you've already left it)

### Combat
Real-time auto-battle on a timeline: every combatant acts on its own timer (about once a second), skills are cards with cooldowns and cast times in seconds, and the server streams the fight to clients as events plus periodic snapshots. Party combat is shared — all members fight the same monsters together on a 3x3 grid with position-based targeting. Combat ends when all monsters die (victory) or all players reach 0 HP (defeat). Encounters are zone-aware — each zone defines its own encounter table.
- [x] Auto-battle state machine (server-authoritative, always fighting)
- [x] Victory/defeat outcomes with brief result/celebration pause
- [x] Server-side combat resolution (clients receive updates)
- [x] HP-based combat (party/monster health pools)
- [x] Real-time timeline combat (per-unit action timers, status pulses, stuns in seconds, stalemate guard)
- [x] Skill cards — Attack / Support / Enchantment / Instant / Interrupt (+ Passive / Triggered), cooldowns and cast times in seconds, triggers (Intercept, Shield Slam, Cure, Mending react instantly)
- [x] Telegraphed enemy spellcasts that can be interrupted (stuns, Dispel, Drumroll); seed casters (goblin shaman, bandit cutthroat)
- [x] Monster definitions (zone-aware encounter system)
- [x] Class-based combat (5 classes: Knight, Archer, Priest, Mage, Bard — weak solo, strong in party)
- [x] Difficulty scaling (zone-based encounters with per-zone difficulty)
- [x] Loot/rewards system (item drops, inventory, equipment with combat bonuses)
- [x] Level-relative scaling (armour/resist ratings against the attacker's level, level-gap multiplier, every hit ≥ 1, ramp caps) — only for monsters with an authored level
- [x] Monster levels and tiers (trash / elite / boss / raid), boss enrage, level-difference XP, stat templates (`suggestMonsterStats`)
- [x] Win forecasts (Monte Carlo sims on the server, time-sliced; rooms, dungeons and live boss fights, with reasons)
- [x] Overworld auto-retreat (skip or leave rooms the forecast says you'll lose; off / 25 / 40 / 60 %, default 25 %)
- [x] Kill mastery + bestiary (per-monster ranks, up to +10 % against that monster)
- [x] "While you were away" recap (toast or story modal of what happened while the game was hidden)
- [x] Content lab (`tools/content-lab`): measures a content export on the old and new engines and reworks it to pacing targets
- [ ] Class-relative difficulty (level scaling does not equalise the classes — glass cannons fall off sooner above their level)

### Characters & Parties
- [x] Party entity with movement
- [x] Individual character creation (one per player, class selection on first login)
- [x] Character stats (HP + base damage scale linearly per class — no STR/INT/etc., no stat allocation on level-up)
- [x] XP and leveling system (`floor(18000 * L^1.2 * 1.06^L)` XP to next level)
- [x] Hero tab (Gear: equipped gear, inventory, mailbox and trades; Skills: skill loadout; Stats: stats, XP numbers, bestiary)
- [x] Class system (5 classes: Knight, Archer, Priest, Mage, Bard — weak solo, strong together)
- [x] Damage types (physical/magical/holy; Knight Guard rates against physical, Priest Bless against magical and holy)
- [x] Henchmen (hireable NPCs for solo players; they wait at a dungeon's entrance while the party runs it)
- [x] Party formation and management (always in a party, join, leave, kick, 3x3 grid, max 5 members)
- [x] Party roles (owner > leader > member, promote/demote, transfer ownership)
- [x] Party movement (owner/leader controls unified group movement)
- [x] Shared party combat (all members fight together, grid-based targeting)
- [x] Party combat rewards (XP, gold, loot per member on victory)

### Social
- [x] Social tab with segments (Party / Guild / Friends / Ranks); chat is docked in the shell, not part of Social
- [x] Ranks: all players with rank numbers, search, sort, filter
- [x] Friends system (request-based two-way: send/accept/decline/revoke, auto-accept cross-requests)
- [x] Guild system (create at level 20+, join, leave, invite)
- [x] Chat system (unified timeline, 7 channels: Room/Zone/Party/Guild/Global/DM/Server, per-user persistent history, timestamps, clickable senders + channel tags, All/Party/Guild/DMs tabs, channel filters, DM threads)
- [x] User blocking (hidden on the client)
- [x] Unread message indicators
- [x] Social badge notifications (nav dot + segment counts for friend requests and party invites; unread count on the chat strip and rail)
- [x] User popup menu (click username → Chat, Guild Invite, Friend, Party Invite, Trade, Gift, Block; a bottom sheet on phones)
- [x] Class icons next to usernames everywhere
- [x] XP rate calculator (trip counter on Hero › Stats)

### Notifications
- [x] Pluggable notification framework (category registry, per-user channel preferences, capped persisted inbox, save/restore)
- [x] Channel drivers: in-app (live toast + inbox), browser push (Web Push/VAPID), email (via SES)
- [x] Party notifications (invite received, kicked, promoted, demoted, ownership transferred, member joined/left)
- [x] DM notifications (suppressed while actively viewing that conversation)
- [x] Friend-request notifications (received + accepted)
- [x] Notification preferences UI (category × channel grid, per-channel kill switch, enable/disable all)
- [x] In-app notification bell (dropdown inbox, unread badge, live toasts)
- [x] PWA scaffolding (installable manifest, service worker, offline app-shell caching)
- [ ] Guild event notifications (blocked on the guild system existing)
- [ ] SMS / Discord channel drivers

### Towns & Economy
- [ ] Town interactions (shops, inns, etc.)
- [ ] Currency system
- [x] Item/equipment system (4 items, 4 equip slots, inventory with stacking)
- [x] Trading between players (asynchronous multi-item trades, no same-room requirement, persists across server restarts, per-trade confirm nonce)
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
- [x] Quest log (utility strip or rail: who has new quests for you, active quests with ready-to-turn-in first and where to turn them in, rows that take you to the room, progress bars; completed quests behind a toggle)
- [x] Quest discovery (green `!` on NPCs with a quest you can take, quest destinations outlined on the map, objectives name rooms instead of coordinates)
- [x] Quest popup feedback (Accept / Turn In show progress and the reason for any refusal)
- [ ] Quest chains / storylines

### Dungeons
- [x] Dungeon data model + admin CRUD (floors, grid shape, encounter tables, entry requirements, rewards)
- [x] Dungeon instance runtime (one private instance per party, floor progression, exit/bail-out, eject-on-wipe, offline-persistent)
- [x] Entry requirements enforcement (level, required/consumable item, classes, party size — clear rejection messages)
- [x] Entry preview (the Enter button is disabled with the reason shown when the party can't go in; refusals are always shown)
- [x] Dungeon-specific loot (per-floor bonus rewards + one-time first-clear rewards per player)
- [ ] Non-3×3 grid shapes (arbitrary combat rectangles)
- [x] Boss checkpoints (regroup at the last checkpoint up to a wipe budget, checkpoint rewards, resume after leaving for 7 days) + a seed boss (Goblin Chieftain) and a dev raid (The Sunken Throne)
- [ ] Dungeon time limits, lockouts/cooldowns
- [ ] Dungeon tokens + rotating vendor, leaderboards, roguelike variant

### Server
- [x] Node.js/TypeScript server
- [x] Per-player game state (independent battle timers, movement, unlocks)
- [x] Email-based magic link authentication (dev auto-verify, prod via AWS SES)
- [x] Session cookies (express-session, 30-day expiry, httpOnly)
- [x] Account system (email + username, username changeable)
- [x] WebSocket auth via session cookie (no WS login messages)
- [x] Multiple connections per username (same login in multiple tabs stays in sync)
- [x] Server-side combat journal (last 1000 entries saved, last 100 in each state push) + live combat stream (batched events/snapshots, only to sockets showing the combat view)
- [x] Persistent game state across server restarts
- [ ] Instanced worlds (soft-cap 1000 players)
- [x] Real-time client sync
- [x] Low mobile data use: state pushes leave out what a socket already holds, and WebSocket messages are compressed

### UI
- [x] Login screen with email input (sign-in link with resend) + username choice screen; class pick with a reply timeout
- [x] Map tab with hex rendering (three.js WebGL canvas + HTML overlay, loaded on first Map visit)
- [x] Other players visible on map (per-room flags within same zone, readable +N/×N counts that scale with zoom, party token)
- [x] Browser tab resume (instant state request, party snaps, camera re-centres while following)
- [x] Tab bar on phones: Map, Hero, a Battle disc inside the bar, Craft, Social; emoji icon fallbacks
- [x] Desktop rail with the same tabs plus Quests, Chat and Settings, and an icon rail on short landscape screens
- [x] Top HUD (class avatar + level for Settings, room and route status for Map, gold for Hero, notification bell)
- [x] Utility strip on phones (chat preview + Quests button)
- [x] Back steps through overlays, then chat, then Battle, before leaving the app; Escape closes the top overlay
- [x] Mobile-first responsive design
- [x] Modern mobile-game visual style (Lilita One + Nunito, glossy panels, chunky buttons, design tokens)
- [x] Real-time combat screen (action rings, cast bars with telegraphs, status pips, floating numbers, reaction cards, skill bar with cooldown sweeps, live log ticker, between-fights status chip, art that fills small boards; adapts to portrait/landscape; honours reduced motion)
- [x] Image-everywhere convention (`<mount>/{id}.png` with placeholder fallback) across all 17 asset kinds — items, monsters, classes, rooms, room types, sets, shops, zones, NPCs, henchmen, map parchment, combat/room backdrops, the splash logo, and the class/slot/nav icon sets — all declared once in a shared registry
- [x] Nav battle status indicators (ring while fighting, flash on victory/defeat)
- [x] Server unavailable / offline screen with retry
- [x] Desktop font scaling (token font scale, larger on desktop via media query)
- [x] Map controls (recentre and +/- buttons, 2-finger pinch zoom, keyboard pan and zoom)
- [x] RoomView — current room (background art, one button per room action, Stop here while travelling), or another explored room behind the room sheet's Details (the room's actions, Go button)
- [x] Dungeon entry popup + in-combat dungeon header (floor / BOSS badge + Leave); entry popup shows the run forecast, per-floor strip and resume point
- [x] Boss fight UI (pooled boss HP bar with checkpoint flags, retry pips, enrage timer; banner queue with a screen-reader live region; level badges and tier frames on cards)
- [x] Forecast chips (rooms, dungeons, live elite/boss fights) with verdict, likely range and reasons
- [x] Docked chat (strip preview and in-flow sheet with a full layout on phones, collapsible column on desktop)
- [x] Persistent XP hairline under the HUD, visible on every screen
- [x] ModalStack click-order z-index, Back and Escape order and keyboard focus across all overlays; every modal docks at the bottom on phones
- [x] Performance budgets (lazy map and patch notes, idle screens run no frame loop, hidden screens keep their layout)
- [x] Stable rendering — state pushes never swallow a click mid-press (`deferWhilePressed` / `setHtml`), and item art remembers what loaded so it never flickers
- [x] Shop usability (item names under squares, can't-use badge on gear your class can't equip, can't-afford prices, the inventory's equip comparison in the shop, sales confirmed by the server)
- [x] Hero and Craft usability (equip from an empty slot, item names under squares, Craftable filter, visible blocked reasons)
- [x] Confirm dialogs for lasting social actions (kick, transfer, leave, block, cancel trade)

### World Manager
- [x] Separate admin client (World Manager dashboard at /admin)
- [x] Content versioning (draft→publish→deploy pipeline with immutable snapshots)
- [x] Monster editor (with optional flavor description shown in combat popup; level, tier, enrage and a "Suggest stats" template button)
- [x] Area/zone editor
- [x] Quest editor (Quests tab; NPCs tab links quests to NPCs)
- [x] Recipe editor (Recipes tab — author/edit crafting recipes without touching JSON)
- [x] Skill tree editor (skills as versioned content — composable effect options, editable unlock levels, per-class slot schedules, item/set skill grants)
- [x] CRM artwork upload pipeline (15 of the 17 asset kinds share one upload API; items / monsters / zones / tile types / map parchment also have an in-modal uploader)
- [ ] Set and shop artwork management (deferred — set art has no render site, and shop art is fetched by zone id rather than shop id)
- [x] Asset coverage report (which content is still missing artwork, accounting for fallback chains, plus orphaned files)
- [x] Game designer access only

### AI-Assisted Content (MCP)
- [x] MCP server scaffold — read-only content tools over a bearer-token-authed endpoint (#297)
- [x] MCP write tools, draft-version-scoped only (#298)
- [x] Design notes — versioned markdown design context alongside AI-authored draft content
- [x] validate_draft — referential-integrity sweep before publish
- [x] Imagery tools — list asset kinds, upload/delete PNGs, and a coverage report showing which content is still missing art (artwork is live and unversioned, so these write directly rather than into a draft)

### Infrastructure
- [x] Monorepo structure (client/, server/)
- [x] Single `npm run dev` runs all subprojects
- [x] Test coverage
- [x] Shared types package between client/server
- [x] Auto-deploy via GitHub Actions (push to main → deploy)
- [x] systemd service with auto-restart
- [x] nginx reverse proxy with WebSocket support
- [x] Setup scripts (dev + prod)

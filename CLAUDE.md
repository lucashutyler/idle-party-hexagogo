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
│   │   ├── CharacterStats.ts  # Character types, XP/leveling, class definitions (HP/damage scaling)
│   │   ├── CombatEngine.ts    # Pure tick-based party combat resolution with skill system
│   │   ├── SkillTypes.ts      # Skill tree definitions, slot system, unlock/equip logic
│   │   ├── ItemTypes.ts       # Item types, seed data (SEED_ITEMS), inventory/equipment pure logic (parameterized)
│   │   ├── InventoryView.ts   # Read-only views over inventory + equipment (counts, sets, lists)
│   │   ├── MonsterTypes.ts    # Monster types, seed data (SEED_MONSTERS), encounter factory (parameterized)
│   │   ├── ZoneTypes.ts       # Zone types, seed data (SEED_ZONES), zone lookup (parameterized)
│   │   ├── UnlockSystem.ts    # Tile unlock tracking & progression
│   │   ├── SocialTypes.ts     # Social types: friends, guild, party, chat, blocking
│   │   ├── SetTypes.ts        # Set types, definitions, bonus computation
│   │   └── ShopTypes.ts       # Shop types and definitions
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
│   │   ├── CharacterScreen.ts # Character stats, XP bar, XP rate calculator, class passive info
│   │   ├── ItemsScreen.ts     # Equipment slots + inventory list with equip/unequip
│   │   ├── SocialScreen.ts    # Social tab — sub-tabs: Users, Guild, Party, Chat
│   │   ├── SettingsScreen.ts  # Settings screen with Patch Notes viewer (baked-in PATCH_NOTES array)
│   │   ├── SuspensionScreen.ts # "Account suspended" screen with appeal form
│   │   └── PlaceholderScreen.ts # Reusable "Coming soon" for future tabs
│   ├── admin/
│   │   ├── main.ts            # Admin entry point — imports admin-theme.css, creates AdminApp
│   │   ├── AdminApp.ts        # World Manager shell (top status bar, sidebar, routing, shared state)
│   │   ├── AdminContext.ts    # Shared-state interface tabs use to read/mutate
│   │   ├── api.ts             # fetchAdmin / putAdmin / deleteAdmin / postAdmin / escapeHtml / formatRelativeTime
│   │   ├── types.ts           # OverviewData, AccountData, ContentData, ContentVersion, TabId, TABS, UiSize
│   │   ├── components/
│   │   │   ├── Modal.ts       # openModal helper used by every form
│   │   │   └── UiSize.ts      # getUiSize/setUiSize/applyUiSize (S/M/L/XL via data-admin-size attr)
│   │   ├── tabs/              # One file per tab; each implements `Tab` interface (render, optional cleanup)
│   │   │   ├── Tab.ts
│   │   │   ├── OverviewTab.ts        # Stats + analytics placeholders (DAU, retention, etc.)
│   │   │   ├── AccountsTab.ts        # Filters/sort, default sort = Created desc, detail modal
│   │   │   ├── MonstersTab.ts        # Modal form (was inline panel)
│   │   │   ├── ItemsTab.ts           # Slot filter + modal form
│   │   │   ├── SetsTab.ts            # Modal form
│   │   │   ├── ShopsTab.ts           # Modal form
│   │   │   ├── ZonesTab.ts           # Modal form (was inline panel)
│   │   │   ├── EncountersTab.ts      # Modal form, random/explicit grid
│   │   │   ├── TileTypesTab.ts       # Card grid with hex previews; hex code hidden until edit
│   │   │   ├── MapTab.ts             # Canvas + sidebar with click-to-preview, Edit button reveals editor
│   │   │   ├── VersionsTab.ts        # Versions table (most actions also in top status bar)
│   │   │   └── XpTableTab.ts         # XP curve to Level 100 with k/m/b/t suffix formatting
│   │   └── styles/
│   │       └── admin-theme.css       # Utilitarian admin theme (light + dark via prefers-color-scheme)
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
│   │   ├── TileInfoModal.ts   # Modal for tile click — shows info, players, invite/chat buttons
│   │   └── ShopPopup.ts       # Shop buy/sell popup UI
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
│           ├── ChatSystem.ts    # Chat message creation, routing, block filtering
│           ├── TradeSystem.ts   # Async peer-to-peer item trading (propose/counter/confirm/cancel)
│           ├── TradeStore.ts    # Trade persistence (data/trades.json)
│           └── MailboxSystem.ts # Per-player gift mailbox (send/accept/deny)
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
├── sets.json                  # Set definitions (loaded by ContentStore, auto-seeded)
├── shops.json                 # Shop definitions (loaded by ContentStore, auto-seeded)
├── trades.json                # Active async trades (persisted via TradeStore)
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
- **WebSocket auth via session cookie**: WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie. Deactivated accounts are also rejected at WS upgrade.
- **Duplicate detection & device fingerprinting**: A persistent `_dt` cookie (UUID, 10-year expiry, httpOnly) is set on every request via middleware. It survives logout (only the session cookie is cleared). On every session creation (verify/login-status), a `SessionRecord` is captured: `{ deviceToken, ip, userAgent, timestamp }`. The last 10 records per account are stored in `accounts.json` via `AccountStore.addSessionRecord()`. The admin dashboard can view session history per account and detect shared device tokens across accounts via `GET /api/admin/duplicate-tokens`.
- **Account deactivation**: Admins can suspend accounts via `POST /api/admin/players/:username/deactivate`. Deactivation sets `account.deactivated = true`, kicks the player (closes all WS connections with code 4001), and blocks future logins. Deactivation is checked at: `POST /auth/login`, `GET /auth/verify`, `GET /auth/login-status`, `GET /auth/session`, and WS upgrade. Suspended users see a `SuspensionScreen` with a textarea to submit a reactivation appeal (`POST /auth/appeal`, no session required). Appeals are stored as `account.reactivationRequest`. Admins see appeal indicators and can reactivate via `POST /api/admin/players/:username/reactivate`.
- **Per-player game state**: Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.
- **GameClient subscriber pattern**: `subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).
- **Phaser isolation**: Phaser only runs when the Map tab is active. `game.loop.sleep()`/`wake()` halts/restarts the entire RAF loop. On re-activation, state is snapped (not tweened) so the player sees "where I am now" with no catch-up animation.
- **Browser tab resume**: On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).
- **Event-driven**: Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync
- **State machines**: `ServerBattleTimer` (`battle` | `result`), `ServerParty` (`idle` | `moving` | `in_battle`). Each party's battle loop runs continuously and never stops: `battle` → `result` (1s celebration/move window) → `battle` → … Movement happens instantly at the start of the result window; the client animates the tween during the celebration pause. Battle duration is determined by tick-based HP combat (1s per tick).
- **Class system**: 5 playable classes designed to be weak solo, strong together. `CharacterStats.ts` defines `ClassDefinition` with `baseHp`, `hpPerLevel`, `baseDamage`, `damagePerLevel`, and `damageType`. No stats (STR/INT/etc.) — HP and damage scale linearly per class. Classes: **Knight** (50 HP +5/lvl, 1 dmg, physical), **Archer** (8 HP +1/lvl, 15 dmg, physical), **Priest** (20 HP +2/lvl, 3 dmg, holy), **Mage** (8 HP +1/lvl, 15 dmg, magical), **Bard** (10 HP +1/lvl, 1 dmg, physical). A player's character does not exist until they select a class — `PlayerSession.character` is `null` until class selection. Before choosing a class, the player has a WebSocket session but is invisible to the game (no party, no combat, no chat, no social presence). Old saves with invalid/legacy classes get `character = null`, forcing class re-selection. Each class has a **skill tree** (`SkillTypes.ts`) with 11 skills (6 passives, 5 actives) unlocked sequentially. 5 equip slots: passive@Lv1, active@Lv5, passive@Lv10, passive@Lv30, passive@Lv50. Players choose 4/6 passives and 1/5 actives to equip. Skill points earned every 5 levels (`LEVELS_PER_SKILL_POINT = 5`); first passive is free. By level 50, all 11 skills are unlocked. Class selection screen shows baseHp, damage, damageType, and starting skill. Players cannot change their own class — only admins can change an existing player's class via `forceSetClass`.
- **Damage types**: `DamageType = 'physical' | 'magical' | 'holy'`. Monsters and player classes each have a damage type. Knight Guard passive reduces physical damage to the target only. Priest Bless passive reduces magical/holy damage party-wide. Equipment DR (`damageReductionMin/Max`) reduces physical damage only. Equipment MR (`magicReductionMin/Max`) reduces magical damage only. Holy damage is unaffected by both DR and MR — only the Priest Bless skill reduces it.
- **Class icons**: `CLASS_ICONS` and `UNKNOWN_CLASS_ICON` are exported from `shared/CharacterStats.ts`. Used everywhere a username is displayed: combat sprites, social screens, tile info modal, character screen. Knight=🛡️, Archer=🏹, Priest=☥, Mage=🪄, Bard=🎵, Unknown=❓.
- **Character & leveling**: Each player has a `CharacterState` (className, level, xp, gold, inventory, equipment, skillLoadout, skillPoints). XP is earned on victory. XP to next level = `floor(18000 * L^1.2 * 1.06^L)`. Max HP = `baseHp + (level-1) * hpPerLevel` via `calculateMaxHp(level, className)`. Base damage = `baseDamage + (level-1) * damagePerLevel` via `calculateBaseDamage(level, className)`. Skill points granted every 5 levels (at levels 5, 10, 15...).
- **XP rate calculator**: Client-side trip counter on the Character tab. Tracks cumulative XP earned since last reset, divides by elapsed time to show XP/hr. Formatted with suffixes (k/m/b/t, `?` for >= 1 quadrillion). Reset button clears the counter. Handles level-ups by computing total cumulative XP across all levels.
- **Combat engine**: Pure functions in `CombatEngine.ts`. Party: `createPartyCombatState()`/`processPartyTick()` — turn-based, one combatant acts per tick. Player damage = `baseDamage + variance(-2..+2) + equipBonus`, min 1, multiplied by Bard Rally if present, doubled on crit (Archer Pierce). Active skills trigger every Nth attack based on cooldown. Stun causes target to skip their next turn (doesn't stack, refreshes to 1). At combat start: Mage Burn adds `2 * level` to baseDamage, Rally multiplier precomputed (`0.20 * partySize` per equipped Bard). Monster damage reduced by equipment DR + Knight Guard (physical) or Priest Bless (magical/holy). `findTarget()` implements grid-based targeting on the 3x3 grid (positions 0-8): row = floor(pos/3), col = pos%3. Same row first; players prefer low-column monsters (front), monsters prefer high-column players (front); if no same-row target, scan up then down. Starting passives: Guard (physical DR), Rally (+20% all damage/member), Bless (magical DR party), Pierce (20% crit), Burn (+2 dmg/lvl). First actives: Bash (stun CD2), Dissonance (AoE dmg CD3), Minor Heal (CD1), Cut Down (lowest HP CD3), Magic Missile (4×30% CD3). Advanced mechanics include: DoTs (Bleed, Ignite), HoTs (Mending), damage shields (Sanctuary), stacking marks (Sunder +25% incoming/stack), conditional damage (Marksman, Brave, Exploit Weakness, War Cry), cooldown reduction (Bard **Tempo** = self only, Bard **Encore** = party-wide; controlled by `PassiveEffect.partyWide` flag in `getEffectiveCooldown`), party XP bonus (Inspiration), and many more. See `ideas/skill-trees.md` for the full design doc.
- **No-op fallback for actives**: When a player's queued active skill would do nothing (Priest Minor Heal at full party HP, Cure with no debuffs to remove, Sanctuary when target is already shielded, Bard Drumroll where RNG lands no stuns, etc.), `executeActiveSkill` returns `isNoOp: true` and `processPartyTick` falls through to a normal attack instead of wasting the turn. The `activeSkillCount` (Arcane Surge cadence) is rewound on no-op so it isn't burned.
- **DoT resistance rule**: All DoTs apply resistance at **tick time**, not at application time. The `damagePerTick` value stored on a `DotEffect` is the raw pre-resistance damage; the DoT processor in `processTickEffects` applies monster resistance (or player equip DR + Knight Guard / Priest Bless) every tick. This honors mid-fight resistance changes (debuffs, etc.) and keeps every DoT consistent — no DoT bakes resistance into its stored damage.
- **Mage Ignite (permanent stacking DoT)**: Unlike other DoTs, Ignite stacks last for the rest of combat. Each auto-attack adds a stack worth `25% of pre-MR damage` per tick (calculated from the `preMrDamage` captured at the top of `applyDamageToMonster`). Implemented via `DotEffect.permanent` (skip tick decrement). MR is still applied at tick time per the rule above — so against high-MR enemies, individual stacks tick for very little, but they accumulate over long fights.
- **Monster skill direct damage**: All direct-damage monster skills (Fireball AoE, Assassinate single-target, etc.) flow through `applyMonsterDirectDamage`, which honors the same defenses as a normal monster attack: damage-type reductions (equip DR + Knight Guard for physical, equip MR + Priest Bless for magical, Bless only for holy), damage shields, brace accumulation, Shield Bash retaliation, Martyr trigger, and resurrection. **Nimble dodge** applies to any direct-damage skill — for AoE, each player rolls dodge independently. **Intercept** redirects single-target skills the same way it redirects normal attacks. Stuns and DoT applications are not "direct damage" and bypass dodge.
- **Shield Slam / Shield Bash physical-only rule**: Knight Shield Slam (brace_reflect) only accumulates *physical* damage into `braceDamageTaken`; magical and holy hits don't contribute to the reflect. Knight Shield Bash (stun_on_phys_hit) only triggers from physical hits. This keeps Knight's reactive defenses paired with physical attackers and avoids reflecting magical fireballs as physical damage.
- **Martyr trigger rule**: Any damage to a Knight (direct attack, AoE skill, single-target skill, or DoT tick) queues a Priest Martyr heal-bonus stack via `triggerMartyr`. The bonus is **capped at a single stack between heals** — multiple damage events do not stack the bonus. Each Priest with Martyr equipped gets their own stack independently; the next heal that Priest casts consumes their stack.
- **Data-driven content (ContentStore)**: Game content (monsters, items, zones, world map) is stored in `data/*.json` files, loaded at startup by `ContentStore` (`server/src/game/ContentStore.ts`). If files are missing, ContentStore seeds them with defaults from `SEED_MONSTERS`, `SEED_ITEMS`, `SEED_ZONES`, and a hand-crafted world map. ContentStore follows the `GuildStore` pattern (in-memory Maps + atomic JSON persistence). Content is NOT exposed via a public API — instead, the server sends only what each player needs.
- **Parameterized shared functions**: Pure functions in shared that previously referenced module-level constants (`ITEMS`, `MONSTERS`, `ZONES`) now accept explicit data parameters. This allows the server to pass runtime-loaded content from ContentStore. E.g., `createEncounter(zoneId, monsters, zones)`, `equipItem(inv, equip, id, items)`, `computeEquipmentBonuses(equip, items)`, `getZone(zoneId, zones)`. The old constants are renamed to `SEED_*` and serve as seed data / test fixtures.
- **Zone system**: Each `HexTile` has a `zone` string property. `ZoneTypes.ts` defines `ZoneDefinition` with encounter tables (weighted monster selection). Current zones: `hatchetmill` (Lv1 goblins, starting village), `darkwood` (goblins, wolves, bandits), and `crystal_caves` (goblins, wolves, bandits). `createEncounter(zoneId, monsters, zones)` uses the zone's encounter table for weighted random monster/count selection. Zone display name is sent to the client in `ServerStateMessage.zoneName`.
- **Monster system**: `MonsterTypes.ts` defines `MonsterDefinition` type and `SEED_MONSTERS` catalog (goblin, wolf, bandit, stone_wall) with `drops?: ItemDrop[]` and `damageType: DamageType` per monster, and `createEncounter(zoneId, monsters, zones)` factory with zone-aware weighted encounters. Each `MonsterInstance` has a `gridPosition: PartyGridPosition` for combat grid placement and inherits `damageType` from its definition.
- **Wall (passive) monsters**: A `MonsterDefinition` with `passive: true` is a "wall" — a tactical obstacle. Walls (a) **never attack** (their turn is skipped in `processPartyTick`) and (b) **don't count toward victory** (the victory check ignores passive monsters, so killing all non-passive monsters wins). Walls are NOT auto-skipped by player targeting — players use normal grid targeting (front column first, same row first), so a wall at col 0 will be hit before a back-row monster. Players must work around walls via grid positioning, AoE skills (Mage Blizzard, Bard Dissonance, Archer Triple Shot), or Cut-Down/lowest-HP targeting. Seed example: `stone_wall` (100 HP, 0 damage, no XP/gold). Editable via the admin monster form's "Passive (wall)" checkbox.
- **Item & equipment system**: `ItemTypes.ts` defines items, rarities (`janky` 40%, `common` 25%), and equipment slots (`EquipSlot = 'head' | 'chest' | 'hand' | 'foot' | 'twohanded'`). Two-handed items use the `twohanded` equip slot (occupies the `hand` slot, prevents second hand item). Items have optional `classRestriction: string[]` (array of class names that can equip) and `value?: number` (gold value for shops). Items stack up to 99 in inventory. Equipment modifies combat: `bonusAttackMin/Max` adds to player damage, `damageReductionMin/Max` reduces incoming physical damage, `magicReductionMin/Max` reduces incoming magical damage. Pure functions handle inventory/equipment operations (`addItemToInventory`, `equipItem`, `unequipItem`, `computeEquipmentBonuses`, `rollDrops`) — all accept explicit `items: Record<string, ItemDefinition>` parameter. Drops are rolled per-monster on victory. The `ItemsScreen` uses a square grid layout with artwork support, rarity-colored backgrounds, and animated borders for equipped items. Clicking an item opens a popup modal with full details and equip/unequip/drop actions. Item definitions come from `ServerStateMessage.itemDefinitions` (only items the player owns). Current seed items: Janky Helmet (head, 0-1 reduction), Rusty Dagger (hand, 1-3 attack), Leather Vest (chest, 1-2 reduction), Mangy Pelt (non-equippable material).
- **InventoryView**: Read-only helpers in `shared/src/systems/InventoryView.ts` for querying a character's items: `getEquippedCount`, `getUnequippedCount`, `getOwnedCount`, `hasItemEquipped`, `hasUnequipped`, `ownsItem`, `getEquippedItemIds`, `getOwnedItemIds`, `listUnequippedEntries`. Use these instead of iterating `inventory` / `equipment` directly. Key invariant: `equipItem` removes the equipped copy from `inventory` and stores it in `equipment`, so `inventory` ONLY counts unequipped copies. Subtracting an equipped count from `inventory[id]` (or filtering inventory by "is this ID equipped?") double-counts and was the source of multiple shipped bugs. Helpers that take only `equipment` work for any character — including a remote player's profile equipment in the `view_player` response.
- **Set system**: `SetTypes.ts` defines `SetDefinition` with a set of item IDs (`pieces: string[]`) and `SetBonuses` granted when all pieces are equipped. `SetBonuses` includes: `cooldownReduction` (flat reduction to active skill cooldowns), `damagePercent` (% bonus damage), `damageReductionFlat` (flat physical DR), `magicReductionFlat` (flat magical MR), `maxHpFlat` (bonus max HP), `maxHpPercent` (% bonus max HP). All percentage bonuses stack additively with other sources. Set activates only when every piece in `pieces` is equipped. Combat integration: set HP/damage/DR/MR/cooldown bonuses are included in `computeEquipmentBonuses()` and applied during combat resolution. Set definitions stored in `data/sets.json`, managed by `ContentStore`.
- **Shop system**: `ShopTypes.ts` defines `ShopDefinition` with `id`, `name`, and `inventory: ShopItem[]` (item ID + stock + price). Shops are linked to tiles via `shopId?: string` on `WorldTileDefinition`. Shop definitions stored in `data/shops.json`, managed by `ContentStore`. The client shows a shop button in the room info popup when the current tile has a shop. `ShopPopup` (`client/src/ui/ShopPopup.ts`) provides buy/sell UI — buy mode shows shop inventory with prices, sell mode shows unequipped inventory items only with quantity controls (-/+/All) and sell prices.
- **World map & room names**: The world map is defined in `data/world.json` as an array of `WorldTileDefinition` objects, each with `id` (GUID), `col`, `row`, `type` (TileType), `zone` (zone ID), and `name` (room name, required). Each tile has a stable GUID (`id`) that persists across admin saves but changes when a tile is deleted and re-created. Every tile has an evocative room name (e.g., "Town Square", "Blacksmith", "Thick Trees"). The server loads this via `ContentStore` and builds the `HexGrid` at startup. The client receives ALL tiles via `GET /api/world` (auth'd) on login; fog of war rendering is determined client-side from `state.unlocked`.
- **Fog of war (unlock-based)**: Fog of war is driven entirely by the existing `unlockedKeys` from `UnlockSystem` — no separate discovery tracking. Unlock keys are tile GUIDs (not cube coordinates), so renaming/moving tiles in the admin panel invalidates old unlock state. The server sends all tiles to the client; the client determines visibility from `state.unlocked` (sent every tick). Three-tier rendering: **unlocked tiles** (full brightness, real icons, room name visible on click), **zone-unlocked tiles** (zone has at least one unlocked tile — dimmed, real tile type icons shown, room name hidden), **foggy tiles** (zone not yet unlocked — very dim, cloud icons). **Non-traversable tiles** (mountains, water, hedges, volcanoes) always render in a fixed dimmed style with their terrain icon — they are unaffected by fog of war or unlock state. Zone names are always visible on all tiles. Players can click and attempt to travel to any visible tile regardless of fog state. Zone unlock is computed client-side by `WorldCache.updateUnlocked()` from the unlock keys.
- **Item-gated tiles**: Some traversable tile types require a specific equipped item for entry. `TileConfig.requiredItemId` specifies the item ID (e.g., Desert requires `waterskin` relic, Lava Field requires `magma_boots` foot slot). When a party tries to move and the path crosses a gated tile, ALL party members must have the required item equipped — otherwise the move is rejected with a `move_blocked` WS message listing the item name and missing players. Once movement starts, required items are **locked**: they cannot be unequipped while the party is on the gated tile or has gated tiles in their remaining path. The lock covers both current tile and all tiles in the movement queue. Trades and destroy cannot affect equipped items, so the unequip lock is sufficient.
- **Tile types**: Data-driven content type stored in `data/tile-types.json`, managed by ContentStore, editable via admin dashboard. `TileTypeDefinition` has `id`, `name`, `icon`, `color` (hex string), `traversable`, and optional `requiredItemId` (default item required for all tiles of this type). Seed types: Plains, Forest, Mountain (non-trav), Water (non-trav), Town, Dungeon, Void (non-trav), Desert, Lava Field, Beach, Hedge (non-trav), Volcano (non-trav). Per-tile `requiredItemId` on `WorldTileDefinition` overrides the type-level default. Admin can create, edit, and delete tile types (delete blocked if tiles reference the type). Client receives tile type definitions via `GET /api/world` response and uses them for data-driven map rendering (icons, colors, traversability).
- **WorldCache (client)**: `WorldCache` (`client/src/network/WorldCache.ts`) is the client-side cache for world data. Loaded once from `GET /api/world` on login (in parallel with WS connect). Stores all tiles, start position, and computes unlock state from `state.unlocked` tile GUIDs each tick. `updateUnlocked(tileIds)` maps GUIDs→offset coordinates via a reverse index, tracks which tiles and zones are unlocked, and returns whether the set changed (triggering re-render). The `WorldMapScene` builds its `HexGrid` from WorldCache data.
- **Server-side combat log**: `PlayerSession` maintains the last 100 log entries (battle start/end, damage, level-ups, movement, tile unlocks) with a running `battleCount`. Both are included in every `ServerStateMessage`. The client `CombatScreen` is a pure renderer of the server-provided log — no client-side state-transition tracking.
- **Other players on map**: Each state message includes `otherPlayers: { username, col, row, zone, className? }[]`. WorldMapScene renders same-zone players as individual markers; other-zone players show as count badges on their tile. Positions update on each player's own battle cycle.
- **Room info modal**: Clicking a tile on the map opens a modal showing room name, type, players present, and a "Go to room" button. `TileInfoModal` class handles the DOM overlay. (UI calls tiles "rooms"; code still uses "tile" internally.)
- **Zoom controls**: Mobile-friendly +/- zoom buttons on the map screen, wired to `WorldMapScene.adjustZoom()`.
- **Floating HP bars**: CombatScreen renders HP bars floating above each combat sprite (players and enemies) arranged in grid formation rows (3 rows based on `gridPosition`). Player labels show username (current player highlighted in gold); monster labels show name only. HP shown as percentage bar only. Dead combatants are dimmed.
- **Desktop font scaling**: `@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop.
- **World Manager (admin dashboard)**: Separate client page at `/admin` (dev: `/admin.html`) for viewing server data and game content. Admin auth uses `ADMIN_EMAILS` env var (comma-separated emails). Server-side middleware checks session email against the list (401 if unauthenticated, 403 if not admin). API endpoints at `/api/admin/*` return runtime data (overview stats, accounts with online status) and full unfiltered game content (`GET /api/admin/content` returns all monsters, items, zones, and world data). The map viewer uses HTML5 Canvas with pan/zoom, rendering tiles from the content API. Room names are shown on all tiles (admin sees everything, no fog of war). Built as a separate Vite entry point (`admin.html`) isolated from the game client and styled with its own utilitarian theme (`styles/admin-theme.css`) — does NOT share `pixel-theme.css` with the game. **Modular layout**: shell + per-tab modules under `client/src/admin/tabs/`, all sharing state via the `AdminContext` interface. The shell renders a sticky **status bar** (always visible at the top with a version selector + Publish/Deploy/+New Draft buttons), a left **sidebar** (collapsible to a hamburger menu under 900px wide; each item also shows a **UI Size selector** S/M/L/XL persisted to localStorage as `data-admin-size` on `<html>`), and the active tab's content. **All edit forms are popup modals** (Monsters, Items, Sets, Shops, Zones, Encounters, Tile Types) opened via `components/Modal.ts`. **Overview tab** has analytics placeholders (DAU, retention, level distribution, class mix) — coming soon. **Accounts tab** defaults to sort-by-Created desc, has filters (hide no-character accounts, active-in-last-N-days, created-in-last-N-days) with live filtered count. Clicking a username opens a detail modal with session history, duplicate device token detection (highlighted), deactivate/reactivate buttons, and reactivation request viewer. **Tile Types tab** shows real hex-shaped tile previews; the hex color code is hidden until you focus the color picker. **Map tab** sidebar shows a read-only room preview on click; an Edit button reveals editable fields and focuses the room name. **Game** link in the sidebar opens the game in a new tab. Built as a separate Vite entry point (`admin.html`) isolated from the game client.
- **Social system**: Full social tab (6th tab) with 4 sub-tabs:
  - **Users**: All registered players (not just online) with search, sort (name/status), filter (all/room/zone/friends/guild). Online/offline status dots with group headers when sorted by status. Incoming friend requests shown as a section at the top. Click any username to open a **user popup menu** with contextual actions: Chat (DM), Guild invite, Friend request, Party invite, Block. Class icons shown next to all usernames. Data sourced from `ClientSocialState.allPlayers` (array of `PlayerListEntry` objects with `username` and optional `className`).
  - **Guild**: Create guild (level 20+, 2-20 char name), leave guild. Guild invites are sent via the user popup menu. Guild data persisted in `data/guilds.json`. Leader auto-transfers on leave.
  - **Party**: Every player is always in a party (solo party auto-created, max 5 members). Three-tier role hierarchy: owner > leader > member. Party creator is owner. Owner can promote/demote leaders, transfer ownership, and kick anyone. Leaders can promote members to leader, kick (including other leaders, but not owner), and move the party. Members cannot invite, kick, or move. Pending invite flow: owner/leader invites → target sees pending invite with accept/decline → same-room validated on both invite and accept. Invites auto-expire when either the inviter or invitee moves to a different room (via `PartySystem.cancelInvitesInvolving`, hooked into the `onMembersMoved` callback in `PartyBattleManager`). Badge indicator on Party tab when invites pending. 3x3 grid positioning for combat formation. Combat is shared — all members fight the same monsters together with grid-based targeting. Movement is party-level (owner/leader moves all members). On victory, each member gets XP/gold/loot independently. Leaving/kicked auto-creates new solo party at current position (captured before the old party entry can be torn down). If owner leaves, first leader becomes owner; if no leaders, first member becomes owner. Party events (join, kick, promotion, demotion, ownership change) post personalized chat announcements — the subject sees "You were ..." while others see "<name> was ..." — via `PlayerManager.broadcastPartyEvent` (party channel for in-party recipients, server channel for kicked players who are no longer in the party).
  - **Chat**: WoW-style unified timeline with all channels in one scrollable view, color-coded by channel type with timestamps (HH:MM). 6 channel types: Room (tile), Zone, Party, Guild, Global, DM. Toggle filter pills to show/hide each channel. Channel selector dropdown for sending (Party/Guild disabled when unavailable). DMs are initiated via the user popup menu (clicking a username) which auto-switches to Chat tab with DM pre-selected. Per-user chat history (1000 msgs, saved with player data) — messages persist with the player forever, not with the channel. Blocking (`dm` or `all` levels) filters messages server-side.
- **User popup menu**: A contextual popup shown when clicking any username across the app (Users tab, Guild/Party members, TileInfoModal players, chat sender names). Shows player level in the header. Actions: View Player, Chat (DM), Guild Invite / "In Guild", Add Friend / Accept / Decline / Revoke / "Friends", Party Invite / "In Party" / "Different Room", Trade (same room only), Block / Unblock. Dismissed on outside click or after action. Implemented as a positioned absolute div in `SocialScreen`.
- **View Player profile**: Clicking "View Player" in the popup sends a `view_player` WS request; server responds with `player_profile` containing the target's public "chosen state" — class, level, guild name, equipped items (with item definitions), equipped skills, and party members. No private stats (HP, damage, gold, inventory, XP) are exposed. The client renders a modal overlay (`player-profile-modal`) showing this data. `PlayerListEntry` includes `level` so the popup header can show it without an extra request.
- **Item trading (async)**: Player-to-player item trading via `TradeSystem` (`server/src/game/social/TradeSystem.ts`). Trade lifecycle: `pending` (one side has offered something, the other has not) → `countered` (both sides have offered) → `confirmed` (caller executes swap) / `cancelled`. Rules: any unequipped items can be offered (multi-item, with quantities); one active trade per player-pair (across the system), blocked users cannot trade. **Trades are asynchronous** — they persist across server restarts and survive movement, disconnect, zone changes. There is no same-tile requirement. Either player can update their offer (via `counterTrade`) at any time; either player can confirm — but only when the OTHER player took the most recent action (`lastUpdatedBy` tracks this). On stack-capacity failure, the trade is left in `countered` state so players can adjust. Trades persist via `TradeStore` (`data/trades.json`); `GameLoop.init` calls `tradeStore.load()` and `restoreFromSaveData`, and the periodic save serializes via `getAllTrades()`. Client trade UI is a modal overlay (item picker + side-by-side offers) opened from the user popup or from the "Proposed Trades" list on the Items screen. Badge appears on the bottom-nav Items tab when a trade is waiting on this player.
- **Gift mailbox (async)**: Players can send gifts to anyone (no same-tile requirement) via the user popup "Send Gift" action. Implementation lives in `MailboxSystem` (`server/src/game/social/MailboxSystem.ts`); each `MailboxEntry` holds a single `(itemId, quantity)` from a sender. Mailbox entries are NOT merged — sending multiple gifts of the same item produces multiple entries. This deliberately permits a player to "hold" more than `MAX_STACK` of an item by leaving copies in their mailbox; **accepting** is what's gated by the 99-stack inventory cap. On accept, the gift is added to the recipient's inventory (rejected with a warning if it would overflow); on deny, the gift is sent back to the original sender's mailbox marked as `returned: true` (re-denying a returned gift drops it instead of ping-ponging). Mailbox entries are persisted with each player's save data (`PlayerSaveData.mailbox`), kept in `MailboxSystem` at runtime, and exposed via `ClientSocialState.mailbox`. UI lives in the Items screen with a Mailbox section (Accept / Decline buttons per entry) and a Proposed Trades section.
- **Social badges**: Badge dot (red) on Social bottom-nav tab when there are pending friend requests, party invites, or unread chat. Red dot badges on sub-tabs: Users (incoming friend requests or trade requiring attention), Party (pending invites), and Chat (unread messages).
- **Social state**: `ClientSocialState` is included in every `ServerStateMessage.social`. Contains friends, incoming/outgoing friend requests, guild info, guild members, party info, pending party invites, outgoing party invites (sent by this player), online players list, all registered players list (as `PlayerListEntry[]` with className and level), blocked users, and chat preferences (send channel + DM target). `PlayerManager` builds this via `getSocialState()` callback on each `PlayerSession`.
- **Separation of concerns**: Phaser Graphics for rendering, HTML/CSS for all non-map UI (camera-independent), pure logic in shared systems
- **A* pathfinding**: Hex distance heuristic with cross-track tie-breaker
- **Visual style**: Pixel/retro RPG — Press Start 2P font, CSS custom properties for theming, CSS keyframe animations for battle states. All UI is vanilla HTML/CSS (no framework).
- **State persistence**: Player state is periodically saved (every 30s) and on graceful shutdown via `GameStateStore` interface. Current implementation uses JSON files on disk (`JsonFileStore`). On restore, battle timers start fresh (no retroactive simulation); a "Server back online" log entry is added. On shutdown, a "Server shutting down" log entry is added. Saved state per player: `username`, `battleCount`, `combatLog` (last 1000 entries), `unlockedKeys`, `position`, `target`, `movementQueue`, `character` (className, level, xp, inventory, equipment, skillLoadout, skillPoints), `friends`, `outgoingFriendRequests`, `blockedUsers`, `guildId`, `partyId`, `partyRole`, `partyGridPosition`, `chatHistory` (last 1000 messages), `chatSendChannel`, `chatDmTarget`, `mailbox` (pending gift entries). The `character` field is optional in `PlayerSaveData` — old saves or saves with invalid/legacy classes get `character = null` on load, forcing class re-selection. The `inventory` and `equipment` fields are optional within `character` — old saves default to empty inventory and all-null equipment. Social fields are optional — old saves default to empty. Party state (`partyId`, `partyRole`, `partyGridPosition`) is saved and restored — multi-player parties survive server restarts. Guild data is saved separately in `data/guilds.json`. Active async trades are saved separately in `data/trades.json` via `TradeStore`. Game content is saved separately in `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json` via `ContentStore`. The store interface is swappable for SQLite/Postgres.
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
- **Accounts**: `AccountStore` reads/writes `data/accounts.json` directly (should be interfaced when migrating to a DB). Each account stores: `email`, `username`, `verified`, `createdAt`, `lastActiveAt`, `deactivated?`, `reactivationRequest?`, `sessionHistory?` (last 10 `SessionRecord` entries with `deviceToken`, `ip`, `userAgent`, `timestamp`)
- **Guilds**: `GuildStore` reads/writes `data/guilds.json`
- **Game content**: `ContentStore` reads/writes `data/monsters.json`, `data/items.json`, `data/zones.json`, `data/world.json`, `data/sets.json`, `data/shops.json`, `data/tile-types.json`. Auto-seeds from `SEED_*` constants if files missing.
- **Chat**: Stored per-player in `PlayerSaveData.chatHistory` (saved with each player's JSON file)
- **Mailbox**: Stored per-player in `PlayerSaveData.mailbox` (gift entries persist with each player's JSON file). Live state lives in `MailboxSystem` at runtime; `PlayerSession.consumeInitialMailbox()` ferries the saved entries into `MailboxSystem` on load, and `PlayerSession.toSaveData` snapshots the live mailbox back via the `getMailbox` callback.
- **Trades**: `TradeStore` reads/writes `data/trades.json` (only active `pending`/`countered` trades). Restored at startup via `TradeSystem.restoreFromSaveData`.
- **Versions**: `VersionStore` reads/writes `data/versions/manifest.json` + `data/versions/{id}.json`

When adding new persistent data to `data/`, always define an interface or extend an existing one. Never read/write files directly from game logic — go through the store abstraction.

## Content Versioning

- **Content versioning**: Admin content edits go through a draft→publish→deploy pipeline. `VersionStore` manages version metadata (`data/versions/manifest.json`) and snapshots (`data/versions/{id}.json`). Each snapshot freezes all game content (monsters, items, zones, world, sets, shops). On deploy, `GameLoop.deployVersion()` replaces live content, rebuilds the hex grid, and relocates parties on unreachable tiles. When adding new content types to the game, they must be included in `ContentSnapshot` (`VersionStore.ts`) and `ContentStore.toSnapshot()`/`replaceAll()`.

## Patch Notes

Every time a new feature or fix is released, **update the `PATCH_NOTES` array** in `client/src/screens/SettingsScreen.ts`. Prepend new entries to the top of the array (newest first). Version format: `YYYY.MM.DD.N` where `N` is the release number for that day (starting at 1). If a day already has entries, increment `N`. Example: `2026.03.24.1` is the first release on March 24, `2026.03.24.2` is the second. Each entry has a `version` string and a `notes` string array of bullet points describing the changes.

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

# MCP Content Creation (design doc)

Covers issues [#297](https://github.com/lucashutyler/idle-party-hexagogo/issues/297) (MCP server scaffold) and [#298](https://github.com/lucashutyler/idle-party-hexagogo/issues/298) (MCP write tools, draft only), plus a new **design notes** system that makes AI-assisted content creation a first-class workflow rather than a raw CRUD firehose.

Status: **design review** — once implemented, this graduates into `docs/architecture/mcp.md`.

## The workflow we're building for

The target loop, using "starter island" as the running example:

1. **Brainstorm.** The admin tells their AI: "I want a small starter island — simple monsters, a few intro quests, one shop, players must finish a few quests before moving on." The AI reads the existing content catalog (read tools) to understand conventions: how monsters are statted at Lv1, what zone encounter tables look like, how quests chain via prerequisites, how item-gated tiles work.
2. **Refine together.** The AI proposes specifics — island layout, monster roster, quest chain, shop stock — and iterates with the admin *in conversation*, before touching the server.
3. **Persist the agreed context.** The agreed design is saved to the server as a **design note** attached to a draft version. Notes live inside the version snapshot, so they are versioned, diffable, and survive alongside the content they describe. A future session (or a different AI) can read the note and pick up exactly where things left off.
4. **Generate the draft.** The AI uses draft-scoped write tools to create the actual content — tiles, zone, monsters, encounters, items, NPCs, quests, shop — all inside the draft version. Live content is never touched. A `validate_draft` tool catches dangling references before a human ever looks at it.
5. **Human publishes.** The admin opens the World Manager, reviews the draft (content + its notes), publishes, and deploys. **Publish and deploy are deliberately not exposed over MCP.**

## What already exists (and what we reuse)

The draft pipeline is already built — this project is mostly a new *surface*, not new *machinery*:

- `VersionStore` manages draft → published versions; each snapshot (`ContentSnapshot`) freezes all content types.
- Every admin content route (`PUT/DELETE /api/admin/monsters/:id`, etc.) already supports `?versionId=` to edit a **draft snapshot** instead of live content, and rejects edits to non-draft versions.
- `POST /api/admin/versions` creates a draft from any existing version (or live content).
- Publish (`/versions/:id/publish`) and deploy (`/versions/:id/deploy`) are separate admin actions with their own safety logic (grid rebuild, party relocation, skill reconciliation).

What's genuinely new:

1. An MCP endpoint + token auth (no token auth exists today — admin is session-cookie + `ADMIN_EMAILS` only).
2. The design notes content type.
3. A `DraftEditor` service extracted from the admin routes' inline draft-editing logic, so MCP tools and admin routes share one implementation instead of duplicating it.
4. A cross-content referential-integrity validator (`validate_draft`).

## Architecture

### Transport: MCP endpoint hosted in the game server

The MCP server is **mounted inside the existing server process** at `/mcp`, using the official `@modelcontextprotocol/sdk` with the streamable HTTP transport (stateless mode), rather than a separate stdio package.

Why in-process rather than a standalone `idle-party-mcp` package that proxies the admin HTTP API:

- **No second deployment.** The admin already runs one server; the MCP endpoint rides along and is available wherever the server is reachable.
- **Direct store access.** Tool handlers call `ContentStore` / `VersionStore` / `DraftEditor` directly — same code path as admin routes, no HTTP self-proxying, no serialization drift.
- **Client support.** Claude Code, Claude Desktop, and other MCP clients connect to remote streamable-HTTP servers natively:
  ```bash
  claude mcp add --transport http idle-party https://your-server:3001/mcp \
    --header "Authorization: Bearer $IDLE_PARTY_MCP_TOKEN"
  ```
- A local stdio bridge (`mcp-remote`) remains available for clients that only speak stdio, at zero extra cost to us.

The code lives in `server/src/mcp/` (`McpEndpoint.ts`, `tools/`), mirroring the `admin/` folder layout. Issue #297's "MCP server project skeleton" deliverable is thus satisfied by a server subfolder, not a fourth workspace package — one less build target, and the tools need the stores anyway.

### Auth: bearer token, separate from session auth

- New env var `MCP_TOKENS` — comma-separated list of accepted bearer tokens, each optionally labeled: `MCP_TOKENS=lucas:abc123,claude-desktop:def456` (plain unlabeled tokens also accepted; label defaults to `mcp`). The label becomes the `author` on notes and any future audit log, and one token can be revoked without rotating everyone.
- `mcpAuthMiddleware` checks `Authorization: Bearer <token>` with a constant-time compare. No session cookies on `/mcp` — the MCP surface is token-only, and tokens grant **content-tool access only** (nothing player-facing, no account admin, no publish/deploy).
- If `MCP_TOKENS` is unset, `/mcp` returns 404 — the feature is opt-in per deployment.
- v1 keeps token management in env (restart to rotate). Per-admin token issuance UI in the dashboard is future work if needed. OAuth (needed for claude.ai custom connectors) is explicitly out of scope for v1; Claude Code / Desktop with header auth is the target client.

### Guardrails (the contract of the whole feature)

- **Writes require a draft `versionId`. Always.** There is no live-content write path over MCP, not even behind a flag. Attempting to write to a published/active version fails with a clear error (same rule the admin routes already enforce).
- **No publish, no deploy, no delete-version.** Going live is a human action in the World Manager.
- **No player/account tools.** Deactivation, invite list, master reset, class overrides — none of it is exposed.
- **No artwork upload** in v1 (binary handling over MCP is its own problem; revisit later).
- Every write runs the same validation as the admin routes (required fields, `validateSkillDefinition`, set class-conflict checks, referential deletion blocks), so the AI can't produce content the admin UI couldn't.

## Design notes system

### Data model

```ts
interface DesignNote {
  id: string;           // GUID
  title: string;
  body: string;         // markdown — the agreed design context
  tags?: string[];      // e.g. ['starter-island', 'quests']
  author: string;       // token label or admin email
  createdAt: string;    // ISO
  updatedAt: string;    // ISO
}
```

### Storage & versioning

Notes follow the standard content-type rules from CLAUDE.md:

- Live notes: `data/design-notes.json`, managed by `ContentStore` (in-memory Map + atomic JSON persistence, like every other type).
- Snapshotted: `designNotes?: DesignNote[]` added to `ContentSnapshot`, included in `ContentStore.toSnapshot()` / `replaceAll()` with **keep-when-absent** semantics (like tile types and skills) so pre-notes snapshots don't wipe live notes on deploy.
- Because notes ride in the snapshot, "create a draft, write the design note into it, then generate content into the same draft" gives exactly the versioning the workflow needs: the note and the content it produced are frozen together, travel through publish together, and the version history doubles as a design changelog.

Notes are **never sent to players** — they exist only in the admin API, snapshots, and MCP surface.

### Admin dashboard

v1: the Versions tab's draft detail view gets a read-only **Notes** panel (title + rendered markdown) so the human reviews the design context alongside the content diff before publishing. Full note editing in the dashboard can come later — the primary author is the AI via MCP.

## Tool catalog

Issue #297 sketches per-type tools (`list_monsters`, `list_items`, …). With 14+ content types that's 40+ tools of identical shape, which bloats every MCP client's context. Instead we consolidate on **generic tools with a `type` enum**, plus a schema/docs tool so the AI can self-serve authoring rules. (Deviation from the issue's literal deliverable list, same capability.)

`ContentType` enum: `monsters | items | sets | shops | recipes | npcs | quests | dungeons | zones | encounters | tileTypes | skills | designNotes` (world/tiles and skill-slots get dedicated tools; see below).

### Read tools (#297 — stage 1)

| Tool | Description |
|---|---|
| `list_content(type, versionId?)` | All entries of a type — live by default, or from any version's snapshot. Summary fields only (id, name, a few key stats) to keep responses small. |
| `get_content(type, id, versionId?)` | One full entry. |
| `get_world(versionId?, mapId?)` | Maps registry, start tile, and tiles (filterable by map). Tile lists are the biggest payload; `mapId` keeps it bounded. |
| `get_content_schema(type)` | Authoring documentation for a type: field-by-field description generated from the shared types, conventions (e.g. percent params are 0–1 fractions), and for skills the full `SKILL_OPTION_CATALOG`. This is what lets an AI write valid content without guessing. |
| `get_overview()` | Counts per type, active version, list of versions with status — the "orient yourself" call. |

### Version & notes tools (stage 2)

| Tool | Description |
|---|---|
| `list_versions()` | Version metadata (id, name, status, active, createdFrom, timestamps). |
| `create_draft(name, fromVersionId?)` | New draft snapshotted from a version (default: live content). Returns the draft id used by all write tools. |
| `save_note(versionId, note)` | Create/update a design note **in a draft**. This is workflow step 3. |
| `delete_note(versionId, noteId)` | Remove a note from a draft. |

(Notes are also readable via `list_content('designNotes', versionId)` / `get_content`.)

### Write tools (#298 — stage 3, draft-only)

| Tool | Description |
|---|---|
| `upsert_content(type, versionId, entry)` | Create or update one entry in a draft. Runs full validation; returns the stored entry. |
| `upsert_content_bulk(type, versionId, entries[])` | Bulk variant (mirrors the existing `/bulk` admin routes) — an island's 15 monsters in one call. |
| `delete_content(type, versionId, id)` | Delete from a draft; enforces the same referential blocks as admin routes (can't delete an NPC a tile references, a quest another quest requires, etc.). |
| `upsert_tiles(versionId, tiles[])` | Bulk world editing: create/update tiles by `(mapId, col, row)`; GUIDs auto-assigned for new tiles, preserved for existing ones. Supports all `WorldTileDefinition` fields (zone, type, name, shopId, npcId, dungeonId, transitions, encounterTable, requiredItemId). |
| `delete_tiles(versionId, tileIds[])` | Remove tiles from a draft map. |
| `create_map(versionId, name, startTile?)` / `delete_map(versionId, mapId)` | Multi-map support — a starter island is plausibly its own map with a transition to the mainland. |
| `set_start_tile(versionId, tileId)` | World start position. |
| `set_skill_slots(versionId, className, slots[])` | Per-class slot schedules (rarely needed, cheap to include). |
| `validate_draft(versionId)` | Full referential-integrity sweep; returns a structured list of problems (see below). The AI runs this after generating; the admin can also trust it as a pre-publish check. |

### `validate_draft` checks

Cross-content checks that no single-entry validation can catch, aimed exactly at AI-generated batches:

- Zone/tile encounter tables → `encounterId` exists; encounter `monsterPool` → `monsterId` exists.
- Monster drops, shop inventory, recipes, quest collect-objectives & item rewards → `itemId` exists.
- Tiles → `zone`, `type` (tile type), `shopId`, `npcId`, `dungeonId`, `requiredItemId` all resolve; transitions target existing `(mapId, tileId)`.
- NPC `questIds` exist; quest `prerequisiteQuestIds` exist and are acyclic; kill/visit objectives → monster/tile exists.
- Sets: `itemIds` exist, `findSetConflicts` passes; skills: `validateSkillDefinition` passes; granted skill ids (items, set breakpoints) exist.
- World: `startTile` exists and is traversable; every `mapId` on a tile is in the maps registry; each map's start tile exists.

### Implementation note: `DraftEditor`

The admin routes currently inline the load-snapshot → mutate array → save-snapshot dance per type (~40 near-identical blocks in `adminRoutes.ts`). Stage 3 extracts this into `server/src/game/DraftEditor.ts` (draft guard, per-type get/upsert/delete against a snapshot, shared validation hooks), and both `adminRoutes.ts` and the MCP tools call it. This is the main refactor of the project and the reason #298 was sized `large`.

## Delivery: one PR, three internal stages

Everything ships in **a single PR** covering #297 + #298 + the notes system. The stage labels in the tool catalog above describe implementation order within that PR, not separate deliverables:

1. **Scaffold + read-only (#297).** `server/src/mcp/` endpoint, `MCP_TOKENS` auth middleware, read tools (`get_overview`, `list_content`, `get_content`, `get_world`, `get_content_schema`, `list_versions`), README section on connecting Claude Code/Desktop.
2. **Design notes.** `DesignNote` type in shared, `ContentStore` + `ContentSnapshot` wiring, admin Versions-tab notes panel, MCP tools `create_draft`, `save_note`, `delete_note`.
3. **Write tools (#298).** `DraftEditor` extraction + admin route refactor onto it, `upsert_content`/`delete_content`/world tools, `validate_draft`.

This is all admin-only tooling: **no patch notes entry, no `GAME_VERSION` bump.** The PR updates `docs/architecture/` (`mcp.md` new; `content.md` + `persistence.md` for notes; `admin-dashboard.md` for the notes panel) and closes both issues.

## Resolved questions (decided 2026-07-17)

1. **Starter-island gating: item gates now, quest gates later.** v1 of the workflow uses the existing item-gated-tile mechanism (a quest-rewarded item gates the island exit). A generalized movement-restriction model (quest-completion / level / item gates on both room traversal and map transitions) is filed as [#357](https://github.com/lucashutyler/idle-party-hexagogo/issues/357) — no MCP work depends on it.
2. **Reads may target published snapshots.** Every read tool takes `versionId?`, defaulting to live. Edge case: a version can be deleted between a `list_versions` call and a follow-up read (snapshot file gone). Tools must detect the missing snapshot and return an explicit tool error ("version no longer exists — it may have been deleted; stop and check with the user") rather than an empty result, so the AI halts instead of proceeding on phantom data. Not worth locking/refcounting beyond that.
3. **Labeled tokens from day one.** `MCP_TOKENS=label:token,label2:token2` (see Auth section); the label attributes notes and future audit entries.
4. **OAuth deferred.** v1 targets Claude Code / Desktop via `Authorization` header. claude.ai custom connectors (which require OAuth) are future work, taken up only when actually wanted.

# MCP content-authoring server

An in-process [Model Context Protocol](https://modelcontextprotocol.io) endpoint that lets an AI assistant read the game's content catalog and author content inside a **draft** content version — never live. A human admin still has to publish and deploy the draft via the existing World Manager (`docs/architecture/admin-dashboard.md`); nothing here can do that. This is admin/content-authoring tooling — it never reaches players.

## Transport (`server/src/mcp/McpEndpoint.ts`)

Mounted at `POST /mcp` (`app.use('/mcp', createMcpRouter({ contentStore, versionStore }))` in `server/src/index.ts`). Stateless per the `@modelcontextprotocol/sdk` "stateless streamable HTTP" pattern: every request builds a fresh `McpServer`, a fresh `DraftEditor`, and a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, registers all four tool groups on that server instance, then hands the request off to the transport. `res.on('close', ...)` tears the transport and server back down. No session state is kept between requests — every tool call is fully self-contained (callers pass `versionId` on every write/read-from-draft call, there's no "current draft" concept server-side).

`GET`/`DELETE /mcp` both 405 — there's no server-initiated stream or session to resume/end in stateless mode.

## Auth (`server/src/mcp/mcpAuthMiddleware.ts`)

Bearer-token auth via the `MCP_TOKENS` env var: comma-separated entries, each either `label:token` or a plain `token` (defaults to label `"mcp"`). `parseMcpTokens()` mirrors `parseEmailListEnv`'s style (`server/src/auth/EmailListParser.ts`) — trim, split, filter empty.

- `MCP_TOKENS` unset or empty → **404** on every method, before the token is even inspected. The endpoint's existence is opt-in per deployment; an unconfigured server hides it entirely rather than exposing an auth wall.
- Token present but doesn't match any configured entry → **401**.
- Token matches → the resolved label is attached to `req.mcpTokenLabel` (ambient `Express.Request` augmentation in the same file) and used downstream as `DesignNote.author` — never accepted from tool input.

## `DraftEditor` (`server/src/game/DraftEditor.ts`)

The single place both admin routes (`server/src/admin/adminRoutes.ts`, every `?versionId=` branch) and every MCP write tool go through to mutate a draft's content snapshot — "load draft → guard it's actually a draft → validate → mutate → save" lives here once instead of being duplicated per surface. Live (non-draft) edits are untouched by this — those still go straight through `ContentStore` from `adminRoutes.ts`.

Per-type methods exist for all 13 content types (`upsertMonster`/`deleteMonster`, `upsertItem`/`deleteItem`, `upsertSet`/`deleteSet`, `upsertShop`/`deleteShop`, `upsertRecipe`/`deleteRecipe`, `upsertNpc`/`deleteNpc`, `upsertQuest`/`deleteQuest`, `upsertDungeon`/`deleteDungeon`, `upsertZone`/`deleteZone`, `upsertEncounter`/`deleteEncounter`, `upsertTileType`/`deleteTileType`, `upsertSkill`/`deleteSkill`, `upsertDesignNote`/`deleteDesignNote`), plus world-specific methods (`upsertTile`/`deleteTile`, `setStartTile`, `upsertMap`/`deleteMap`) and `setSkillSlotSchedule`. Each returns a discriminated `DraftResult<T>` — `{ success: true; snapshot; entries }` or `{ success: false; status: 404 | 400; error }` — so callers never need to catch a thrown error to detect "version not found" vs. "not a draft" vs. a referential-integrity rejection.

A generic dispatch surface keyed by `DraftContentType` (`'monsters' | 'items' | 'sets' | 'shops' | 'recipes' | 'npcs' | 'quests' | 'dungeons' | 'zones' | 'encounters' | 'tileTypes' | 'skills' | 'designNotes'`, derived from the exported `DRAFT_CONTENT_TYPES` array — the single source of truth both `readTools.ts` and `writeTools.ts` build their zod enums from) backs the MCP write tools: `getContentArray(type, snapshot)`, `upsertContent(type, versionId, entry)`, `upsertContentBulk(type, versionId, entries)`, `deleteContent(type, versionId, id)`. `toRecord<T extends { id: string }>(arr)` builds the `Record<id, entry>` shape admin routes respond with, using a null-prototype object so a caller-supplied id of `"__proto__"` becomes an ordinary own key instead of corrupting the record's prototype chain.

Every public method loads its draft snapshot once and persists once. Bulk operations — `upsertContentBulk`, `upsertTilesBulk`, `deleteTilesBulk` — load the snapshot ONCE, apply every entry to it in memory, and persist ONCE at the end, rather than looping a single-entry method (which would reload and re-save the entire snapshot from disk per entry). This makes bulk semantics **all-or-nothing**: if any entry in the batch fails validation, nothing in the batch is persisted — fix the bad entry and resubmit the whole batch (upserts are idempotent by id, so re-submitting already-valid entries is harmless). Each type's validation + array mutation lives in a small private `*Core` method (e.g. `upsertItemCore`) that operates on an already-loaded snapshot; the public `upsertX`/`deleteX` methods and the bulk methods both call it, so there's exactly one implementation of each type's rules regardless of which surface invokes it.

Referential-integrity guards mirror `ContentStore`'s live-delete guards (item referenced in a monster's drop table, NPC/shop/dungeon placed on a tile, quest offered by an NPC or required as another quest's prerequisite, skill granted by an item/set, etc.) — see the file for the exact list. **One real gap this refactor closed**: draft-scoped shop deletion previously had no referential guard while live shop deletion did; `DraftEditor.deleteShop` now checks for a referencing tile just like `ContentStore.deleteShop` does.

## Tool catalog

19 tools across four files, each registered via `server.registerTool(name, { description, inputSchema }, handler)`. Every tool's core logic is also exported as a plain async function (e.g. `getOverview(deps)`) so it's unit-testable without going through the MCP protocol layer — the registered handler is a thin wrapper that JSON-stringifies the result into `{ content: [{ type: 'text', text }] }`.

**Read** (`tools/readTools.ts`) — read-only, work against either live content or a draft snapshot (`versionId` optional on each):
- `get_overview` — content-catalog counts per type from live content, plus the version list and active version id.
- `list_versions` — every content version (draft + published) and the active version id.
- `list_content` — light `{id, label}` index of every entry of one `DraftContentType`.
- `get_content` — full definition of one entry by type + id.
- `get_world` — maps registry, default map id, start tile, and tiles (optionally filtered to one `mapId`).
- `get_content_schema` — field-shape cheat sheet for one content type (a hand-written description per type, verbatim field quirks); for `'skills'` it also returns the full `SKILL_OPTION_CATALOG`.

**Notes** (`tools/notesTools.ts`) — design-note authoring plus draft creation:
- `create_draft` — creates a new draft version, cloned from an existing version's snapshot (`fromVersionId`) or seeded from live content. Returns the `ContentVersion`; its `id` is the `versionId` every other write/notes call needs.
- `save_note` — create-or-update a `DesignNote` in a draft. Omit `note.id` to create; pass an existing id to update in place (`createdAt` preserved). `author` always comes from `deps.tokenLabel`, never from tool input.
- `delete_note` — delete a design note from a draft by id.

**Write** (`tools/writeTools.ts`) — draft-scoped only, thin wrappers over `DraftEditor`:
- `upsert_content` / `upsert_content_bulk` / `delete_content` — generic create/update/delete against the 13-type dispatch surface.
- `upsert_tiles` / `delete_tiles` — batched room upserts/deletes by `mapId`/`col`/`row` (`mapId` defaults to `DEFAULT_MAP_ID`), backed by `DraftEditor.upsertTilesBulk`/`deleteTilesBulk` — one load, one save, all-or-nothing on failure.
- `create_map` / `delete_map` — world map CRUD (delete fails on the default map or a map with rooms/inbound transitions, mirroring `DraftEditor.deleteMap`).
- `set_start_tile` — set a map's start room (`mapId` defaults to the draft's default map).
- `set_skill_slots` — set a class's full skill-slot unlock schedule.

**Validate** (`tools/validateTools.ts`):
- `validate_draft` — sweeps a draft snapshot for dangling cross-references and returns every problem found (no early return): zone/tile encounter-table references, tile zone/type/shop/npc/dungeon/requiredItemId/mapId/transition references, encounter monster-pool/placement references, monster drop references, shop inventory references, recipe ingredient/result references, quest objective/reward references, NPC questIds references, quest prerequisite references plus prerequisite-cycle detection (DFS, dedupes cycles found from multiple starting quests), set itemIds/grantedSkillIds references, item grantedSkillIds references, and both the world default start tile and every map's start tile resolving to an actual room. Meant to run before a human ever reviews the draft in the World Manager.

## Design notes

`DesignNote` (`shared/src/systems/DesignNoteTypes.ts`) is a small new content type: `{ id, title, body, tags?, author, createdAt, updatedAt }` — a markdown note recording the agreed-upon design context for a draft (e.g. "starter island: 3 goblins, 1 shop, quest chain X->Y->Z"). Notes ride inside a version snapshot alongside the content they describe and are **never sent to players**.

Storage mirrors the quest system's pattern: `ContentStore` holds a `designNotes` Map, persisted to `data/design-notes.json`, no seed (starts empty). `toSnapshot()`/`replaceAll()` include `designNotes`; `replaceAll` uses keep-when-absent semantics — an old snapshot that predates design notes (key absent) leaves the live notes untouched, while a snapshot with an explicit empty array genuinely clears them (same convention as `skills`/`skillSlotSchedules`/`tileTypes`). `ContentSnapshot.designNotes?: DesignNote[]` in `VersionStore.ts`.

The World Manager's **Versions tab** (`client/src/admin/tabs/VersionsTab.ts`) renders a read-only "Design Notes" panel below the version table when a version is selected — one card per note (title, author · date, body, tags), sourced from `ctx.versionContent.designNotes`. There's no create/edit/delete UI here; notes are authored exclusively through the `save_note`/`delete_note` MCP tools, by design — the panel exists so a human reviewing a draft can see the AI's stated reasoning before publishing.

See `docs/architecture/content.md` → "Design notes" for the content-system-level summary, and `docs/architecture/persistence.md` for its place in the data-folder convention.

## Guardrails

- Every write tool requires a draft `versionId` — `DraftEditor.loadDraft` rejects with `status: 404` if the version doesn't exist, or `status: 400` if it exists but isn't `status: 'draft'`. There is no way to write to live content through MCP.
- No `publish`, `deploy`, `delete_version`, or player/account-admin tools are exposed. Publishing and deploying stay a human action in the World Manager.
- No artwork upload tool in v1 — content authored via MCP ships without custom art until an admin uploads it manually afterward.

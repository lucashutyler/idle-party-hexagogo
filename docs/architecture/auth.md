# Authentication & sessions

## Email-based magic link auth

Auth is handled over REST (`/auth/*`), not WebSocket. Sessions use `express-session` with httpOnly cookies (30-day expiry), persisted to disk via `JsonSessionStore` (survives server restarts/deploys). Account data (email, username, verified status) is stored in `data/accounts.json` via `AccountStore`. Magic link tokens are in-memory with 15-minute expiry (`TokenStore`). Username is changeable later.

**Dev flow**: Enter email → token returned directly → auto-verified → session created on same browser → game.

**Prod flow (approve/poll)**: Enter email → magic link emailed → requesting browser polls `GET /auth/login-status?loginId=...` every 2s. User clicks magic link on any device → `POST /auth/approve` marks login approved (no session on approving device, shows "Sign in approved!"). Requesting browser's next poll detects approval → session created on that response → game. `ApproveScreen` handles the magic link landing; `LoginScreen` manages the polling/waiting UI.

## WebSocket auth via session cookie

WebSocket upgrade requests are authenticated by parsing the session cookie server-side. If no valid session/username, the upgrade is rejected with 401. No login messages are sent over WS — identity comes from the cookie. Deactivated accounts are also rejected at WS upgrade.

## Duplicate detection & device fingerprinting

A persistent `_dt` cookie (UUID, 10-year expiry, httpOnly) is set on every request via middleware. It survives logout (only the session cookie is cleared). On every session creation (verify/login-status), a `SessionRecord` is captured: `{ deviceToken, ip, userAgent, timestamp }`. The last 10 records per account are stored in `accounts.json` via `AccountStore.addSessionRecord()`. The admin dashboard can view session history per account and detect shared device tokens across accounts via `GET /api/admin/duplicate-tokens`.

## Invite-only beta gate

Setting `INVITE_ONLY=true` restricts `POST /auth/login` to an allow list: anyone with an admin role (see below) is always allowed, plus any email added to the admin-managed invite list. The check runs before `AccountStore.createAccount()`, so a rejected email never gets an account record created. Rejection returns `200 { error: '...' }` (no `inviteOnly` flag — mirrors the existing generic-error path in `LoginScreen`/`App.handleEmailLogin`, no dedicated screen needed since the rejection only ever happens pre-session). When `INVITE_ONLY` is unset or `false` (the default), login is unrestricted as before.

The invite list itself is persisted via `InviteListStore` (`server/src/auth/InviteListStore.ts`, `data/invite-list.json`) and managed from the admin dashboard's **Invite List** tab (only shown in the sidebar when `INVITE_ONLY=true` — see `docs/architecture/admin-dashboard.md`) via `GET/POST /api/admin/invite-list` and `DELETE /api/admin/invite-list/:email`. The gate calls `grantedAdminRole()`, so promoting someone in the dashboard also lets them sign in. It deliberately uses the *granted* role rather than the effective one, so a suspended admin falls through to the deactivated branch below and gets the appeal flow instead of a generic "invite-only" rejection.

## Admin roles

Two levels, defined in `server/src/auth/AdminRoles.ts`:

| Role | Can do |
|------|--------|
| `admin` | Every admin action — the whole World Manager, `/api/admin/*`, and the MCP content tools |
| `superadmin` | All of the above, **plus** granting and clearing other accounts' roles |

Where a role comes from:

- **`ADMIN_EMAILS`** (comma-separated env var) — every listed email is automatically a **super admin**, whether or not an account record exists yet. This is the bootstrap set: it can't be edited from the dashboard, so there is always a way back in. Parsed per request by the shared `parseEmailListEnv()` helper (`server/src/auth/EmailListParser.ts`), so editing the env var takes effect without a code change.
- **Granted in the dashboard** — a super admin sets any other account to Admin or Super Admin from the Accounts tab's detail modal (`PUT /api/admin/accounts/:email/role`). The grant is persisted as `Account.role` in `data/accounts.json`.

Two resolvers, and the distinction matters:

- `resolveAdminRole(email, accountStore)` — the role you may **act with right now**. Used by every *authorization* gate (`createAdminAuth`, and through it the MCP endpoint). A suspended account resolves to `null`, so deactivating an admin immediately strips their privileges (an `ADMIN_EMAILS` super admin is exempt).
- `grantedAdminRole(email, accountStore)` — the role **on record**, ignoring suspension. Used where suspension is handled separately or shouldn't apply: rendering the dashboard's role editor (so a suspended admin still displays as an admin, and reactivating restores it) and the invite-only login gate above.

Guards on `PUT /api/admin/accounts/:email/role`: super admin only, browser session only (never an API token), and it rejects both `ADMIN_EMAILS` accounts (`400` — change the env var instead) and changing your own role (`400`, so you can't accidentally lock yourself out).

## API tokens

Bearer credentials an admin generates for themselves, used by the MCP content-authoring server (`docs/architecture/mcp.md`) and by `/api/admin/*` for scripting. They replaced the old `MCP_TOKENS` env var entirely.

`ApiTokenStore` (`server/src/auth/ApiTokenStore.ts`, `data/api-tokens.json`) holds one record per token: `{ id, email, label, tokenHash, prefix, createdAt, expiresAt, lastUsedAt }`.

- The secret is `ipr_` + 32 random bytes as hex. It is **returned exactly once**, in the creation response, and stored only as a sha256 hash — `prefix` keeps the first 8 characters in the clear purely so a row is identifiable in the UI.
- **Scoped to the owner.** `GET`/`POST /api/admin/api-tokens` and `DELETE /api/admin/api-tokens/:id` always operate on the caller's own tokens; revoke is filtered by owner email, so another admin's token id resolves as `404` rather than deleting anything.
- **Session-only management.** All three routes sit behind `requireSession`, so a leaked token can't mint itself a longer-lived replacement or promote its owner.
- **Tokens carry no permissions.** Authorization is re-derived from the owner's role on every single request, so a token belonging to someone who was demoted or suspended is inert — there is deliberately no cleanup pass on role removal, and nothing to forget to run.
- Optional expiry (`YYYY-MM-DD` from the dashboard's date picker means "through the end of that day"; a full ISO timestamp also works). An unparseable `expiresAt` counts as expired, so a corrupt record fails closed.
- `lastUsedAt` is stamped in memory on each authenticated request and flushed to disk on a 60-second timer rather than writing the file per request. `startFlush()`/`stopFlush()` are wired in `server/src/index.ts` next to `TokenStore`; `stopFlush()` is awaited on shutdown and persists whatever the last tick missed.

## Unified admin auth

`createAdminAuth({ accountStore, apiTokenStore })` (`server/src/admin/adminMiddleware.ts`) resolves either credential into one `AdminPrincipal` — `{ email, role, via: 'session' | 'token', label, tokenId? }` — attached to `req.adminPrincipal`. A bearer token, when present, always wins over a session cookie. It exports four things:

- `requireAdmin` — applied router-wide to `/api/admin/*` and to the `/api-docs/admin` Swagger UI. 401 unauthenticated / invalid or expired token, 403 authenticated-but-not-an-admin.
- `requireSuperAdmin` — the extra check on role granting.
- `requireSession` — rejects API-token callers on token and role management.
- `resolvePrincipal` — the raw resolver, reused by the MCP endpoint so it can apply its own bearer-token-only rule first.

## Account deactivation

Admins can suspend accounts via `POST /api/admin/players/:username/deactivate`. Deactivation sets `account.deactivated = true`, kicks the player (closes all WS connections with code 4001), and blocks future logins. Deactivation is checked at: `POST /auth/login`, `GET /auth/verify`, `GET /auth/login-status`, `GET /auth/session`, and WS upgrade. Suspended users see a `SuspensionScreen` with a textarea to submit a reactivation appeal (`POST /auth/appeal`, no session required). Appeals are stored as `account.reactivationRequest`. Admins see appeal indicators and can reactivate via `POST /api/admin/players/:username/reactivate`.
